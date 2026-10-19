import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { CwdGitRunnerFactory, GitRepository } from "../types.js";
import { canonicalCwd, pathInside } from "../infra/paths.js";
import {
  SETUP_RETRIES,
  SETUP_RETRY_MS,
  privateRepositoryPath,
  ensureReposDirectory,
  setUpStore,
  applyConfig,
  ensureStoreHooksPath,
  storeHooksConfig,
  storeInitArgs,
} from "./setup.js";

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
  // IDE and tool state: Visual Studio holds `.vs` databases open exclusively.
  ".vs",
  ".idea",
  "__pycache__",
  ".venv",
  ".gradle",
] as const;

/** Per-workspace private repositories: a non-git workspace is snapshotted
 *  through a private git repo stored under the omp state root, keyed by the
 *  sha256 of the canonical workspace path. The worktree is pointed at the
 *  workspace via `core.worktree`, so `git add` reads the real workspace while
 *  all objects, refs, and the index live outside it. */

/** Applied once, when a store is set up or its abandoned setup is redone (see
 *  `setupState`). A key added here reaches only stores set up afterwards:
 *  existing stores need a migration like the `core.sharedRepository` and
 *  `core.hooksPath` re-applies in `ensurePrivateGitRepository`. */
const PRIVATE_REPO_CONFIG: ReadonlyArray<readonly [string, string]> = [
  // `git init` with GIT_DIR set creates a bare repository; flip it to a
  // non-bare repo so `core.worktree` is honored and the index/worktree
  // semantics used by snapshotting apply.
  ["core.bare", "false"],
  // Owner-only object/pack modes, so the snapshot store stays unreadable to
  // other local users even if the directory above it is loosened later.
  ["core.sharedRepository", "0600"],
  ["core.autocrlf", "false"],
  ["core.longpaths", "true"],
  ["core.symlinks", "true"],
  ["core.fsmonitor", "false"],
  ["feature.manyFiles", "true"],
  ["index.version", "4"],
  ["index.threads", "true"],
  ["core.untrackedCache", "true"],
];

/** Whether Private-Git must not snapshot `canonical` (a `canonicalCwd`
 *  result): a filesystem root, the home directory or any directory above it,
 *  or the OS temp directory. `git add` there copies credentials (`.ssh`,
 *  `AppData`, browser profiles) into plaintext store objects, and on a large
 *  profile it outruns the runner timeout every turn, so no snapshot completes.
 *  Git mode is unaffected: the repository's own ignore rules decide. */
export function refusedPrivateWorkspace(canonical: string): boolean {
  if (dirname(canonical) === canonical) return true;
  const home = homedir();
  if (home) {
    const below = relative(canonical, canonicalCwd(home));
    if (below === "") return true;
    if (below !== ".." && !below.startsWith(`..${sep}`) && !isAbsolute(below)) return true;
  }
  return relative(canonical, canonicalCwd(tmpdir())) === "";
}

/** Appends `<relative-storeRoot>/` to the private repo's info/exclude so a
 *  snapshot never captures the omp state root (which contains the private
 *  repo itself), plus the built-in default ignore list
 *  (`node_modules`, `dist`, `.omp`, …) so private-git snapshots do not grow
 *  unbounded on churning dependency/build/state directories. The store-root
 *  entry is skipped when it is not inside the worktree; the built-in ignores
 *  are always seeded. Launches started together race to replace the file, and
 *  Windows fails a rename onto (or a read of) a file another launch is
 *  replacing with EPERM. Every launch writes the same entries, so a failed
 *  update is retried with backoff: it re-reads and stops once they are there. */
async function ensureExclude(gitDir: string, worktree: string, storeRoot: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await updateExclude(gitDir, worktree, storeRoot);
    } catch (error) {
      if (attempt === SETUP_RETRIES) throw error;
      await sleep(SETUP_RETRY_MS * 2 ** attempt * (0.5 + Math.random()));
    }
  }
}

async function updateExclude(gitDir: string, worktree: string, storeRoot: string): Promise<void> {
  const excludePath = join(gitDir, "info", "exclude");
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch (error) {
    // Only a missing file is empty: rewriting after any other read failure
    // would drop the user's own entries.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const managed: string[] = [];
  const rel = pathInside(worktree, storeRoot);
  if (rel) managed.push(`${rel}/`);
  managed.push(...DEFAULT_EXCLUDES);

  const lines = content.split(/\r?\n/);
  // Earlier versions re-appended every managed entry on each launch. Drop the
  // repeats, keeping the first occurrence. Skipped when a negation exists:
  // last-match-wins makes line order significant there.
  const dedupe = !lines.some((line) => line.trim().startsWith("!"));
  const managedSet = new Set<string>(managed);
  const seen = new Set<string>();
  const kept = lines.filter((line) => {
    const entry = line.trim();
    if (!dedupe || !managedSet.has(entry)) return true;
    if (seen.has(entry)) return false;
    seen.add(entry);
    return true;
  });
  const present = new Set(kept.map((line) => line.trim()));
  const missing = managed.filter((entry) => !present.has(entry));
  if (missing.length === 0 && kept.length === lines.length) return;

  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  const updated = `${[...kept, ...missing].join("\n")}\n`;
  // A repository made from a template without `info/` (or by any other tool) lacks it.
  await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
  // Temp + rename: a crash or concurrent launch never leaves a truncated file.
  const tempPath = `${excludePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tempPath, updated, "utf8");
    await rename(tempPath, excludePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Ensures a private git repository exists for `cwd` under `storeRoot`.
 *  Idempotent: a finished store skips init/config but still gets the exclude
 *  entries. One whose setup was abandoned (see `setupState`) is redone; `git
 *  init` is repeated only when it never finished, because a second one resets
 *  `core.bare`. Returns null when init/config fails for a new store; an
 *  existing one is used as found. */
export async function ensurePrivateGitRepository(
  gitRunnerFactory: CwdGitRunnerFactory,
  cwd: string,
  storeRoot: string,
): Promise<GitRepository | null> {
  const worktree = canonicalCwd(cwd);
  const gitDir = privateRepositoryPath(storeRoot, worktree);
  const envGit = gitRunnerFactory(worktree, { GIT_DIR: gitDir });
  try {
    await ensureReposDirectory(dirname(gitDir), storeRoot);
    const ready = await setUpStore(
      gitDir,
      // No user template may seed hooks into the private repo, where the
      // extension's own git commands would run them (see `storeInitArgs`). It
      // does not create `info/`: `updateExclude` does that itself.
      async () => (await envGit(storeInitArgs(gitDir))).code === 0,
      // `core.worktree` goes last: `setupFinished` reads it as proof the rest ran.
      () =>
        applyConfig(envGit, [
          ...PRIVATE_REPO_CONFIG,
          storeHooksConfig(gitDir),
          ["core.worktree", worktree],
        ]),
      // Ensure repositories created by earlier versions write future objects
      // owner-only and run no hooks. Not while "busy": the writes would contend
      // for the config.lock a running setup needs.
      async () => {
        await envGit(["config", "core.sharedRepository", "0600"]).catch(() => undefined);
        await ensureStoreHooksPath(envGit, gitDir);
      },
    );
    if (!ready) return null;
    await ensureExclude(gitDir, worktree, storeRoot);
    return { worktree, gitDir, commonDir: gitDir, storeDir: gitDir };
  } catch {
    return null;
  }
}
