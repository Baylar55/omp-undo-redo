import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExpirationTombstone } from "../types.js";

/**
 * Prunes *.expired.json tombstones older than retentionDays*2.
 * Keeps recent expiry signal (default 4 days) while bounding history readdir cost.
 */
export async function pruneExpiredTombstones(
  historyDir: string,
  retentionDays: number,
  getActive: () => ReadonlySet<string>,
  isHashFn: (value: string) => boolean,
  isLive?: (sessionHash: string) => Promise<boolean>,
): Promise<void> {
  if (retentionDays <= 0) return;
  const tombstoneCutoff = Date.now() - retentionDays * 2 * 24 * 60 * 60 * 1000;
  let files: string[];
  try {
    files = await readdir(historyDir);
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".expired.json")) continue;
    const sessionHash = file.slice(0, -13);
    if (!isHashFn(sessionHash) || getActive().has(sessionHash)) continue;
    // Keep the expiry signal for sessions a foreign process still holds open:
    // pruning it would downgrade the resume-time message from "expired" to a
    // generic "could not be loaded".
    if (isLive && (await isLive(sessionHash))) continue;
    const path = join(historyDir, file);
    try {
      const content = await readFile(path, "utf8");
      const parsed = JSON.parse(content) as { expiredAt?: string };
      const ts = typeof parsed.expiredAt === "string" ? Date.parse(parsed.expiredAt) : NaN;
      const stale = Number.isNaN(ts)
        ? (await stat(path)
            .then((s) => s.mtimeMs)
            .catch(() => Date.now())) < tombstoneCutoff
        : ts < tombstoneCutoff;
      if (stale) await rm(path, { force: true }).catch(() => undefined);
    } catch {
      // Leave tombstone on parse/stat errors
    }
  }
}

export async function readTombstone(
  tombstoneFilePath: string,
  sessionHash: string,
): Promise<ExpirationTombstone | null> {
  try {
    const content = await readFile(tombstoneFilePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.expired === true &&
      candidate.sessionHash === sessionHash &&
      typeof candidate.expiredAt === "string" &&
      candidate.reason === "age"
    ) {
      return {
        expired: true,
        sessionHash,
        expiredAt: candidate.expiredAt,
        reason: "age",
      };
    }
    return null;
  } catch {
    return null;
  }
}
