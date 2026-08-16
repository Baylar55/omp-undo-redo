import { readFile, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, isHash } from "./fs.js";
import { readTreeManifest } from "./manifest.js";
import { readRefFile, type RefRegistry } from "./refs.js";
import type { StoreLiveness } from "./liveness.js";
import type { StoreAccountant } from "./accounting.js";
import type { TreeManifest } from "./types.js";

/** Garbage collection and retention policy: reference counting over refs/
 *  and manifests, age- and size-based session expiration, and stale-active-
 *  ref reaping. Must run under the store lock; the facade applies it. */

export class StoreJanitor {
  private readonly rootDirectory: string;
  private readonly refs: RefRegistry;
  private readonly liveness: StoreLiveness;
  private readonly accountant: StoreAccountant;
  private readonly invalidateAllCaches: () => void;

  constructor(options: {
    rootDirectory: string;
    refs: RefRegistry;
    liveness: StoreLiveness;
    accountant: StoreAccountant;
    invalidateAllCaches: () => void;
  }) {
    this.rootDirectory = options.rootDirectory;
    this.refs = options.refs;
    this.liveness = options.liveness;
    this.accountant = options.accountant;
    this.invalidateAllCaches = options.invalidateAllCaches;
  }

  private loadManifest(treeId: string): Promise<TreeManifest | null> {
    return readTreeManifest(this.rootDirectory, treeId);
  }

  /** Removes unreferenced trees and blobs (when `sweep`) and always reaps
   *  active refs whose owners are provably dead. Returns whether the sweep
   *  actually ran — false means it was deferred (a capture is in flight or
   *  nothing warranted the O(store) pass). */
  async collectUnlocked(sweep: boolean): Promise<boolean> {
    await this.refs.cleanupStaleActiveRefs((ownerId) =>
      this.liveness.ownerIsProvablyStale(ownerId),
    );
    // The refs scan, manifest loads and blob/tree walks are O(entire store).
    // Sweep only when session data was actually removed; stale-active-ref
    // cleanup above still covers crashed owners. Orphans left by a crash
    // mid-capture are reaped on the next real removal or by shutdown GC.
    if (!sweep) return false;
    // A capture in another process may be mid-walk, writing blobs that no ref
    // references yet. Sweeping now could orphan a ref the capture publishes
    // moments later, so defer the whole sweep; the next removal-triggered GC
    // reclaims the data. Marker creation is store-locked, so no capture can
    // slip into the window between this check and the end of the sweep.
    if (await this.liveness.captureInFlight()) return false;
    const referencedTrees = new Set<string>();
    const scanRefs = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const path = join(directory, child.name);
        if (child.isDirectory()) await scanRefs(path);
        else if (child.name.endsWith(".ref")) {
          const ref = await readRefFile(path);
          if (ref) referencedTrees.add(ref.treeId);
        }
      }
    };
    await scanRefs(join(this.rootDirectory, "refs"));
    const referencedBlobs = new Set<string>();
    for (const treeId of referencedTrees) {
      const manifest = await this.loadManifest(treeId);
      for (const entry of manifest?.entries ?? []) referencedBlobs.add(entry.blobHash);
    }
    try {
      for (const child of await readdir(join(this.rootDirectory, "trees"))) {
        if (!child.endsWith(".json")) continue;
        const treeId = child.slice(0, -5);
        if (!referencedTrees.has(treeId)) {
          const path = join(this.rootDirectory, "trees", child);
          await this.accountant.untrackStoreFile(path, treeId);
          await rm(path, { force: true });
        }
      }
    } catch {
      // Nothing to collect.
    }
    try {
      for (const prefix of await readdir(join(this.rootDirectory, "blobs"))) {
        const directory = join(this.rootDirectory, "blobs", prefix);
        for (const child of await readdir(directory)) {
          const hash = `${prefix}${child}`;
          if (!referencedBlobs.has(hash)) {
            const path = join(directory, child);
            await this.accountant.untrackStoreFile(path, hash);
            await rm(path, { force: true });
          }
        }
      }
    } catch {
      // Nothing to collect.
    }
    this.invalidateAllCaches();
    return true;
  }

  /** Expires history sessions by age, then evicts oldest-first while the
   *  store exceeds its byte cap, tombstoning each expired session. */
  async expireAndCollect(
    retentionDays: number,
    maxStoreBytes: number,
    activeSessionHashes: ReadonlySet<string> | (() => ReadonlySet<string>),
  ): Promise<void> {
    const historyDir = join(this.rootDirectory, "history");
    const getActive = () =>
      typeof activeSessionHashes === "function" ? activeSessionHashes() : activeSessionHashes;

    const getHistoryFiles = async (): Promise<string[]> => {
      try {
        const files = await readdir(historyDir);
        return files.filter(
          (f) => f.endsWith(".json") && !f.endsWith(".expired.json") && !f.startsWith("."),
        );
      } catch {
        return [];
      }
    };

    const parseSessionTimestamp = async (
      file: string,
    ): Promise<{ sessionHash: string; timestamp: number; filePath: string } | null> => {
      const sessionHash = file.slice(0, -5);
      if (!isHash(sessionHash)) return null;
      if (getActive().has(sessionHash)) return null;
      const filePath = join(historyDir, file);
      try {
        const content = await readFile(filePath, "utf8");
        const parsed = JSON.parse(content) as unknown;
        if (!parsed || typeof parsed !== "object") return null;
        const candidate = parsed as Record<string, unknown>;
        let timestamp: number;
        if (typeof candidate.lastAccessedAt === "string") {
          timestamp = Date.parse(candidate.lastAccessedAt);
          if (Number.isNaN(timestamp)) return null;
        } else {
          const st = await stat(filePath);
          timestamp = st.mtimeMs;
        }
        return { sessionHash, timestamp, filePath };
      } catch {
        return null;
      }
    };

    // Phase 1: Age-based expiration
    let removedSomething = false;
    if (retentionDays > 0) {
      const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
      const files = await getHistoryFiles();
      for (const file of files) {
        const item = await parseSessionTimestamp(file);
        if (!item) continue;
        if (item.timestamp <= cutoff) {
          if (getActive().has(item.sessionHash)) continue;
          const refsDeleted = await this.refs.releaseSession(item.sessionHash);
          if (!refsDeleted) continue;
          removedSomething = true;

          const tombstoneFile = join(historyDir, `${item.sessionHash}.expired.json`);
          const tombstoneData = {
            expired: true,
            sessionHash: item.sessionHash,
            expiredAt: new Date().toISOString(),
            reason: "age",
          };
          await atomicWrite(tombstoneFile, JSON.stringify(tombstoneData)).catch(() => undefined);
          await rm(item.filePath, { force: true }).catch(() => undefined);
        }
      }
    }

    // Phase 2: Storage cap eviction
    if (maxStoreBytes > 0) {
      let currentBytes = await this.accountant.measure();
      if (currentBytes > maxStoreBytes) {
        const files = await getHistoryFiles();
        const items: Array<{ sessionHash: string; timestamp: number; filePath: string }> = [];
        for (const file of files) {
          const item = await parseSessionTimestamp(file);
          if (item) items.push(item);
        }
        items.sort((a, b) => a.timestamp - b.timestamp);

        for (const item of items) {
          if (getActive().has(item.sessionHash)) continue;
          // After the first call above (which scans once), measureStoreBytes
          // is O(1), so the per-iteration check no longer rescans the store.
          if (currentBytes <= maxStoreBytes) break;

          const refsDeleted = await this.refs.releaseSession(item.sessionHash);
          if (!refsDeleted) continue;
          removedSomething = true;

          const tombstoneFile = join(historyDir, `${item.sessionHash}.expired.json`);
          const tombstoneData = {
            expired: true,
            sessionHash: item.sessionHash,
            expiredAt: new Date().toISOString(),
            reason: "storage_cap",
          };
          await atomicWrite(tombstoneFile, JSON.stringify(tombstoneData)).catch(() => undefined);
          await rm(item.filePath, { force: true }).catch(() => undefined);
          // If a concurrent capture deferred the sweep, eviction reclaimed no
          // bytes — continuing would destroy further sessions for nothing, so
          // stop and let the next removal-triggered GC finish the reclamation.
          if (!(await this.collectUnlocked(true))) break;
          currentBytes = await this.accountant.measure();
        }
      }
    }

    // Garbage collection after removals, and stale active-ref cleanup always.
    // The O(store) tree/blob sweep is skipped when nothing was removed.
    await this.collectUnlocked(removedSomething);
  }
}
