import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_BLOB_IGNORES } from "./blob-store/types.js";
import type { GitRepository, GitRunner } from "./types.js";

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
    return realpathSync(cwd);
  } catch {
    return resolve(cwd);
  }
}

async function canonicalCwd(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return resolve(cwd);
  }
}

/** The private git dir for a workspace: `<storeRoot>/repos/<sha256(cwd)>.git`. */
export function privateRepositoryPath(storeRoot: string, cwd: string): string {
  return join(storeRoot, "repos", `${sha256Hex(canonicalCwdSync(cwd))}.git`);
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
  const rel = relative(worktree, storeRoot);
  if (rel && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel)) {
    entries.add(`${rel.replace(/\\/g, "/")}/`);
  }
  for (const ignored of DEFAULT_BLOB_IGNORES) entries.add(ignored);
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
