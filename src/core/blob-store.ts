import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Stats } from "node:fs";
import {
  mkdir,
  lstat,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface TreeEntry {
  path: string;
  blobHash: string;
  mode: number;
}

export interface TreeManifest {
  treeId: string;
  entries: TreeEntry[];
  skippedPaths: string[];
}

interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  mode: number;
}

interface CachedWorkspaceFile {
  fingerprint: FileFingerprint;
  entry: TreeEntry;
}

interface WorkspaceCache {
  treeId: string;
  files: Map<string, CachedWorkspaceFile>;
  /** Wall-clock epoch (ms) when this cache was populated.  The racily-clean
   *  guard compares each file's cached mtime against this value so that only
   *  files whose mtime falls within RACILY_CLEAN_MS of the *prior* capture
   *  are forced to re-read — closing the FAT/SMB coarse-tick window where a
   *  rewrite and the observation land on the same tick. */
  captureTime: number;
}

export type SnapshotPhase = "before" | "after";
export type BlobApplyResult =
  { status: "applied"; partial: boolean } | { status: "conflict" } | { status: "failed" };

export const DEFAULT_BLOB_IGNORES = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".history",
  "dist",
  "coverage",
  ".omp",
  ".next",
  "build",
  "out",
  "target",
] as const;

const MAX_CACHED_WORKSPACES = 16;
const MAX_CACHED_FILES_PER_WORKSPACE = 100_000;
const MAX_CACHED_FILES = 100_000;
const RACILY_CLEAN_MS = 4_000;
const DEFAULT_WALK_CONCURRENCY = 16;
const MAX_WALK_CONCURRENCY = 64;

export function blobStoreRootDirectory(): string {
  if (process.env.OMP_UNDO_REDO_BLOB_DIR) return resolve(process.env.OMP_UNDO_REDO_BLOB_DIR);
  if (process.env.OMP_UNDO_REDO_RUNTIME_DIR) {
    const runtime = resolve(process.env.OMP_UNDO_REDO_RUNTIME_DIR);
    return basenameIsRuntime(runtime) ? dirname(runtime) : runtime;
  }
  return resolve(join(homedir(), ".omp", "omp-undo-redo"));
}

function basenameIsRuntime(value: string): boolean {
  return value.endsWith(`${sep}runtime`) || value.endsWith("/runtime");
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileFingerprint(metadata: Stats): FileFingerprint {
  return {
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    birthtimeMs: metadata.birthtimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode & 0o777,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.birthtimeMs === right.birthtimeMs &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortCanonical(entries: TreeEntry[], skippedPaths: string[]): void {
  entries.sort((left, right) => comparePaths(left.path, right.path));
  skippedPaths.sort(comparePaths);
}

function canonicalManifest(entries: readonly TreeEntry[], skippedPaths: readonly string[]): string {
  // Pure serializer of the exact order given. Producers (captureSnapshot) must pre-sort
  // via sortCanonical so the SHA-256 treeId is deterministic. loadManifest intentionally
  // does NOT re-sort: it must reproduce the exact on-disk order that was hashed at write
  // time (newer snapshots used comparePaths, older ones localeCompare), otherwise the
  // stored treeId wouldn't match and existing snapshots would be rejected.
  return JSON.stringify({ entries, skippedPaths });
}

function depth(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 47) count++; // "/"
  }
  return count;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function safeId(value: string): boolean {
  return /^[0-9a-fA-F-]{1,128}$/.test(value);
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export class BlobStore {
  private readonly maxFileBytes: number;
  private readonly ignore: ReadonlySet<string>;
  private readonly clock: () => Date;
  private readonly readWorkspaceFile: (path: string) => Promise<Buffer>;
  private readonly walkConcurrency: number;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly ownerId = randomUUID();
  private leasePublished = false;
  private readonly workspaceCaches = new Map<string, WorkspaceCache>();
  private storageRoot: Promise<string> | null = null;

  constructor(
    readonly rootDirectory: string,
    options: {
      maxFileBytes?: number;
      ignore?: readonly string[];
      clock?: () => Date;
      readWorkspaceFile?: (path: string) => Promise<Buffer>;
      walkConcurrency?: number;
    } = {},
  ) {
    this.rootDirectory = resolve(rootDirectory);
    this.maxFileBytes = options.maxFileBytes ?? 16 * 1024 * 1024;
    this.ignore = new Set(options.ignore ?? DEFAULT_BLOB_IGNORES);
    this.clock = options.clock ?? (() => new Date());
    this.readWorkspaceFile = options.readWorkspaceFile ?? readFile;
    this.walkConcurrency = Math.max(
      1,
      Math.min(options.walkConcurrency ?? DEFAULT_WALK_CONCURRENCY, MAX_WALK_CONCURRENCY),
    );
  }

  private blobPath(hash: string): string {
    return join(this.rootDirectory, "blobs", hash.slice(0, 2), hash.slice(2));
  }

  private treePath(treeId: string): string {
    return join(this.rootDirectory, "trees", `${treeId}.json`);
  }

  private refPath(
    namespace: "active" | "history",
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): string {
    return join(this.rootDirectory, "refs", namespace, sessionHash, checkpointId, `${phase}.ref`);
  }

  private async atomicWrite(path: string, content: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, { mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private async publishLease(): Promise<void> {
    if (this.leasePublished) return;
    await this.atomicWrite(
      join(this.rootDirectory, "leases", `${this.ownerId}.json`),
      JSON.stringify({
        ownerId: this.ownerId,
        pid: process.pid,
        hostname: hostname(),
        startedAt: this.clock().toISOString(),
      }),
    );
    this.leasePublished = true;
  }

  private async acquireFilesystemLock(name: string): Promise<() => Promise<void>> {
    const lockPath = join(this.rootDirectory, "locks", `${sha256(name)}.lock`);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(
            join(lockPath, "owner.json"),
            JSON.stringify({ pid: process.pid, hostname: hostname(), ownerId: this.ownerId }),
            { mode: 0o600 },
          );
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        return async () => {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
            pid?: number;
            hostname?: string;
          };
          if (owner.hostname === hostname() && typeof owner.pid === "number") {
            try {
              process.kill(owner.pid, 0);
            } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
                await rm(lockPath, { recursive: true, force: true });
                continue;
              }
            }
          }
        } catch {
          // A process can crash between mkdir and owner publication. Reap only an old,
          // ownerless lock; a live publisher gets a generous completion window.
          try {
            const metadata = await stat(lockPath);
            if (Date.now() - metadata.mtimeMs > 30_000) {
              await rm(lockPath, { recursive: true, force: true });
              continue;
            }
          } catch {
            continue;
          }
        }
        if (Date.now() >= deadline) throw new Error("blob store lock timeout");
        await delay(25);
      }
    }
  }

  private async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withWorkspaceLock(`store:${this.rootDirectory}`, async () => {
      const release = await this.acquireFilesystemLock(`store:${this.rootDirectory}`);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }

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
  }

  private async hashFile(path: string): Promise<{ hash: string; content?: Buffer }> {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return { hash: hash.digest("hex") };
  }

  private manifestFileContent(manifest: TreeManifest, canonical: string): string {
    return `{"treeId":${JSON.stringify(manifest.treeId)},${canonical.slice(1)}`;
  }

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

  private canonicalStorageRoot(): Promise<string> {
    this.storageRoot ??= realpath(this.rootDirectory).catch(() => resolve(this.rootDirectory));
    return this.storageRoot;
  }

  private async walkWorkspace(
    workspaceRoot: string,
    cachedFiles: ReadonlyMap<string, CachedWorkspaceFile> | undefined,
    guardTime: number,
  ): Promise<{
    entries: TreeEntry[];
    skippedPaths: string[];
    files: Map<string, CachedWorkspaceFile>;
  }> {
    const entries: TreeEntry[] = [];
    const skippedPaths: string[] = [];
    const files = new Map<string, CachedWorkspaceFile>();
    // Storage-root containment without a per-entry realpath: workspaceRoot and the
    // storage root are both canonical (resolved by captureSnapshot and
    // canonicalStorageRoot), and entries are walked by name, so a normalized
    // string-prefix comparison is equivalent to resolving every path. Symbolic
    // links are the only entries whose true target can diverge from their name
    // path, so they keep the (rare) realpath check below.
    const storageRoot = await this.canonicalStorageRoot();
    const normalized = (value: string) =>
      process.platform === "win32" ? value.toLowerCase() : value;
    const normalizedStorageRoot = normalized(storageRoot);
    if (normalized(workspaceRoot) === normalizedStorageRoot) {
      // Degenerate configuration: the workspace root IS the blob store. Capturing
      // the store's own blobs/trees/refs would pollute the tree, so the historical
      // per-entry containment check yielded an empty snapshot; preserve that.
      return { entries, skippedPaths, files };
    }
    const storageRelative = relative(workspaceRoot, storageRoot);
    const storagePrefix =
      storageRelative && !storageRelative.startsWith("..") && !isAbsolute(storageRelative)
        ? normalized(storageRelative.split(sep).join("/"))
        : null;
    const underStorageRoot = (value: string): boolean => {
      const resolved = normalized(value);
      return (
        resolved === normalizedStorageRoot || resolved.startsWith(`${normalizedStorageRoot}${sep}`)
      );
    };

    // A single global concurrency limit for the whole tree. A per-directory batch
    // would multiply through depth (C workers per directory -> C^depth in flight).
    // There is no sound shortcut that skips the per-file lstat pass: a directory's
    // mtime/ctime changes only on entry add/remove/rename — in-place content
    // rewrites (the case the racily-clean guard protects) leave it untouched — so
    // an "unchanged directory" cannot prove its files unchanged.
    const queue: Array<() => Promise<void>> = [];
    let head = 0;
    let running = 0;
    let pending = 0;
    let failure: unknown = null;
    let resolveDrained!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrained = resolve;
    });
    const pump = (): void => {
      while (running < this.walkConcurrency && head < queue.length) {
        const task = queue[head];
        head += 1;
        running += 1;
        void task()
          .catch((error: unknown) => {
            failure ??= error;
          })
          .finally(() => {
            running -= 1;
            pending -= 1;
            if (head === queue.length) {
              queue.length = 0;
              head = 0;
            }
            if (pending === 0) resolveDrained();
            else pump();
          });
      }
    };
    const enqueue = (task: () => Promise<void>): void => {
      pending += 1;
      queue.push(task);
      pump();
    };

    const processFile = async (fullPath: string, relativePath: string): Promise<void> => {
      const metadata = await lstat(fullPath);
      if (metadata.size > this.maxFileBytes) {
        skippedPaths.push(relativePath);
        return;
      }
      const fingerprint = fileFingerprint(metadata);
      const cached = cachedFiles?.get(relativePath);
      if (cached && sameFingerprint(cached.fingerprint, fingerprint)) {
        // Racily-clean guard: a same-size in-place rewrite that lands inside the
        // filesystem's timestamp resolution window (≤2 s on FAT/SMB) produces an
        // identical fingerprint.  We compare the file's mtime against the *prior*
        // capture's wall-clock — the window that matters is whether the file was
        // touched close to when we last observed it.  Two tick-widths (4 s) closes
        // the coarse-tick corner on FAT where a rewrite and the prior observation
        // land on the same tick.
        const racilyClean = Math.abs(cached.fingerprint.mtimeMs - guardTime) < RACILY_CLEAN_MS;
        if (!racilyClean) {
          entries.push(cached.entry);
          files.set(relativePath, cached);
          return;
        }
      }
      const content = await this.readWorkspaceFile(fullPath);
      const hash = sha256(content);
      await this.writeBlob(hash, content);
      const entry = { path: relativePath, blobHash: hash, mode: fingerprint.mode };
      entries.push(entry);
      files.set(relativePath, { fingerprint, entry });
    };

    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const children = await readdir(directory, { withFileTypes: true });
      for (const child of children) {
        if (this.ignore.has(child.name)) continue;
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const fullPath = join(directory, child.name);
        const normalizedRelativePath = normalized(relativePath);
        if (
          storagePrefix !== null &&
          (normalizedRelativePath === storagePrefix ||
            normalizedRelativePath.startsWith(`${storagePrefix}/`))
        )
          continue;
        if (child.isDirectory()) {
          enqueue(() => walk(fullPath, relativePath));
        } else if (child.isSymbolicLink()) {
          const resolved = await realpath(fullPath).catch(() => resolve(fullPath));
          if (!underStorageRoot(resolved)) skippedPaths.push(relativePath);
        } else if (child.isFile()) {
          enqueue(() => processFile(fullPath, relativePath));
        } else {
          skippedPaths.push(relativePath);
        }
      }
    };

    enqueue(() => walk(workspaceRoot, ""));
    await drained;
    if (failure) throw failure;
    return { entries, skippedPaths, files };
  }

  private async recoverWorkspace(workspaceRoot: string): Promise<boolean> {
    const directory = join(this.rootDirectory, "journals");
    let files: string[];
    try {
      files = await readdir(directory);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const journalPath = join(directory, file);
      try {
        const value = JSON.parse(await readFile(journalPath, "utf8")) as {
          workspaceRoot?: unknown;
          sourceTreeId?: unknown;
          targetTreeId?: unknown;
          paths?: unknown;
        };
        if (value.workspaceRoot !== workspaceRoot) continue;
        if (
          !isHash(value.sourceTreeId) ||
          !isHash(value.targetTreeId) ||
          !Array.isArray(value.paths) ||
          !value.paths.every((path) => typeof path === "string" && this.validPath(path))
        ) {
          await this.failJournal(journalPath);
          return false;
        }
        const journalPaths = value.paths as string[];
        const source = await this.loadManifest(value.sourceTreeId);
        const target = await this.loadManifest(value.targetTreeId);
        if (!source || !target) {
          await this.failJournal(journalPath);
          return false;
        }
        const sourceMap = new Map(source.entries.map((entry) => [entry.path, entry]));
        const targetMap = new Map(target.entries.map((entry) => [entry.path, entry]));
        const expectedPaths = this.changedPaths(
          sourceMap,
          targetMap,
          source.skippedPaths,
          target.skippedPaths,
        );
        if (
          expectedPaths.length !== journalPaths.length ||
          expectedPaths.some((path, index) => path !== [...journalPaths].sort()[index])
        ) {
          await this.failJournal(journalPath);
          return false;
        }
        this.workspaceCaches.delete(workspaceRoot);
        if (!(await this.rollbackSnapshot(workspaceRoot, sourceMap, targetMap, expectedPaths))) {
          await this.failJournal(journalPath);
          return false;
        }
        await rm(journalPath, { force: true });
      } catch {
        await this.failJournal(journalPath);
        return false;
      }
    }
    return true;
  }

  private async failJournal(journalPath: string): Promise<void> {
    const failedDirectory = join(this.rootDirectory, "journals", "failed");
    await mkdir(failedDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined);
    await rename(journalPath, join(failedDirectory, basename(journalPath))).catch(() => undefined);
  }

  private changedPaths(
    source: Map<string, TreeEntry>,
    target: Map<string, TreeEntry>,
    sourceSkipped: readonly string[] = [],
    targetSkipped: readonly string[] = [],
  ): string[] {
    const skipped = new Set([...sourceSkipped, ...targetSkipped]);
    const skippedAndAncestors = new Set<string>();
    for (const skippedPath of skipped) {
      let current = skippedPath;
      while (current !== "." && current !== "") {
        skippedAndAncestors.add(current);
        current = dirname(current);
      }
    }
    const overlapsSkipped = (path: string): boolean => {
      if (skippedAndAncestors.has(path)) return true;
      let current = dirname(path);
      while (current !== "." && current !== "") {
        if (skipped.has(current)) return true;
        current = dirname(current);
      }
      return false;
    };
    const merged = new Set<string>();
    for (const key of source.keys()) merged.add(key);
    for (const key of target.keys()) merged.add(key);
    return [...merged]
      .filter((path) => !overlapsSkipped(path))
      .filter((path) => {
        const left = source.get(path);
        const right = target.get(path);
        return !left || !right || left.blobHash !== right.blobHash || left.mode !== right.mode;
      })
      .sort();
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
      canonicalRoot = await realpath(workspaceRoot);
      if (!(await lstat(canonicalRoot)).isDirectory()) return { reason: "workspace_unresolvable" };
    } catch {
      return { reason: "workspace_unresolvable" };
    }
    try {
      return await this.withStoreLock(async () => {
        if (!(await this.recoverWorkspace(canonicalRoot))) {
          return { reason: "blob_capture_failed" } as const;
        }
        await this.publishLease();
        const cache = this.workspaceCaches.get(canonicalRoot);
        // GC shares this lock and clears these entries, so a present tree has retained its blobs.
        const cachedFiles =
          cache && (await exists(this.treePath(cache.treeId))) ? cache.files : undefined;
        if (cache && !cachedFiles) this.workspaceCaches.delete(canonicalRoot);
        const captureTime = this.clock().getTime();
        const guardTime = cache?.captureTime ?? captureTime;
        const walked = await this.walkWorkspace(canonicalRoot, cachedFiles, guardTime);
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
        const treePath = this.treePath(treeId);
        if (!(cache && cachedFiles && cache.treeId === treeId)) {
          // When the treeId matches the validated cache, the tree file was verified
          // present above and GC shares this lock, so no exists() check or rewrite
          // is needed.
          if (!(await exists(treePath))) {
            await this.atomicWrite(treePath, this.manifestFileContent(manifest, content));
          }
        }
        await this.atomicWrite(
          this.refPath("active", sessionHash, checkpointId, phase),
          JSON.stringify({ treeId, ownerId: this.ownerId }),
        );
        this.cacheWorkspace(canonicalRoot, treeId, walked.files, captureTime);
        return manifest;
      });
    } catch {
      return { reason: "blob_capture_failed" };
    }
  }

  private async loadManifest(treeId: string): Promise<TreeManifest | null> {
    if (!isHash(treeId)) return null;
    try {
      const value = JSON.parse(await readFile(this.treePath(treeId), "utf8")) as unknown;
      if (!value || typeof value !== "object") return null;
      const candidate = value as Record<string, unknown>;
      if (
        candidate.treeId !== treeId ||
        !Array.isArray(candidate.entries) ||
        !Array.isArray(candidate.skippedPaths)
      )
        return null;
      const entries: TreeEntry[] = [];
      const paths = new Set<string>();
      for (const entry of candidate.entries) {
        if (!entry || typeof entry !== "object") return null;
        const item = entry as Record<string, unknown>;
        if (
          typeof item.path !== "string" ||
          !isHash(item.blobHash) ||
          !Number.isInteger(item.mode) ||
          Number(item.mode) < 0 ||
          Number(item.mode) > 0o777 ||
          !this.validPath(item.path) ||
          paths.has(item.path)
        )
          return null;
        paths.add(item.path);
        entries.push({ path: item.path, blobHash: item.blobHash, mode: Number(item.mode) });
      }
      const skippedPaths = candidate.skippedPaths.filter(
        (path): path is string => typeof path === "string",
      );
      if (
        skippedPaths.length !== candidate.skippedPaths.length ||
        !skippedPaths.every((path) => this.validPath(path)) ||
        sha256(canonicalManifest(entries, skippedPaths)) !== treeId
      )
        return null;
      const folded = new Set<string>();
      for (const path of paths) {
        const key = process.platform === "win32" ? path.toLowerCase() : path;
        if (folded.has(key)) return null;
        folded.add(key);
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index++) {
          if (paths.has(parts.slice(0, index).join("/"))) return null;
        }
      }
      return { treeId, entries, skippedPaths };
    } catch {
      return null;
    }
  }

  private validPath(value: string): boolean {
    if (
      !value ||
      value.includes("\0") ||
      value.includes("\\") ||
      isAbsolute(value) ||
      /^[A-Za-z]:/.test(value)
    )
      return false;
    const parts = value.split("/");
    return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
  }

  private async safeParent(root: string, value: string): Promise<boolean> {
    const parent = dirname(value);
    const parts = relative(root, parent).split(sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      try {
        const metadata = await lstat(current);
        if (metadata.isSymbolicLink() || !metadata.isDirectory()) return false;
      } catch {
        break;
      }
    }
    return true;
  }

  private async currentFile(
    root: string,
    path: string,
  ): Promise<{ hash: string; mode: number } | null> {
    try {
      const fullPath = join(root, ...path.split("/"));
      const metadata = await lstat(fullPath);
      if (!metadata.isFile()) return null;
      return { hash: (await this.hashFile(fullPath)).hash, mode: metadata.mode & 0o777 };
    } catch {
      return null;
    }
  }

  private async directoryMatchesEntries(
    root: string,
    path: string,
    expected: Map<string, TreeEntry>,
  ): Promise<boolean> {
    const prefix = `${path}/`;
    const actual = new Map<string, { hash: string; mode: number }>();
    const walk = async (directory: string, relativeDirectory: string): Promise<boolean> => {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const fullPath = join(directory, child.name);
        if (child.isSymbolicLink()) return false;
        if (child.isDirectory()) {
          if (!(await walk(fullPath, relativePath))) return false;
        } else if (child.isFile()) {
          const metadata = await lstat(fullPath);
          actual.set(relativePath, {
            hash: (await this.hashFile(fullPath)).hash,
            mode: metadata.mode & 0o777,
          });
        } else {
          return false;
        }
      }
      return true;
    };
    if (!(await walk(join(root, ...path.split("/")), path))) return false;
    const expectedPaths = [...expected.keys()].filter((value) => value.startsWith(prefix));
    if (expectedPaths.length !== actual.size) return false;
    for (const expectedPath of expectedPaths) {
      const entry = expected.get(expectedPath)!;
      const current = actual.get(expectedPath);
      if (!current || current.hash !== entry.blobHash || current.mode !== entry.mode) return false;
    }
    return true;
  }

  private async pathState(
    root: string,
    path: string,
  ): Promise<"missing" | "file" | "directory" | "symlink"> {
    try {
      const metadata = await lstat(join(root, ...path.split("/")));
      if (metadata.isSymbolicLink()) return "symlink";
      if (metadata.isFile()) return "file";
      if (metadata.isDirectory()) return "directory";
      return "symlink";
    } catch {
      return "missing";
    }
  }

  private async withWorkspaceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = prior.then(() => current);
    this.locks.set(root, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(root) === tail) this.locks.delete(root);
    }
  }

  async applySnapshot(
    workspaceRoot: string,
    _sessionHash: string,
    sourceTreeId: string,
    targetTreeId: string,
  ): Promise<BlobApplyResult> {
    let root: string;
    try {
      root = await realpath(workspaceRoot);
    } catch {
      return { status: "failed" };
    }
    try {
      return await this.withStoreLock(() =>
        this.withWorkspaceLock(root, async () => {
          if (!(await this.recoverWorkspace(root))) return { status: "failed" };
          const source = await this.loadManifest(sourceTreeId);
          const target = await this.loadManifest(targetTreeId);
          if (!source || !target) return { status: "failed" };
          const sourceMap = new Map(source.entries.map((entry) => [entry.path, entry]));
          const targetMap = new Map(target.entries.map((entry) => [entry.path, entry]));
          const mutations = this.changedPaths(
            sourceMap,
            targetMap,
            source.skippedPaths,
            target.skippedPaths,
          );
          // Only changed entries can be read while applying or rolling back. Checking every
          // manifest entry makes a small undo/redo perform two full-tree stat passes.
          const requiredBlobHashes = new Set<string>();
          for (const path of mutations) {
            const sourceEntry = sourceMap.get(path);
            const targetEntry = targetMap.get(path);
            if (sourceEntry) requiredBlobHashes.add(sourceEntry.blobHash);
            if (targetEntry) requiredBlobHashes.add(targetEntry.blobHash);
          }
          for (const blobHash of requiredBlobHashes) {
            if (!(await this.blobExists(blobHash))) return { status: "failed" };
          }

          for (const path of mutations) {
            if (!this.validPath(path)) return { status: "conflict" };
            if (!(await this.safeParent(root, join(root, ...path.split("/"))))) {
              const parent = dirname(path);
              const sourceParent = sourceMap.get(parent);
              const targetParent = targetMap.get(parent);
              if (!sourceParent || targetParent) return { status: "conflict" };
            }
            const left = sourceMap.get(path);
            const right = targetMap.get(path);
            const state = await this.pathState(root, path);
            if (!left) {
              if (state === "missing") continue;
              if (
                state === "directory" &&
                right &&
                (await this.directoryMatchesEntries(root, path, sourceMap))
              ) {
                continue;
              }
              if (state !== "file") return { status: "conflict" };
              const current = await this.currentFile(root, path);
              if (!current || current.hash !== right?.blobHash) {
                return { status: "conflict" };
              }
            } else if (!right) {
              if (
                state === "directory" &&
                (await this.directoryMatchesEntries(root, path, targetMap))
              ) {
                continue;
              }
              const current = await this.currentFile(root, path);
              if (!current || current.hash !== left.blobHash || current.mode !== left.mode) {
                return { status: "conflict" };
              }
            } else {
              const current = await this.currentFile(root, path);
              if (!current || current.hash !== left.blobHash || current.mode !== left.mode) {
                return { status: "conflict" };
              }
            }
          }

          this.workspaceCaches.delete(root);
          const journalPath = join(this.rootDirectory, "journals", `${randomUUID()}.json`);
          try {
            await this.atomicWrite(
              journalPath,
              JSON.stringify({
                workspaceRoot: root,
                sourceTreeId,
                targetTreeId,
                createdAt: this.clock().toISOString(),
                paths: mutations,
              }),
            );
            const removals = mutations
              .filter(
                (path) =>
                  sourceMap.has(path) &&
                  (!targetMap.has(path) ||
                    sourceMap.get(path)?.mode !== targetMap.get(path)?.mode ||
                    sourceMap.get(path)?.blobHash !== targetMap.get(path)?.blobHash),
              )
              .sort((left, right) => depth(right) - depth(left));
            for (const path of removals) {
              const fullPath = join(root, ...path.split("/"));
              if ((await this.pathState(root, path)) === "file")
                await rm(fullPath, { force: true });
            }
            const writes = mutations
              .filter((path) => targetMap.has(path))
              .sort((left, right) => depth(left) - depth(right));
            for (const path of writes) {
              const entry = targetMap.get(path)!;
              const fullPath = join(root, ...path.split("/"));
              if (!(await this.safeParent(root, fullPath))) throw new Error("unsafe parent");
              if ((await this.pathState(root, path)) === "directory") {
                if ((await readdir(fullPath)).length > 0) throw new Error("directory obstruction");
                await rm(fullPath, { recursive: true });
              }
              await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
              const blob = await readFile(this.blobPath(entry.blobHash));
              const temporary = join(dirname(fullPath), `.${randomUUID()}.tmp`);
              try {
                await writeFile(temporary, blob, { mode: entry.mode || 0o600 });
                await rename(temporary, fullPath);
                await chmodSafe(fullPath, entry.mode);
              } finally {
                await rm(temporary, { force: true }).catch(() => undefined);
              }
            }
            await this.cleanupEmptyDirectories(root, sourceMap, targetMap, mutations);
            await rm(journalPath, { force: true });
            return {
              status: "applied",
              partial: source.skippedPaths.length > 0 || target.skippedPaths.length > 0,
            };
          } catch {
            const rolledBack = await this.rollbackSnapshot(root, sourceMap, targetMap, mutations);
            if (rolledBack) {
              await rm(journalPath, { force: true }).catch(() => undefined);
            } else {
              const failedDirectory = join(this.rootDirectory, "journals", "failed");
              await mkdir(failedDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined);
              await rename(journalPath, join(failedDirectory, basename(journalPath))).catch(
                () => undefined,
              );
            }
            return { status: "failed" };
          }
        }),
      );
    } catch {
      return { status: "failed" };
    }
  }

  private async rollbackSnapshot(
    root: string,
    source: Map<string, TreeEntry>,
    target: Map<string, TreeEntry>,
    mutations: readonly string[],
  ): Promise<boolean> {
    try {
      // Accept source state, target state, or a missing intermediate caused by delete-before-write.
      // Reject unknown content/types so recovery never overwrites a later user edit.
      for (const path of mutations) {
        const state = await this.pathState(root, path);
        if (state === "symlink") return false;
        if (state === "file") {
          const current = await this.currentFile(root, path);
          const sourceEntry = source.get(path);
          const targetEntry = target.get(path);
          const matches = (entry: TreeEntry | undefined) =>
            entry && current?.hash === entry.blobHash && current.mode === entry.mode;
          if (!matches(sourceEntry) && !matches(targetEntry)) return false;
        } else if (state === "directory") {
          const sourceMatches = await this.directoryMatchesEntries(root, path, source).catch(
            () => false,
          );
          const targetMatches = await this.directoryMatchesEntries(root, path, target).catch(
            () => false,
          );
          const empty = (await readdir(join(root, ...path.split("/")))).length === 0;
          if (!sourceMatches && !targetMatches && !empty) return false;
        }
      }

      // Remove known source/target/intermediate files, then rebuild exact source state.
      for (const path of [...mutations].sort((left, right) => depth(right) - depth(left))) {
        const fullPath = join(root, ...path.split("/"));
        if ((await this.pathState(root, path)) === "file") await rm(fullPath, { force: true });
      }
      await this.cleanupEmptyDirectories(root, target, source, mutations);
      for (const path of mutations
        .filter((value) => source.has(value))
        .sort((left, right) => depth(left) - depth(right))) {
        const entry = source.get(path)!;
        const fullPath = join(root, ...path.split("/"));
        if (!(await this.safeParent(root, fullPath))) return false;
        if ((await this.pathState(root, path)) === "directory") {
          if ((await readdir(fullPath)).length > 0) return false;
          await rm(fullPath, { recursive: true });
        }
        await mkdir(dirname(fullPath), { recursive: true, mode: 0o700 });
        const temporary = join(dirname(fullPath), `.${randomUUID()}.rollback.tmp`);
        try {
          await writeFile(temporary, await readFile(this.blobPath(entry.blobHash)), {
            mode: entry.mode || 0o600,
          });
          await rename(temporary, fullPath);
          await chmodSafe(fullPath, entry.mode);
        } finally {
          await rm(temporary, { force: true }).catch(() => undefined);
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  private async cleanupEmptyDirectories(
    root: string,
    source: Map<string, TreeEntry>,
    target: Map<string, TreeEntry>,
    mutations: readonly string[],
  ): Promise<void> {
    const candidates = new Set<string>();
    for (const path of mutations) {
      let current = dirname(path);
      while (current !== "." && current !== "") {
        candidates.add(current);
        current = dirname(current);
      }
    }
    for (const directory of [...candidates].sort((left, right) => depth(right) - depth(left))) {
      const hasTargetChild = [...target.keys()].some((path) => path.startsWith(`${directory}/`));
      if (hasTargetChild || [...source.keys()].some((path) => path === directory)) continue;
      const fullPath = join(root, ...directory.split("/"));
      if ((await this.pathState(root, directory)) !== "directory") continue;
      if ((await readdir(fullPath).catch(() => [])).length === 0) {
        await rm(fullPath, { recursive: true }).catch(() => undefined);
      }
    }
  }

  async releaseCheckpointRefs(
    sessionHash: string,
    checkpointIds: readonly string[],
  ): Promise<boolean> {
    if (checkpointIds.length === 0) return true;
    if (!isHash(sessionHash)) return false;
    try {
      return await this.withStoreLock(async () => {
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
      });
    } catch {
      return false;
    }
  }

  async retainCheckpointForResume(sessionHash: string, checkpointId: string): Promise<boolean> {
    if (!isHash(sessionHash) || !safeId(checkpointId)) return false;
    try {
      return await this.withStoreLock(async () => {
        const activeDirectory = join(
          this.rootDirectory,
          "refs",
          "active",
          sessionHash,
          checkpointId,
        );
        const historyDirectory = join(
          this.rootDirectory,
          "refs",
          "history",
          sessionHash,
          checkpointId,
        );
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
      });
    } catch {
      return false;
    }
  }

  async hasActiveRefs(sessionHash: string, checkpointId: string): Promise<boolean> {
    return isHash(sessionHash) && safeId(checkpointId)
      ? exists(this.refPath("active", sessionHash, checkpointId, "before"))
      : false;
  }

  async hasHistoryRef(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
  ): Promise<boolean> {
    return exists(this.refPath("history", sessionHash, checkpointId, phase));
  }

  private async readRef(path: string): Promise<{ treeId: string; ownerId?: string } | null> {
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

  async refMatches(
    sessionHash: string,
    checkpointId: string,
    phase: SnapshotPhase,
    treeId: string,
    namespace: "active" | "history" = "history",
  ): Promise<boolean> {
    if (!isHash(sessionHash) || !safeId(checkpointId) || !isHash(treeId)) return false;
    return (
      (await this.readRef(this.refPath(namespace, sessionHash, checkpointId, phase)))?.treeId ===
      treeId
    );
  }

  private async ownerIsProvablyStale(ownerId: string): Promise<boolean> {
    try {
      const value = JSON.parse(
        await readFile(join(this.rootDirectory, "leases", `${ownerId}.json`), "utf8"),
      ) as { ownerId?: unknown; pid?: unknown; hostname?: unknown };
      if (
        value.ownerId !== ownerId ||
        typeof value.pid !== "number" ||
        value.hostname !== hostname()
      )
        return false;
      try {
        process.kill(value.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } catch {
      return false;
    }
  }

  private async cleanupStaleActiveRefs(): Promise<void> {
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
        const ref = await this.readRef(path);
        if (ref?.ownerId && (await this.ownerIsProvablyStale(ref.ownerId))) {
          await rm(dirname(path), { recursive: true, force: true });
        }
      }
    };
    await scan(activeRoot);
  }

  async collectGarbage(): Promise<void> {
    await this.withStoreLock(async () => {
      await this.collectGarbageUnlocked();
    });
  }

  private async collectGarbageUnlocked(): Promise<void> {
    await this.cleanupStaleActiveRefs();
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
          const ref = await this.readRef(path);
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
        if (!referencedTrees.has(treeId))
          await rm(join(this.rootDirectory, "trees", child), { force: true });
      }
    } catch {
      // Nothing to collect.
    }
    try {
      for (const prefix of await readdir(join(this.rootDirectory, "blobs"))) {
        const directory = join(this.rootDirectory, "blobs", prefix);
        for (const child of await readdir(directory)) {
          const hash = `${prefix}${child}`;
          if (!referencedBlobs.has(hash)) await rm(join(directory, child), { force: true });
        }
      }
    } catch {
      // Nothing to collect.
    }
    this.workspaceCaches.clear();
  }

  async garbageCollect(): Promise<void> {
    await this.collectGarbage();
  }

  private async ownerHasActiveRefs(): Promise<boolean> {
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
          if ((await this.readRef(path))?.ownerId === this.ownerId) return true;
        }
      }
      return false;
    };
    return scan(join(this.rootDirectory, "refs", "active"));
  }

  async shutdown(): Promise<void> {
    if (!this.leasePublished || (await this.ownerHasActiveRefs())) return;
    await rm(join(this.rootDirectory, "leases", `${this.ownerId}.json`), { force: true }).catch(
      () => undefined,
    );
    this.leasePublished = false;
  }

  async measureStoreBytes(): Promise<number> {
    let totalBytes = 0;
    const scanDir = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const fullPath = join(directory, child.name);
        if (child.isDirectory()) {
          await scanDir(fullPath);
        } else if (child.isFile()) {
          try {
            const metadata = await stat(fullPath);
            totalBytes += metadata.size;
          } catch {
            // Ignore transient errors
          }
        }
      }
    };
    await scanDir(join(this.rootDirectory, "blobs"));
    await scanDir(join(this.rootDirectory, "trees"));
    return totalBytes;
  }

  async releaseSessionRefs(sessionHash: string): Promise<boolean> {
    if (!isHash(sessionHash)) return false;
    try {
      return await this.withStoreLock(async () => {
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
      });
    } catch {
      return false;
    }
  }

  async expireAndCollect(
    retentionDays: number,
    maxStoreBytes: number,
    activeSessionHashes: ReadonlySet<string> | (() => ReadonlySet<string>),
  ): Promise<void> {
    await this.withStoreLock(async () => {
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

      const removeSessionRefsInternal = async (sessionHash: string): Promise<boolean> => {
        try {
          for (const namespace of ["history", "active"] as const) {
            await rm(join(this.rootDirectory, "refs", namespace, sessionHash), {
              recursive: true,
              force: true,
            });
          }
          return true;
        } catch {
          return false;
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
      if (retentionDays > 0) {
        const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
        const files = await getHistoryFiles();
        for (const file of files) {
          const item = await parseSessionTimestamp(file);
          if (!item) continue;
          if (item.timestamp <= cutoff) {
            if (getActive().has(item.sessionHash)) continue;
            const refsDeleted = await removeSessionRefsInternal(item.sessionHash);
            if (!refsDeleted) continue;

            const tombstoneFile = join(historyDir, `${item.sessionHash}.expired.json`);
            const tombstoneData = {
              expired: true,
              sessionHash: item.sessionHash,
              expiredAt: new Date().toISOString(),
              reason: "age",
            };
            await this.atomicWrite(tombstoneFile, JSON.stringify(tombstoneData)).catch(
              () => undefined,
            );
            await rm(item.filePath, { force: true }).catch(() => undefined);
          }
        }
      }

      // Phase 2: Storage cap eviction
      if (maxStoreBytes > 0) {
        let currentBytes = await this.measureStoreBytes();
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
            currentBytes = await this.measureStoreBytes();
            if (currentBytes <= maxStoreBytes) break;

            const refsDeleted = await removeSessionRefsInternal(item.sessionHash);
            if (!refsDeleted) continue;

            const tombstoneFile = join(historyDir, `${item.sessionHash}.expired.json`);
            const tombstoneData = {
              expired: true,
              sessionHash: item.sessionHash,
              expiredAt: new Date().toISOString(),
              reason: "storage_cap",
            };
            await this.atomicWrite(tombstoneFile, JSON.stringify(tombstoneData)).catch(
              () => undefined,
            );
            await rm(item.filePath, { force: true }).catch(() => undefined);
            await this.collectGarbageUnlocked();
          }
        }
      }

      // Always perform garbage collection and stale active-ref cleanup
      await this.collectGarbageUnlocked();
    });
  }

  async treeExists(treeId: string): Promise<boolean> {
    return exists(this.treePath(treeId));
  }

  async blobExists(blobHash: string): Promise<boolean> {
    return isHash(blobHash) && exists(this.blobPath(blobHash));
  }

  async treeUsable(treeId: string): Promise<boolean> {
    const manifest = await this.loadManifest(treeId);
    if (!manifest) return false;
    for (const entry of manifest.entries) {
      if (!(await this.blobExists(entry.blobHash))) return false;
    }
    return true;
  }
}

async function chmodSafe(path: string, mode: number): Promise<void> {
  try {
    const { chmod } = await import("node:fs/promises");
    await chmod(path, mode & 0o777);
  } catch {
    // Windows and filesystems without POSIX modes are allowed to ignore mode restoration.
  }
}
