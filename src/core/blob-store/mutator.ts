import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative, sep } from "node:path";
import {
  atomicWrite,
  blobPathFor,
  chmodSafe,
  depth,
  exists,
  hashFile,
  isHash,
  validPath,
} from "./fs.js";
import { readTreeManifest } from "./manifest.js";
import type { BlobApplyResult, TreeEntry, TreeManifest } from "./types.js";

/** Computes the mutation set between two manifests: every path whose blob or
 *  mode differs, plus paths that appear on either side, minus anything under
 *  (or anchoring) a skipped path — skipped trees are never touched. */
export function changedPaths(
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

/** Applies snapshots to the workspace and recovers interrupted applies from
 *  their journals. Every mutation runs delete-before-write under a journal
 *  file so a crash mid-apply can be rolled back to the exact source state on
 *  the next capture or apply. Callers must already hold the workspace mutex;
 *  manifests must already be loadable. */

export class WorkspaceMutator {
  private readonly storeRoot: string;
  private readonly clock: () => Date;
  private readonly invalidateCache: (workspaceRoot: string) => void;

  constructor(options: {
    storeRoot: string;
    clock: () => Date;
    invalidateCache: (workspaceRoot: string) => void;
  }) {
    this.storeRoot = options.storeRoot;
    this.clock = options.clock;
    this.invalidateCache = options.invalidateCache;
  }

  private blobPath(hash: string): string {
    return blobPathFor(this.storeRoot, hash);
  }

  private loadManifest(treeId: string): Promise<TreeManifest | null> {
    return readTreeManifest(this.storeRoot, treeId);
  }

  private async blobExists(blobHash: string): Promise<boolean> {
    return isHash(blobHash) && exists(this.blobPath(blobHash));
  }

  private async failJournal(journalPath: string): Promise<void> {
    const failedDirectory = join(this.storeRoot, "journals", "failed");
    await mkdir(failedDirectory, { recursive: true, mode: 0o700 }).catch(() => undefined);
    await rename(journalPath, join(failedDirectory, basename(journalPath))).catch(() => undefined);
  }

  /** Replays any journal left behind by an interrupted apply against this
   *  workspace. Returns false when recovery is impossible; callers must then
   *  refuse to mutate the workspace. */
  async recoverWorkspace(workspaceRoot: string): Promise<boolean> {
    const directory = join(this.storeRoot, "journals");
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
          !value.paths.every((path) => typeof path === "string" && validPath(path))
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
        const expectedPaths = changedPaths(
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
        this.invalidateCache(workspaceRoot);
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
      return { hash: await hashFile(fullPath), mode: metadata.mode & 0o777 };
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
            hash: await hashFile(fullPath),
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

  /** Verifies the workspace still matches the source manifest, then applies
   *  the target manifest: remove changed files deepest-first, write target
   *  files shallowest-first, clean up emptied directories. Any mid-apply
   *  failure rolls the workspace back and quarantines or replays the journal. */
  async apply(root: string, sourceTreeId: string, targetTreeId: string): Promise<BlobApplyResult> {
    if (!(await this.recoverWorkspace(root))) return { status: "failed" };
    const source = await this.loadManifest(sourceTreeId);
    const target = await this.loadManifest(targetTreeId);
    if (!source || !target) return { status: "failed" };
    const sourceMap = new Map(source.entries.map((entry) => [entry.path, entry]));
    const targetMap = new Map(target.entries.map((entry) => [entry.path, entry]));
    const mutations = changedPaths(sourceMap, targetMap, source.skippedPaths, target.skippedPaths);
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
      if (!validPath(path)) return { status: "conflict" };
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
        if (state === "directory" && (await this.directoryMatchesEntries(root, path, targetMap))) {
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

    this.invalidateCache(root);
    const journalPath = join(this.storeRoot, "journals", `${randomUUID()}.json`);
    try {
      await atomicWrite(
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
        if ((await this.pathState(root, path)) === "file") await rm(fullPath, { force: true });
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
        await this.failJournal(journalPath);
      }
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
}
