import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  atomicWrite,
  blobPathFor,
  canonicalPath,
  canonicalPathSync,
  exists,
  isHash,
  safeId,
  sha256,
  treePathFor,
} from "./fs.js";
import {
  canonicalManifest,
  manifestFileContent,
  readTreeManifest,
  sortCanonical,
} from "./manifest.js";
import { StoreLocks } from "./locks.js";
import { StoreLiveness } from "./liveness.js";
import { DEFAULT_WALK_CONCURRENCY, MAX_WALK_CONCURRENCY, WorkspaceWalker } from "./walk.js";
import { WorkspaceMutator } from "./mutator.js";
import { RefRegistry } from "./refs.js";
import { StoreAccountant } from "./accounting.js";
import { StoreJanitor } from "./gc.js";
import {
  DEFAULT_BLOB_IGNORES,
  type BlobApplyResult,
  type CachedWorkspaceFile,
  type SnapshotPhase,
  type TreeManifest,
  type WorkspaceCache,
} from "./types.js";

const MAX_CACHED_WORKSPACES = 16;
const MAX_CACHED_FILES_PER_WORKSPACE = 100_000;
const MAX_CACHED_FILES = 100_000;

export type { BlobApplyResult, SnapshotPhase, TreeEntry, TreeManifest } from "./types.js";
export { DEFAULT_BLOB_IGNORES } from "./types.js";

export function blobStoreRootDirectory(): string {
  if (process.env.OMP_UNDO_REDO_BLOB_DIR) {
    return canonicalPathSync(process.env.OMP_UNDO_REDO_BLOB_DIR);
  }
  if (process.env.OMP_UNDO_REDO_RUNTIME_DIR) {
    const runtime = resolve(process.env.OMP_UNDO_REDO_RUNTIME_DIR);
    const dir = basenameIsRuntime(runtime) ? dirname(runtime) : runtime;
    return canonicalPathSync(dir);
  }
  return canonicalPathSync(join(homedir(), ".omp", "omp-undo-redo"));
}

/** The literal "/runtime" catches env-var paths written with forward slashes
 *  on Windows, where `sep` is "\"; on POSIX it is redundant with the first. */
function basenameIsRuntime(value: string): boolean {
  return value.endsWith(`${sep}runtime`) || value.endsWith("/runtime");
}

/** Content-addressed snapshot store: capture a workspace as a tree manifest
 *  of blob hashes, apply manifests back onto the workspace with conflict
 *  detection and crash-safe rollback, and retire unreferenced data.
 *
 *  This class is the public facade and orchestrator; each internal concern
 *  lives in its own module and is wired up in the constructor:
 *  - `locks` — in-process and cross-process mutual exclusion
 *  - `liveness` — owner leases and capture markers
 *  - `walk` — workspace traversal and fingerprint caching
 *  - `mutator` — apply, rollback, and journal recovery
 *  - `refs` — active/history ref bookkeeping
 *  - `accounting` — incremental store-size estimation
 *  - `gc` — reference counting, expiration, sweeping */
export class BlobStore {
  readonly rootDirectory: string;
  private readonly clock: () => Date;
  private readonly ownerId = randomUUID();
  /** Capture caches for recently captured workspaces, owned solely by this
   *  facade: lookup, tree-existence validation, insert, and LRU eviction
   *  (see cacheWorkspace) all live here. */
  private readonly workspaceCaches = new Map<string, WorkspaceCache>();
  private readonly locks: StoreLocks;
  private readonly liveness: StoreLiveness;
  private readonly walker: WorkspaceWalker;
  private readonly mutator: WorkspaceMutator;
  private readonly refs: RefRegistry;
  private readonly accountant: StoreAccountant;
  private readonly janitor: StoreJanitor;

  constructor(
    rootDirectory: string,
    options: {
      maxFileBytes?: number;
      ignore?: readonly string[];
      clock?: () => Date;
      readWorkspaceFile?: (path: string) => Promise<Buffer>;
      walkConcurrency?: number;
    } = {},
  ) {
    this.rootDirectory = canonicalPathSync(rootDirectory);
    const clock = options.clock ?? (() => new Date());
    this.clock = clock;
    this.locks = new StoreLocks(this.rootDirectory, this.ownerId);
    this.liveness = new StoreLiveness(this.rootDirectory, this.ownerId, clock);
    this.accountant = new StoreAccountant(this.rootDirectory);
    this.walker = new WorkspaceWalker({
      storeRoot: this.rootDirectory,
      ignore: new Set(options.ignore ?? DEFAULT_BLOB_IGNORES),
      maxFileBytes: options.maxFileBytes ?? 16 * 1024 * 1024,
      readWorkspaceFile: options.readWorkspaceFile ?? readFile,
      walkConcurrency: Math.max(
        1,
        Math.min(options.walkConcurrency ?? DEFAULT_WALK_CONCURRENCY, MAX_WALK_CONCURRENCY),
      ),
      writeBlob: (hash, content) => this.writeBlob(hash, content),
    });
    this.refs = new RefRegistry(this.rootDirectory);
    this.mutator = new WorkspaceMutator({
      storeRoot: this.rootDirectory,
      clock,
      invalidateCache: (workspaceRoot) =>
        this.workspaceCaches.delete(canonicalPathSync(workspaceRoot)),
    });
    this.janitor = new StoreJanitor({
      rootDirectory: this.rootDirectory,
      refs: this.refs,
      liveness: this.liveness,
      accountant: this.accountant,
      invalidateAllCaches: () => this.workspaceCaches.clear(),
    });
    // Background stale lease sweep for crash-leaked leases — deferred so first capture still wins lock
    const leaseTimer = setTimeout(() => {
      void this.liveness.reapStaleLeases().catch(() => undefined);
    }, 2_000);
    leaseTimer.unref?.();
  }

  private blobPath(hash: string): string {
    return blobPathFor(this.rootDirectory, hash);
  }

  private treePath(treeId: string): string {
    return treePathFor(this.rootDirectory, treeId);
  }

  /** Inserts the freshly captured cache entry for a workspace, evicting
   *  least-recently-inserted workspaces at the hard caps. */
  private cacheWorkspace(
    workspaceRoot: string,
    treeId: string,
    files: Map<string, CachedWorkspaceFile>,
    captureTime: number,
  ): void {
    this.workspaceCaches.delete(workspaceRoot);
    if (files.size > MAX_CACHED_FILES_PER_WORKSPACE) return;

    this.workspaceCaches.set(workspaceRoot, { treeId, files, captureTime });
    let cachedFileCount = 0;
    for (const cache of this.workspaceCaches.values()) cachedFileCount += cache.files.size;
    while (
      this.workspaceCaches.size > MAX_CACHED_WORKSPACES ||
      cachedFileCount > MAX_CACHED_FILES
    ) {
      const oldest = this.workspaceCaches.entries().next().value;
      if (!oldest) return;
      const [oldestWorkspaceRoot, oldestCache] = oldest;
      this.workspaceCaches.delete(oldestWorkspaceRoot);
      cachedFileCount -= oldestCache.files.size;
    }
  }

  /** Writes a content-addressed blob if it does not already exist.
   *  Called during workspace walks, outside the store lock: content addressing
   *  makes the write idempotent (same content, same path), and GC defers its
   *  sweep while any capture marker is fresh, so an in-flight capture's blobs
   *  are never swept before its ref is published. The existence-skip is still
   *  load-bearing for size accounting — it must match measureStoreBytes'
   *  per-hash tracking or pending bytes would double-count. */
  private async writeBlob(hash: string, content: Buffer): Promise<void> {
    const path = this.blobPath(hash);
    if (await exists(path)) return;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      try {
        await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      } catch {
        if (await exists(path)) return;
        throw new Error("blob write failed");
      }
      try {
        await rename(temporary, path);
      } catch {
        if (!(await exists(path))) throw new Error("blob rename failed");
      }
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    this.accountant.trackStoreWrite(hash, content.length);
  }

  async captureSnapshot(
    workspaceRoot: string,
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): Promise<TreeManifest | { reason: "workspace_unresolvable" | "blob_capture_failed" }> {
    if (!isHash(sessionHash) || !safeId(checkpointId)) return { reason: "blob_capture_failed" };
    let canonicalRoot: string;
    try {
      canonicalRoot = await canonicalPath(workspaceRoot);
      if (!(await lstat(canonicalRoot)).isDirectory()) return { reason: "workspace_unresolvable" };
    } catch {
      return { reason: "workspace_unresolvable" };
    }
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const outcome = await this.captureOnce(canonicalRoot, sessionHash, checkpointId, phase);
        if (outcome !== "retry") return outcome;
      }
      return { reason: "blob_capture_failed" };
    } catch {
      return { reason: "blob_capture_failed" };
    }
  }

  /** One capture attempt. Runs the workspace walk under the per-workspace
   *  mutex — reads and content-addressed blob writes are safe outside the
   *  store lock — and only publishes the manifest and ref under the store
   *  lock, the critical section GC's sweep is atomic with. Returns "retry"
   *  when a concurrent GC removed the cached tree (and with it the blobs its
   *  cached fingerprints reference) while the walk was in flight; the caller
   *  retries once with the cache invalidated. */
  private async captureOnce(
    workspaceRoot: string,
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): Promise<TreeManifest | { reason: "blob_capture_failed" } | "retry"> {
    return this.locks.withWorkspaceMutex(workspaceRoot, async () => {
      // Register as in-flight before any blob write so a concurrent GC in
      // another process defers its sweep (creation is store-locked, which is
      // what makes GC's fresh-marker check authoritative).
      const endCapture = await this.locks.withStoreLock(() => this.liveness.beginCaptureMarker());
      try {
        if (!(await this.mutator.recoverWorkspace(workspaceRoot))) {
          return { reason: "blob_capture_failed" } as const;
        }
        await this.liveness.publishLease();
        const cache = this.workspaceCaches.get(workspaceRoot);
        // The cached tree's presence witnesses that its blobs are still
        // retained: GC removes a tree before its blobs, and never concurrently
        // with the store-locked publish below. The check is repeated inside
        // that locked section, where it is authoritative.
        const cachedFiles =
          cache && (await exists(this.treePath(cache.treeId))) ? cache.files : undefined;
        if (cache && !cachedFiles) this.workspaceCaches.delete(workspaceRoot);
        const captureTime = this.clock().getTime();
        const guardTime = cache?.captureTime ?? captureTime;
        const walked = await this.walker.walk(workspaceRoot, cachedFiles, guardTime);
        // Sort the walked arrays once, explicitly, so the on-disk manifest is sorted
        // and canonicalManifest stays a pure serializer (no redundant second sort).
        sortCanonical(walked.entries, walked.skippedPaths);
        const content = canonicalManifest(walked.entries, walked.skippedPaths);
        const treeId = sha256(content);
        const manifest: TreeManifest = {
          treeId,
          entries: walked.entries,
          skippedPaths: walked.skippedPaths,
        };
        return await this.locks.withStoreLock(() =>
          this.publishSnapshot({
            workspaceRoot,
            sessionHash,
            checkpointId,
            phase,
            cache,
            cachedFiles,
            walkedFiles: walked.files,
            captureTime,
            manifest,
            content,
          }),
        );
      } finally {
        await endCapture();
      }
    });
  }

  /** Publishes a walked snapshot: writes the manifest tree file (unless the
   *  validated cache already covers this treeId), the active ref, and inserts
   *  the capture cache. MUST be called while holding the store lock — it is
   *  the critical section whose atomicity with GC's sweep the capture-marker
   *  protocol depends on. Returns "retry" when a concurrent GC removed the
   *  cached tree while the walk was in flight; the caller retries once with
   *  the cache invalidated. */
  private async publishSnapshot(input: {
    workspaceRoot: string;
    sessionHash: string;
    checkpointId: string;
    phase: SnapshotPhase;
    cache: WorkspaceCache | undefined;
    cachedFiles: ReadonlyMap<string, CachedWorkspaceFile> | undefined;
    walkedFiles: Map<string, CachedWorkspaceFile>;
    captureTime: number;
    manifest: TreeManifest;
    content: string;
  }): Promise<TreeManifest | "retry"> {
    const { workspaceRoot, cache, cachedFiles, manifest, content } = input;
    if (cache && cachedFiles && !(await exists(this.treePath(cache.treeId)))) {
      // GC ran while the walk was in flight and swept the cached tree.
      // Its blobs may be gone too, so the cached entries this walk reused
      // cannot back a valid manifest; retry with the cache invalidated.
      this.workspaceCaches.delete(workspaceRoot);
      return "retry";
    }
    const treePath = this.treePath(manifest.treeId);
    if (!(cache && cachedFiles && cache.treeId === manifest.treeId)) {
      // When the treeId matches the validated cache, the tree file was
      // verified present above and GC shares this lock, so no exists()
      // check or rewrite is needed.
      if (!(await exists(treePath))) {
        const manifestContent = manifestFileContent(manifest, content);
        await atomicWrite(treePath, manifestContent);
        this.accountant.trackStoreWrite(manifest.treeId, Buffer.byteLength(manifestContent));
      }
    }
    await this.refs.createActiveRef(
      input.sessionHash,
      input.checkpointId,
      input.phase,
      manifest.treeId,
      this.ownerId,
    );
    this.cacheWorkspace(workspaceRoot, manifest.treeId, input.walkedFiles, input.captureTime);
    return manifest;
  }

  async applySnapshot(
    workspaceRoot: string,
    _sessionHash: string,
    sourceTreeId: string,
    targetTreeId: string,
  ): Promise<BlobApplyResult> {
    let root: string;
    try {
      root = await canonicalPath(workspaceRoot);
    } catch {
      return { status: "failed" };
    }
    try {
      return await this.locks.withWorkspaceMutex(root, () =>
        this.mutator.apply(root, sourceTreeId, targetTreeId),
      );
    } catch {
      return { status: "failed" };
    }
  }

  async releaseCheckpointRefs(
    sessionHash: string,
    checkpointIds: readonly string[],
  ): Promise<boolean> {
    // No-op and invalid-argument paths must short-circuit before lock
    // acquisition: under 10 s of lock contention a timeout here would
    // otherwise turn a deterministic true/false into false.
    if (checkpointIds.length === 0) return true;
    if (!isHash(sessionHash)) return false;
    try {
      return await this.locks.withStoreLock(() =>
        this.refs.releaseCheckpointRefs(sessionHash, checkpointIds),
      );
    } catch {
      return false;
    }
  }

  async retainCheckpointForResume(sessionHash: string, checkpointId: string): Promise<boolean> {
    try {
      return await this.locks.withStoreLock(() =>
        this.refs.retainForResume(sessionHash, checkpointId),
      );
    } catch {
      return false;
    }
  }

  async hasActiveRefs(sessionHash: string, checkpointId: string): Promise<boolean> {
    return this.refs.hasActive(sessionHash, checkpointId);
  }

  async hasHistoryRef(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): Promise<boolean> {
    return this.refs.hasHistory(sessionHash, checkpointId, phase);
  }

  async refMatches(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
    treeId: string,
    namespace: "active" | "history" = "history",
  ): Promise<boolean> {
    return this.refs.matches(sessionHash, checkpointId, phase, treeId, namespace);
  }

  async collectGarbage(): Promise<void> {
    await this.locks.withStoreLock(() => this.janitor.collectUnlocked(true));
  }

  async garbageCollect(): Promise<void> {
    await this.collectGarbage();
  }

  async shutdown(): Promise<void> {
    if (!this.liveness.hasPublishedLease || (await this.refs.ownerHasActiveRefs(this.ownerId))) {
      return;
    }
    await this.liveness.clearLease();
  }

  async measureStoreBytes(): Promise<number> {
    return this.accountant.measure();
  }

  async releaseSessionRefs(sessionHash: string): Promise<boolean> {
    try {
      return await this.locks.withStoreLock(() => this.refs.releaseSession(sessionHash));
    } catch {
      return false;
    }
  }

  async expireAndCollect(
    retentionDays: number,
    maxStoreBytes: number,
    activeSessionHashes: ReadonlySet<string> | (() => ReadonlySet<string>),
  ): Promise<void> {
    await this.locks.withStoreLock(() =>
      this.janitor.expireAndCollect(retentionDays, maxStoreBytes, activeSessionHashes),
    );
  }

  async treeExists(treeId: string): Promise<boolean> {
    return exists(this.treePath(treeId));
  }

  async blobExists(blobHash: string): Promise<boolean> {
    return isHash(blobHash) && exists(this.blobPath(blobHash));
  }

  async treeUsable(treeId: string): Promise<boolean> {
    const manifest = await readTreeManifest(this.rootDirectory, treeId);
    if (!manifest) return false;
    for (const entry of manifest.entries) {
      if (!(await this.blobExists(entry.blobHash))) return false;
    }
    return true;
  }
}
