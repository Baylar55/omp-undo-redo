import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Removes orphaned %TEMP%/omp-undo-redo-index-* dirs older than 24h.
 *  Persistent alternates (SnapshotIndexLease) keep mtime fresh while in use;
 *  only abandoned crash orphans age >24h. */
export async function sweepOrphanTempIndexes(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(tmpdir());
  } catch {
    return;
  }
  const candidates = entries.filter(
    (e) => e.startsWith("omp-undo-redo-index-") || e.startsWith("omp-undo-redo-patch-"),
  );
  await Promise.all(
    candidates.map(async (name) => {
      const path = join(tmpdir(), name);
      try {
        const st = await stat(path);
        if (!st.isDirectory() || st.mtimeMs >= cutoff) return;
        await rm(path, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }),
  );
}
