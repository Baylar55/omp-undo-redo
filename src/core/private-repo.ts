import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  CwdGitRunnerFactory,
  DiscoveredRepository,
  GitRepository,
  GitRunner,
} from "./types.js";

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
 *  existing stores need a migration like the `core.sharedRepository` re-apply
 *  in `ensurePrivateGitRepository`. */
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

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Canonical (long-form, symlink-resolved) absolute path. Sync because the
 *  callers that key the store by it are sync, and `fs/promises` has no
 *  `realpath.native` — the native form is what the 8.3 short-path fixes on
 *  Windows depend on. */
function canonicalCwd(cwd: string): string {
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

function basenameIsRuntime(value: string): boolean {
  return value.endsWith(`${sep}runtime`) || value.endsWith("/runtime");
}

function defaultStoreRoot(): string {
  return canonicalCwd(join(homedir(), ".omp", "omp-undo-redo"));
}

export function storeRootDirectory(): string {
  const explicit = process.env.OMP_UNDO_REDO_STORE_DIR ?? process.env.OMP_UNDO_REDO_BLOB_DIR;
  if (explicit) return canonicalCwd(explicit);
  if (process.env.OMP_UNDO_REDO_RUNTIME_DIR) {
    const runtime = resolve(process.env.OMP_UNDO_REDO_RUNTIME_DIR);
    return canonicalCwd(basenameIsRuntime(runtime) ? dirname(runtime) : runtime);
  }
  return defaultStoreRoot();
}

/** Creates `<storeRoot>/repos` owner-only. A Private-Git snapshot captures
 *  everything in the workspace that is not in DEFAULT_EXCLUDES — .env, id_rsa,
 *  credentials.json — and git's own loose objects are world-readable under the
 *  default umask. The mode covers directories this call creates; the chmod of
 *  `repos` covers one created earlier with the umask default. The store root
 *  itself is re-moded only at its default location: a configured root may be a
 *  shared directory (`/tmp` as root in a container), whose permissions are not
 *  ours to strip, and `repos` already guards every snapshot in it. Windows
 *  ignores POSIX modes. */
async function ensureReposDirectory(reposDir: string, storeRoot: string): Promise<void> {
  await mkdir(reposDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  await chmod(reposDir, 0o700).catch(() => undefined);
  const root = canonicalCwd(storeRoot);
  if (root === defaultStoreRoot()) await chmod(root, 0o700).catch(() => undefined);
}

/** The store git dir for a path: `<storeRoot>/repos/<sha256(path)>.git` — a
 *  workspace (Private-Git) or a repository's `commonDir` (Git mode).
 *  Both inputs are canonicalized here (realpath) so the result is one
 *  deterministic long-form path regardless of how the caller spelled either
 *  argument: a store root or cwd spelled in 8.3 short form
 *  (e.g. `C:\Users\BAYLAR~1.SAD\...`) must name the same store. */
export function privateRepositoryPath(storeRoot: string, cwd: string): string {
  return join(canonicalCwd(storeRoot), "repos", `${sha256Hex(canonicalCwd(cwd))}.git`);
}

/** Config keys each store kind writes last, so either one proves setup ran. */
const SETUP_MARKERS: ReadonlyArray<readonly [section: string, key: string]> = [
  ["core", "worktree"],
  ["omp-undo-redo", "commondir"],
];

/** Whether `gitDir`'s setup finished, read from its config file without a git
 *  process: true when a setup marker is present, false when absent (a missing
 *  file included), null when the file cannot be read. Only the plain
 *  `[section]` headers and `key = value` lines git writes are recognised. */
export async function setupFinished(gitDir: string): Promise<boolean | null> {
  let text: string;
  try {
    text = await readFile(join(gitDir, "config"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : null;
  }
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const key = /^[A-Za-z][A-Za-z0-9-]*/.exec(line)?.[0].toLowerCase();
    if (SETUP_MARKERS.some(([s, k]) => s === section && k === key)) return true;
  }
  return false;
}

/** How long a store must sit untouched before an unfinished setup counts as
 *  abandoned: a running setup touches its config every few tens of ms. */
const SETUP_QUIET_MS = 10_000;

/** Where an existing store's setup stands. HEAD alone proves nothing: `git
 *  init` writes it before the config calls, older gits before their own config
 *  and `objects/`. "new": no HEAD. "done": a setup marker is present. "busy":
 *  no marker, but touched within SETUP_QUIET_MS (a concurrent launch may still
 *  be setting it up), or unreadable. "init": abandoned before `objects/`, the
 *  last thing `git init` creates, so git rejects the directory. "config":
 *  abandoned after `git init`. A `config.lock` as quiet as the rest is debris
 *  from a killed git, which git never removes, so it is deleted here. */
async function setupState(gitDir: string): Promise<"new" | "done" | "busy" | "init" | "config"> {
  const [head, config, lock] = await Promise.all(
    ["HEAD", "config", "config.lock"].map((name) =>
      stat(join(gitDir, name)).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    ),
  );
  if (head === 0) return "new";
  const finished = await setupFinished(gitDir);
  if (finished !== false) return finished ? "done" : "busy";
  if (Date.now() - Math.max(head, config, lock) < SETUP_QUIET_MS) return "busy";
  if (lock !== 0) await rm(join(gitDir, "config.lock"), { force: true }).catch(() => undefined);
  const hasObjects = await stat(join(gitDir, "objects")).then(
    () => true,
    () => false,
  );
  return hasObjects ? "config" : "init";
}

/** Applies `entries` in order and stops at the first failure. */
async function applyConfig(
  git: GitRunner,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<boolean> {
  for (const [key, value] of entries) {
    if ((await git(["config", key, value])).code !== 0) return false;
  }
  return true;
}

export { canonicalCwd };

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
 *  are always seeded. */
async function ensureExclude(gitDir: string, worktree: string, storeRoot: string): Promise<void> {
  const excludePath = join(gitDir, "info", "exclude");
  let content = "";
  try {
    content = await readFile(excludePath, "utf8");
  } catch {
    content = "";
  }
  const managed: string[] = [];
  const canonicalStoreRoot = canonicalCwd(storeRoot);
  const canonicalWorktree = canonicalCwd(worktree);
  const rel = relative(canonicalWorktree, canonicalStoreRoot);
  if (rel && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel)) {
    managed.push(`${rel.replace(/\\/g, "/")}/`);
  }
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
    const state = await setupState(gitDir);
    if (state === "new" || state === "init") {
      const init = await envGit(["init", "-q"]);
      if (init.code !== 0 && state === "new") return null;
    }
    if (state === "new" || state === "init" || state === "config") {
      // `core.worktree` goes last: `setupFinished` reads it as proof the rest ran.
      const configured = await applyConfig(envGit, [
        ...PRIVATE_REPO_CONFIG,
        ["core.worktree", worktree],
      ]);
      if (!configured && state === "new") return null;
    } else if (state === "done") {
      // Ensure repositories created by earlier versions write future objects
      // owner-only. Not while "busy": the write would contend for the
      // config.lock a running setup needs.
      await envGit(["config", "core.sharedRepository", "0600"]).catch(() => undefined);
    }
    await ensureExclude(gitDir, worktree, storeRoot);
    return { worktree, gitDir, commonDir: gitDir, storeDir: gitDir };
  } catch {
    return null;
  }
}

/** Config key naming the repository a Git-mode store belongs to (its
 *  `commonDir`); eviction treats the store as abandoned once that path is gone. */
export const GIT_STORE_SOURCE_KEY = "omp-undo-redo.commondir";

/** Ensures the bare snapshot store for a Git repository:
 *  `<storeRoot>/repos/<sha256(commonDir)>.git`, shared by linked worktrees the
 *  way their `.git` is. Snapshot commands still run against the user's
 *  repository (its HEAD, config, ignore and attribute rules) with
 *  `GIT_OBJECT_DIRECTORY` pointed here, so new objects land in the store,
 *  and `GIT_ALTERNATE_OBJECT_DIRECTORIES` pointed at the user's objects,
 *  which are borrowed rather than copied (see `snapshotRunnerEnv`). No
 *  `objects/info/alternates` file: a command run without that env sees only
 *  the store's own objects, which is how capture finds what it must copy.
 *  Refs are written with `GIT_DIR` set to the store. A store whose setup was
 *  abandoned is redone (see `setupState`); one that cannot be is used as
 *  found. Returns the store path, or null when a new one cannot be created. */
export async function ensureGitSnapshotStore(
  gitRunnerFactory: CwdGitRunnerFactory,
  repository: DiscoveredRepository,
  storeRoot: string,
): Promise<string | null> {
  const storeDir = privateRepositoryPath(storeRoot, repository.commonDir);
  const storeGit = gitRunnerFactory(repository.worktree, { GIT_DIR: storeDir });
  try {
    await ensureReposDirectory(dirname(storeDir), storeRoot);
    const state = await setupState(storeDir);
    if (state === "new" || state === "init") {
      // Objects written against the user's repository use its hash, so the
      // store must too or its refs could not name them.
      const format = await gitRunnerFactory(repository.worktree, {
        GIT_DIR: repository.commonDir,
      })(["config", "--get", "extensions.objectformat"]);
      const objectFormat = format.code === 0 ? format.stdout.trim() : "";
      const init = await storeGit([
        "init",
        "--bare",
        "-q",
        ...(objectFormat ? [`--object-format=${objectFormat}`] : []),
      ]);
      if (init.code !== 0 && state === "new") return null;
    }
    if (state === "new" || state === "init" || state === "config") {
      const configured = await applyConfig(storeGit, [
        ["core.sharedRepository", "0600"],
        // Only the extension's own git reads these refs, so paths past
        // MAX_PATH cannot hide them from anyone's gc.
        ["core.longpaths", "true"],
        // Last: `setupFinished` reads it as proof the rest ran.
        [GIT_STORE_SOURCE_KEY, repository.commonDir],
      ]);
      if (!configured && state === "new") return null;
    }
    return storeDir;
  } catch {
    return null;
  }
}
