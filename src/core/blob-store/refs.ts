import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWrite, exists, isHash, safeId } from "./fs.js";
import type { SnapshotPhase } from "./types.js";

/** The refs/ namespace: active and history refs bind (session, checkpoint,
 *  phase) triples to tree ids. Ref mutation must run under the store lock;
 *  the lock itself is applied by the BlobStore facade. */

export async function readRefFile(
  path: string,
): Promise<{ treeId: string; ownerId?: string } | null> {
  try {
    const content = (await readFile(path, "utf8")).trim();
    if (isHash(content)) return { treeId: content };
    const value = JSON.parse(content) as { treeId?: unknown; ownerId?: unknown };
    if (!isHash(value.treeId)) return null;
    return {
      treeId: value.treeId,
      ...(typeof value.ownerId === "string" ? { ownerId: value.ownerId } : {}),
    };
  } catch {
    return null;
  }
}

export class RefRegistry {
  private readonly rootDirectory: string;

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  private refPath(
    namespace: "active" | "history",
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): string {
    return join(this.rootDirectory, "refs", namespace, sessionHash, checkpointId, `${phase}.ref`);
  }

  /** Atomically writes (or overwrites) the active ref binding a capture to
   *  its tree; the on-disk ref schema lives here and in readRefFile only. */
  async createActiveRef(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
    treeId: string,
    ownerId: string,
  ): Promise<void> {
    await atomicWrite(
      this.refPath("active", sessionHash, checkpointId, phase),
      JSON.stringify({ treeId, ownerId }),
    );
  }

  async releaseCheckpointRefs(
    sessionHash: string,
    checkpointIds: readonly string[],
  ): Promise<boolean> {
    if (checkpointIds.length === 0) return true;
    if (!isHash(sessionHash)) return false;
    let result = true;
    for (const checkpointId of checkpointIds) {
      if (!safeId(checkpointId)) {
        result = false;
        continue;
      }
      for (const namespace of ["active", "history"] as const) {
        await rm(join(this.rootDirectory, "refs", namespace, sessionHash, checkpointId), {
          recursive: true,
          force: true,
        }).catch(() => {
          result = false;
        });
      }
    }
    return result;
  }

  async retainForResume(sessionHash: string, checkpointId: string): Promise<boolean> {
    if (!isHash(sessionHash) || !safeId(checkpointId)) return false;
    const activeDirectory = join(this.rootDirectory, "refs", "active", sessionHash, checkpointId);
    const historyDirectory = join(this.rootDirectory, "refs", "history", sessionHash, checkpointId);
    if (
      !(await exists(join(activeDirectory, "before.ref"))) ||
      !(await exists(join(activeDirectory, "after.ref")))
    )
      return false;
    await mkdir(dirname(historyDirectory), { recursive: true, mode: 0o700 });
    try {
      await rename(activeDirectory, historyDirectory);
      return true;
    } catch {
      return false;
    }
  }

  async hasActive(sessionHash: string, checkpointId: string): Promise<boolean> {
    return isHash(sessionHash) && safeId(checkpointId)
      ? exists(this.refPath("active", sessionHash, checkpointId, "before"))
      : false;
  }

  async hasHistory(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): Promise<boolean> {
    return exists(this.refPath("history", sessionHash, checkpointId, phase));
  }

  async matches(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
    treeId: string,
    namespace: "active" | "history" = "history",
  ): Promise<boolean> {
    if (!isHash(sessionHash) || !safeId(checkpointId) || !isHash(treeId)) return false;
    return (
      (await readRefFile(this.refPath(namespace, sessionHash, checkpointId, phase)))?.treeId ===
      treeId
    );
  }

  async releaseSession(sessionHash: string): Promise<boolean> {
    if (!isHash(sessionHash)) return false;
    let success = true;
    for (const namespace of ["history", "active"] as const) {
      await rm(join(this.rootDirectory, "refs", namespace, sessionHash), {
        recursive: true,
        force: true,
      }).catch(() => {
        success = false;
      });
    }
    return success;
  }

  /** Scans active refs for any still owned by `ownerId` (shutdown guard). */
  async ownerHasActiveRefs(ownerId: string): Promise<boolean> {
    const scan = async (directory: string): Promise<boolean> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return false;
      }
      for (const child of children) {
        const path = join(directory, child.name);
        if (child.isDirectory()) {
          if (await scan(path)) return true;
        } else if (child.name.endsWith(".ref")) {
          if ((await readRefFile(path))?.ownerId === ownerId) return true;
        }
      }
      return false;
    };
    return scan(join(this.rootDirectory, "refs", "active"));
  }

  /** Removes active-ref directories whose lease owner is provably dead; the
   *  liveness probe is injected so this module stays independent of the
   *  lease store. */
  async cleanupStaleActiveRefs(
    ownerIsProvablyStale: (ownerId: string) => Promise<boolean>,
  ): Promise<void> {
    const activeRoot = join(this.rootDirectory, "refs", "active");
    const scan = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const path = join(directory, child.name);
        if (child.isDirectory()) {
          await scan(path);
          continue;
        }
        if (!child.name.endsWith(".ref")) continue;
        const ref = await readRefFile(path);
        if (ref?.ownerId && (await ownerIsProvablyStale(ref.ownerId))) {
          await rm(dirname(path), { recursive: true, force: true });
        }
      }
    };
    await scan(activeRoot);
  }
}
