import { lstat, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CachedWorkspaceFile, FileFingerprint, TreeEntry } from "./types.js";
import { sha256 } from "./fs.js";

const RACILY_CLEAN_MS = 4_000;
export const DEFAULT_WALK_CONCURRENCY = 16;
export const MAX_WALK_CONCURRENCY = 64;

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

interface WorkspaceWalkResult {
  entries: TreeEntry[];
  skippedPaths: string[];
  files: Map<string, CachedWorkspaceFile>;
}

/** Walks one workspace root, fingerprinting every file and emitting
 *  content-addressed blobs through the injected writer. Reuses cached
 *  fingerprints (guarded against racily-clean timestamps) so unchanged
 *  files are neither read nor re-written. */
export class WorkspaceWalker {
  private readonly storeRoot: string;
  private readonly ignore: ReadonlySet<string>;
  private readonly maxFileBytes: number;
  private readonly readWorkspaceFile: (path: string) => Promise<Buffer>;
  private readonly walkConcurrency: number;
  private readonly writeBlob: (hash: string, content: Buffer) => Promise<void>;
  private storageRoot: Promise<string> | null = null;

  constructor(options: {
    storeRoot: string;
    ignore: ReadonlySet<string>;
    maxFileBytes: number;
    readWorkspaceFile: (path: string) => Promise<Buffer>;
    walkConcurrency: number;
    writeBlob: (hash: string, content: Buffer) => Promise<void>;
  }) {
    this.storeRoot = options.storeRoot;
    this.ignore = options.ignore;
    this.maxFileBytes = options.maxFileBytes;
    this.readWorkspaceFile = options.readWorkspaceFile;
    this.walkConcurrency = options.walkConcurrency;
    this.writeBlob = options.writeBlob;
  }

  private canonicalStorageRoot(): Promise<string> {
    this.storageRoot ??= realpath(this.storeRoot).catch(() => resolve(this.storeRoot));
    return this.storageRoot;
  }

  async walk(
    workspaceRoot: string,
    cachedFiles: ReadonlyMap<string, CachedWorkspaceFile> | undefined,
    guardTime: number,
  ): Promise<WorkspaceWalkResult> {
    const entries: WorkspaceWalkResult["entries"] = [];
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
}
