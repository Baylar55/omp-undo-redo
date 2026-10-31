import { randomUUID } from "node:crypto";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../infra/fs.js";
import { localRuntimeScope } from "../store/host-identity.js";

/**
 * Cross-process liveness for session history retention.
 *
 * History files live in directories shared by every process resolving the
 * same repository commonDir, but each process's in-memory
 * active-session set only covers its own sessions. A retention sweep in
 * process A can therefore target a session that process B is actively
 * loading or saving. Every store touches a `.active.<sessionHash>` marker in
 * the history directory on each load and save; sweepers treat a fresh marker
 * as proof of life no matter which process wrote it and skip the session.
 *
 * The TTL is deliberately generous: a stale marker left by a crashed owner
 * merely delays expiration of already-old history, while a false negative
 * durably destroys live undo state. Markers whose owners stopped beating are
 * pruned by the same sweeps so the directory stays bounded.
 *
 * Mtime alone cannot tell a dead owner from a stopped one: a process
 * suspended (SIGSTOP, Ctrl+Z, laptop sleep) past the TTL stops beating while
 * still holding the session. The marker therefore names its writer
 * (`{pid, runtimeScope}`), and a stale marker whose writer shares this
 * process table (same runtime scope: boot, plus PID namespace on Linux) and
 * still answers a pid probe stays live. Only ESRCH proves an owner gone; a
 * recycled pid, or another host whose scope collides (Windows boot counter,
 * the boot-less fallback scope), only delays expiry. Hostname is not
 * compared: it can change while the owner sleeps. An empty, legacy or
 * other-scope marker (another container, another machine on a shared
 * repository) ages by mtime alone. Last writer wins: two processes holding
 * one session protect it through whichever beat last.
 */
const ACTIVE_HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PID = 2 ** 31 - 1;

type HeartbeatOwner = { pid: number; runtimeScope: string };

export function activeHeartbeatPath(historyDir: string, sessionHash: string): string {
  return join(historyDir, `.active.${sessionHash}`);
}

/** The marker's owner; null for no owner (missing, empty, legacy, malformed);
 *  "unreadable" when a read error other than ENOENT hides it (e.g. a scanner
 *  holding it on Windows): that marker may well name a live owner. */
async function readOwner(path: string): Promise<HeartbeatOwner | null | "unreadable"> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
  try {
    const o = JSON.parse(text) as Partial<HeartbeatOwner> | null;
    return o &&
      Number.isInteger(o.pid) &&
      (o.pid as number) > 0 &&
      (o.pid as number) <= MAX_PID &&
      typeof o.runtimeScope === "string"
      ? (o as HeartbeatOwner)
      : null;
  } catch {
    return null;
  }
}

/** The marker's writer is a process of this process table that may still
 *  exist. No owner or another scope is "not alive", leaving the mtime TTL as
 *  the only guard, as before owners existed; an unreadable marker or a probe
 *  error other than ESRCH (EPERM: another user's process) is "alive", which
 *  only delays expiry. ponytail: a marker that stays unreadable pins its
 *  session until it becomes readable; the history directory is 0700, so
 *  another user's sweeper never gets that far. */
async function ownerIsAlive(path: string): Promise<boolean> {
  const owner = await readOwner(path);
  if (owner === "unreadable") return true;
  if (!owner) return false;
  const scope = await localRuntimeScope();
  if (scope === null || owner.runtimeScope !== scope) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// One marker write at a time per path: a beat already in flight when the
// session is released must not land after the release and re-claim it.
const markerWrites = new Map<string, Promise<void>>();
function serialized(path: string, work: () => Promise<void>): Promise<void> {
  const next = (markerWrites.get(path) ?? Promise.resolve()).then(work);
  markerWrites.set(path, next);
  void next.finally(() => {
    if (markerWrites.get(path) === next) markerWrites.delete(path);
  });
  return next;
}

/** Best-effort liveness beat: rewrites the marker naming this process, which
 *  also refreshes its mtime, creating it on first touch. Atomic (temp +
 *  rename): a writer stopped mid-write never leaves an empty marker, and
 *  readers never see a partial one; the temp starts with `.active.`, so one
 *  leaked by a crash is pruned like a stale marker. Failures never block the
 *  caller; the remaining sweep guards (local active set, fail-closed ref
 *  deletion) still apply. */
export function touchSessionHeartbeat(historyDir: string, sessionHash: string): Promise<void> {
  const path = activeHeartbeatPath(historyDir, sessionHash);
  return serialized(path, async () => {
    const scope = await localRuntimeScope();
    const owner = scope === null ? "" : JSON.stringify({ pid: process.pid, runtimeScope: scope });
    try {
      await writeFileAtomic(path, `${path}.${randomUUID()}.tmp`, owner);
    } catch {
      // Unwritable (e.g. another user's directory): at least refresh the mtime.
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
    }
  });
}

/** A session this process left: drops its pid claim so the marker ages by
 *  mtime again (24 h from now, as from its last beat before). A plain
 *  truncation suffices, as empty is the end state. A marker naming another
 *  owner keeps its claim. Our own claim is removed if it cannot be emptied,
 *  so it survives only a marker that can be neither written nor removed. An
 *  unreadable marker is only emptied, never removed: it may hold another
 *  owner's claim, which then still has the fresh mtime until its next beat. */
export function releaseSessionHeartbeat(historyDir: string, sessionHash: string): Promise<void> {
  const path = activeHeartbeatPath(historyDir, sessionHash);
  return serialized(path, async () => {
    const owner = await readOwner(path);
    if (owner === null) return;
    const mine =
      owner !== "unreadable" &&
      owner.pid === process.pid &&
      owner.runtimeScope === (await localRuntimeScope());
    if (owner !== "unreadable" && !mine) return;
    const emptied = writeFile(path, "", "utf8");
    await (mine ? emptied.catch(() => rm(path, { force: true })) : emptied).catch(() => undefined);
  });
}

export async function sessionHeartbeatIsFresh(
  historyDir: string,
  sessionHash: string,
): Promise<boolean> {
  const path = activeHeartbeatPath(historyDir, sessionHash);
  try {
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs < ACTIVE_HEARTBEAT_TTL_MS) return true;
  } catch (error) {
    // Only a missing marker proves no owner; any other error may hide one.
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
  return ownerIsAlive(path);
}

/** Removes markers whose owners are gone (stale and not alive) so the history
 *  directory does not accumulate one file per historical session forever. */
export async function pruneStaleHeartbeats(historyDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(historyDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".active.")) continue;
    const path = join(historyDir, name);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile()) continue;
      if (Date.now() - metadata.mtimeMs >= ACTIVE_HEARTBEAT_TTL_MS && !(await ownerIsAlive(path))) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    } catch {
      // Vanished between readdir and stat.
    }
  }
}
