import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitRepository, GitRunner } from "./types.js";

export const DEFAULT_EXCLUDES = [
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

/** Per-workspace private repositories: a non-git workspace is snapshotted
 *  through a private git repo stored under the omp state root, keyed by the
 *  sha256 of the canonical workspace path. The worktree is pointed at the
 *  workspace via `core.worktree`, so `git add` reads the real workspace while
 *  all objects, refs, and the index live outside it. */

const PRIVATE_REPO_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // `git init` with GIT_DIR set creates a bare repository; flip it to a
  // non-bare repo so `core.worktree` is honored and the index/worktree
  // semantics used by snapshotting apply.
  ["core.bare", "false"],
  ["core.autocrlf", "false"],
  ["core.longpaths", "true"],
  ["core.symlinks", "true"],
  ["core.fsmonitor", "false"],
  ["feature.manyFiles", "true"],
  ["index.version", "4"],
  ["index.threads", "true"],
  ["core.untrackedCache", "true"],
];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalCwdSync(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    // The path may not exist yet (e.g., a fresh store root like
    // `C:\Users\BAYLAR~1.SAD\Temp\new-store` where only the parent exists).
    // Fall back to canonicalizing the nearest existing ancestor and re-appending
    // the remainder, so a short-form parent still yields a long-form result.
    let current = resolve(cwd);
    const suffix: string[] = [];
    while (true) {
      try {
        const canonical = realpathSync.native(current);
        return suffix.length ? join(canonical, ...suffix.reverse()) : canonical;
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(cwd);
        suffix.push(basename(current));
        current = parent;
      }
    }
  }
}

async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    let current = resolve(cwd);
    const suffix: string[] = [];
    while (true) {
      try {
        const canonical = await realpath(current);
        return suffix.length ? join(canonical, ...suffix.reverse()) : canonical;
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(cwd);
        suffix.push(basename(current));
        current = parent;
      }
    }
  }
}

function basenameIsRuntime(value: string): boolean {
  return value.endsWith(`${sep}runtime`) || value.endsWith("/runtime");
}

export function storeRootDirectory(): string {
  const explicit = process.env.OMP_UNDO_REDO_STORE_DIR ?? process.env.OMP_UNDO_REDO_BLOB_DIR;
  if (explicit) return canonicalCwdSync(explicit);
  if (process.env.OMP_UNDO_REDO_RUNTIME_DIR) {
    const runtime = resolve(process.env.OMP_UNDO_REDO_RUNTIME_DIR);
    return canonicalCwdSync(basenameIsRuntime(runtime) ? dirname(runtime) : runtime);
  }
  return canonicalCwdSync(join(homedir(), ".omp", "omp-undo-redo"));
}

/** The private git dir for a workspace: `<storeRoot>/repos/<sha256(cwd)>.git`.
 *  Both inputs are canonicalized here (realpath) so the result is one
 *  deterministic long-form path regardless of how the caller spelled either
 *  argument. Without this, a store root or cwd spelled in 8.3 short form
 *  (e.g. `C:\Users\BAYLAR~1.SAD\...`) would yield a gitDir string that
 *  differs from the realpath-canonicalized form recorded on checkpoints,
 *  so `isPrivateRepository` string comparisons would silently fail. */
export function privateRepositoryPath(storeRoot: string, cwd: string): string {
  return join(canonicalCwdSync(storeRoot), "repos", `${sha256Hex(canonicalCwdSync(cwd))}.git`);
}

async function repoExists(gitDir: string): Promise<boolean> {
  try {
    await readFile(join(gitDir, "HEAD"));
    return true;
  } catch {
    return false;
  }
}

export { canonicalCwd };

/** Appends `<relative-storeRoot>/` to the private repo's info/exclude so a
 *  snapshot never captures the omp state root (which contains the private
 *  repo itself), plus the same built-in ignore list the blob store uses
 *  (`node_modules`, `dist`, `.omp`, …) so private-git snapshots do not grow
 *  unbounded on churning dependency/build/state directories. The store-root
 *  entry is skipped when it is not inside the worktree; the built-in ignores
 *  are always seeded. */
async function ensureExclude(gitDir: string, worktree: string, storeRoot: string): Promise<void> {
  const excludePath = join(gitDir, "info", "exclude");
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    content = "";
  }
  const entries = new Set(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#")),
  );
  const canonicalStoreRoot = await canonicalCwd(storeRoot);
  const canonicalWorktree = await canonicalCwd(worktree);
  const rel = relative(canonicalWorktree, canonicalStoreRoot);
  if (rel && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel)) {
    entries.add(`${rel.replace(/\\/g, "/")}/`);
  }
  for (const ignored of DEFAULT_EXCLUDES) entries.add(ignored);
  const updated =
    content.length > 0 && !content.endsWith("\n")
      ? `${content}\n${[...entries].join("\n")}\n`
      : `${content}${[...entries].join("\n")}\n`;
  await writeFile(excludePath, updated, "utf8");
}

/** Ensures a private git repository exists for `cwd` under `storeRoot`.
 *  Idempotent: an existing repo (HEAD present) skips init/config but still
 *  gets the exclude entries. Returns null when init/config fails. */
export async function ensurePrivateGitRepository(
  gitRunnerFactory: (cwd: string, env?: Record<string, string>) => GitRunner,
  cwd: string,
  storeRoot: string,
): Promise<GitRepository | null> {
  const worktree = await canonicalCwd(cwd);
  const gitDir = privateRepositoryPath(storeRoot, worktree);
  const envGit = gitRunnerFactory(worktree, { GIT_DIR: gitDir });
  try {
    await mkdir(dirname(gitDir), { recursive: true });
    if (!(await repoExists(gitDir))) {
      const init = await envGit(["init", "-q"]);
      if (init.code !== 0) return null;
      for (const [key, value] of PRIVATE_REPO_CONFIG) {
        const result = await envGit(["config", key, value]);
        if (result.code !== 0) return null;
      }
      const worktreeConfig = await envGit(["config", "core.worktree", worktree]);
      if (worktreeConfig.code !== 0) return null;
    }
    await ensureExclude(gitDir, worktree, storeRoot);
    return { worktree, gitDir, commonDir: gitDir };
  } catch {
    return null;
  }
}
