import { randomUUID } from "node:crypto";
import { stat, readdir, readFile, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { renameWithRetry } from "../infra/fs.js";
import { debugLog } from "../infra/debug-log.js";

export const RUNTIME_SCHEMA = 1;

export const RUNTIME_PROTOCOL = "omp-undo-redo/runtime";

export const STALE_RUNTIME_MS = 24 * 60 * 60 * 1_000;

/** A runtime directory is reapable only when both its marker timestamp and its
 *  own mtime are older than the stale window. An unreadable mtime counts as
 *  fresh: never delete on a failed stat. */
export async function isAncient(dir: string, startedAt: unknown): Promise<boolean> {
  const startedMs = typeof startedAt === "string" ? Date.parse(startedAt) : NaN;
  if (!Number.isNaN(startedMs) && Date.now() - startedMs < STALE_RUNTIME_MS) return false;
  try {
    return Date.now() - (await stat(dir)).mtimeMs >= STALE_RUNTIME_MS;
  } catch {
    return false;
  }
}

export type RuntimeMarker = {
  schemaVersion: typeof RUNTIME_SCHEMA;
  protocol: typeof RUNTIME_PROTOCOL;
  runtimeId: string;
  pid: number;
  hostname: string;
  /** `resolveRuntimeScope()` of the writer (boot, plus PID namespace on Linux),
   *  as owner leases record it; null when it could not be read. */
  runtimeScope: string | null;
  startedAt: string;
};

/** The marker's pid is a pid of this process table: same host and runtime
 *  scope. Otherwise (a container sharing the root, a previous boot, a marker
 *  from before the field, an unknown scope) probing it here means nothing. */
export function sharesProcessTable(
  marker: Partial<RuntimeMarker>,
  runtimeScope: string | null,
): boolean {
  return (
    runtimeScope !== null && marker.runtimeScope === runtimeScope && marker.hostname === hostname()
  );
}

export async function reapStaleRuntimes(
  rootDirectory: string,
  ownPid: number,
  runtimeScope: string | null,
): Promise<void> {
  const localHostname = hostname();
  let entries: Dirent[];
  try {
    entries = await readdir(rootDirectory, { withFileTypes: true });
  } catch {
    return;
  }
  // `<pid>.<uuid>.tmp`: a runtime directory a process was installing or
  // discarding when it died or failed. Its marker decides, as for `<pid>`.
  const candidates = entries.flatMap((e) => {
    const match = e.isDirectory() ? /^(\d+)(?:\.[^.]+\.tmp)?$/.exec(e.name) : null;
    return match ? [{ name: e.name, pid: Number(match[1]) }] : [];
  });
  // Batch with limited concurrency to avoid EMFILE on extreme leak (100+ dirs)
  const concurrency = 16;
  let index = 0;
  const worker = async (): Promise<void> => {
    while (index < candidates.length) {
      const entry = candidates[index++];
      if (entry.pid === ownPid) continue;
      const dir = join(rootDirectory, entry.name);
      let markerText: string;
      let marker: Partial<RuntimeMarker> | null;
      try {
        markerText = await readFile(join(dir, "runtime.json"), "utf8");
        marker = JSON.parse(markerText) as Partial<RuntimeMarker> | null;
      } catch {
        // Missing/unreadable marker: nothing proves this directory is ours.
        continue;
      }
      // A shared root may hold anyone's numerically named directory; only
      // one with our runtime marker is ever deleted.
      if (marker?.protocol !== RUNTIME_PROTOCOL) continue;
      // Cross-host guard: never delete another host's directory, however
      // dead its pid looks locally.
      if (typeof marker.hostname === "string" && marker.hostname !== localHostname) continue;
      let dead = false;
      // Another PID namespace's pid is unprobeable here: only age decides.
      if (typeof marker.pid === "number" && sharesProcessTable(marker, runtimeScope)) {
        try {
          process.kill(marker.pid, 0);
          // Alive and ours: never age it out. A live owner does not refresh
          // its directory, so after 24 h the age check would delete the
          // state it is still publishing. A recycled pid's directory is
          // reaped once that process exits (ESRCH) instead.
          continue;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          // ESRCH: gone. EPERM: alive but un-signallable, usually a recycled
          // pid under another user (in a shared root it may be that user's
          // live OMP); fall through to the age check. Any other code: leave
          // the directory alone.
          if (code === "ESRCH") dead = true;
          else if (code !== "EPERM") continue;
        }
      }
      // PID-recycling guard: an unprobeable pid (or a marker without one, or
      // another runtime scope's) only loses its directory once the marker and
      // the directory are both ancient.
      if (!dead && !(await isAncient(dir, marker.startedAt))) continue;
      // A recycled pid may have installed a fresh `runtime/<pid>` since the
      // marker was read. Claim atomically by renaming aside, then delete only
      // if the claimed directory still carries the marker judged above.
      const aside = join(rootDirectory, `${entry.pid}.${randomUUID()}.tmp`);
      try {
        await renameWithRetry(dir, aside);
      } catch {
        // Gone (its new owner or another sweep discarded it) or locked.
        continue;
      }
      const claimed = await readFile(join(aside, "runtime.json"), "utf8").catch(() => null);
      if (claimed !== markerText) {
        await renameWithRetry(aside, dir).catch((error: unknown) =>
          debugLog({ event: "runtime-dir-restore-failed", dir, aside, error: String(error) }),
        );
        continue;
      }
      await rm(aside, { recursive: true, force: true }).catch(() => undefined);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
  );
}
