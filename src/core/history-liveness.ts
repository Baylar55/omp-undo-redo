import { readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
 */
export const ACTIVE_HEARTBEAT_TTL_MS = 24 * 60 * 60 * 1000;

export function activeHeartbeatPath(historyDir: string, sessionHash: string): string {
  return join(historyDir, `.active.${sessionHash}`);
}

/** Best-effort liveness beat: refreshes the marker's mtime, creating it on
 *  first touch. Failures never block the caller; the remaining sweep guards
 *  (local active set, fail-closed ref deletion) still apply. */
export async function touchSessionHeartbeat(
  historyDir: string,
  sessionHash: string,
): Promise<void> {
  const path = activeHeartbeatPath(historyDir, sessionHash);
  const now = new Date();
  try {
    await utimes(path, now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
    try {
      await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
    } catch {
      // Advisory marker only.
    }
  }
}

export async function sessionHeartbeatIsFresh(
  historyDir: string,
  sessionHash: string,
  ttlMs: number = ACTIVE_HEARTBEAT_TTL_MS,
): Promise<boolean> {
  try {
    const metadata = await stat(activeHeartbeatPath(historyDir, sessionHash));
    return Date.now() - metadata.mtimeMs < ttlMs;
  } catch {
    return false;
  }
}

/** Removes markers whose owners stopped beating so the history directory
 *  does not accumulate one file per historical session forever. */
export async function pruneStaleHeartbeats(
  historyDir: string,
  ttlMs: number = ACTIVE_HEARTBEAT_TTL_MS,
): Promise<void> {
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
      if (Date.now() - metadata.mtimeMs >= ttlMs) {
        await rm(path, { force: true }).catch(() => undefined);
      }
    } catch {
      // Vanished between readdir and stat.
    }
  }
}
