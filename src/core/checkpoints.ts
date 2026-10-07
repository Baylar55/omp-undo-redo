import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import type { CheckpointOwnerRegistry } from "./checkpoint-owners.js";
import { deleteRefsBatched, markGcPending } from "./git-refs.js";
import type {
  DiscoveredRepository,
  FileCheckpointUnavailableReason,
  GitCheckpoint,
  GitRepository,
  GitRunner,
  OwnershipMode,
  PendingGitCheckpoint,
  SnapshotIndexLease,
} from "./types.js";

const GIT_AUTHOR = ["-c", "user.name=omp-undo-redo", "-c", "user.email=omp-undo-redo@local"];
const REF_ROOT = "refs/omp-undo-redo";
const WORKTREE_PATHSPEC = ":(top)";

/** Commit-message lines naming paths a snapshot left out: a nested repository
 *  with no commit, and a file git could not read (locked by another process,
 *  no read permission), whose tree entry is stale or missing. */
const NESTED_REPOSITORY_LINE = "Nested repository outside snapshot: ";
const UNREADABLE_FILE_LINE = "Unreadable file outside snapshot: ";
const NO_COMMIT_ERROR = /^error: '(.+?)\/?' does not have a commit checked out$/;
const UNABLE_TO_INDEX_ERROR = /^error: unable to index file '(.+?)\/?'$/;

/** Single spelling of the retained-history ref namespace. Takes an
 *  already-hashed session (`checkpointNamespace(sessionId)`), never a raw id. */
export const HISTORY_REF_ROOT = `${REF_ROOT}/history/`;
export function historyRefPrefix(sessionHash: string): string {
  return `${HISTORY_REF_ROOT}${sessionHash}/`;
}

// Alternate index reused across turns so each turn is not a full `git add -A`
// re-hash of the whole worktree. The first turn seeds it (with the user's own
// index stat data where `seedFromUserIndex` allows, else a full `add -A`
// re-hash) and every later turn's before/after snapshot reuses it, so
// unchanged files are skipped via git's stat-dance instead of being
// re-read. Keyed by repository + session so concurrent sessions/repos stay
// isolated. The lease is dropped (and reseeded) whenever its baseline tree
// changes, and evicted whenever its directory is released. With an unborn HEAD
// there is no baseline commit, so the seeding snapshot's own tree is the
// baseline and the lease goes stale once HEAD becomes born.
//
// The map holds only IDLE leases. A run takes its lease out for the whole
// before→after span (`leasesInUse`) and hands it back when the after-snapshot
// succeeds, so two overlapping turns never share one GIT_INDEX_FILE: a turn that
// starts while the previous after-snapshot still runs seeds its own index.
const persistentSnapshotIndices = new Map<string, SnapshotIndexLease>();
const leasesInUse = new Map<SnapshotIndexLease, string>();

function persistentIndexKey(repository: GitRepository, sessionId: string): string {
  return `${repository.worktree}\u0000${checkpointNamespace(sessionId)}`;
}

/** Releases the leases, idle or checked out, of `sessionIds` only. OMP binds a
 *  separate copy of the extension to every in-process subagent session, and
 *  those copies can share this module's state: one copy must never release
 *  another's leases, which are keyed by session. `inUse: false` keeps the
 *  checked-out ones, which a running git may still be writing. */
export async function releasePersistentSnapshotIndices(
  sessionIds: Iterable<string>,
  { inUse = true }: { inUse?: boolean } = {},
): Promise<void> {
  const suffixes = [...sessionIds].map((sessionId) => `\u0000${checkpointNamespace(sessionId)}`);
  const owned = (key: string): boolean => suffixes.some((suffix) => key.endsWith(suffix));
  const leases = [
    ...[...persistentSnapshotIndices].filter(([key]) => owned(key)).map(([, lease]) => lease),
    ...(inUse ? [...leasesInUse].filter(([, key]) => owned(key)).map(([lease]) => lease) : []),
  ];
  await Promise.all(leases.map((lease) => releaseSnapshotIndexLease(lease)));
}

/** Releases every lease this process holds, idle or checked out. Only for a
 *  process that hosts no other live copy of the extension: test workers,
 *  whose sessions never shut down. */
export async function releaseAllPersistentSnapshotIndices(): Promise<void> {
  const leases = [...persistentSnapshotIndices.values(), ...leasesInUse.keys()];
  await Promise.all(leases.map((lease) => releaseSnapshotIndexLease(lease)));
}

export function checkpointNamespace(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/** 16-hex checkpoint ids (64 random bits) and no session hash in v2 refs
 *  keep ref paths short: they are loose files under the store's `refs/`. */
function newCheckpointId(): string {
  return randomBytes(8).toString("hex");
}

/** A Git-mode store borrows the user's objects instead of copying them. */
export function borrowsObjects(repository: GitRepository): boolean {
  return repository.storeDir !== repository.gitDir;
}

function userObjects(repository: GitRepository): string {
  return join(repository.commonDir, "objects");
}

/** Env binding a runner to `repository`'s snapshot store. Private-Git runs
 *  every command inside the private repo; Git mode keeps the user's
 *  repository (HEAD, config, ignore rules), writes objects to the store and
 *  reads the user's through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so snapshot
 *  objects never enter the user's object store. */
export function snapshotRunnerEnv(repository: GitRepository): Record<string, string> {
  return borrowsObjects(repository)
    ? {
        GIT_OBJECT_DIRECTORY: join(repository.storeDir, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: userObjects(repository),
      }
    : { GIT_DIR: repository.storeDir };
}

/** Inverse of `snapshotRunnerEnv`: the store `git` is bound to, if any. */
function boundStore(git: GitRunner): string | undefined {
  const objects = git.env?.GIT_OBJECT_DIRECTORY;
  return objects ? dirname(objects) : git.env?.GIT_DIR;
}

/** Env for commands run inside the store: snapshot refs, and its `gc`,
 *  which must read the objects a Git-mode store borrows. */
export function storeEnv(repository: GitRepository): Record<string, string> {
  return borrowsObjects(repository)
    ? { GIT_DIR: repository.storeDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: userObjects(repository) }
    : { GIT_DIR: repository.storeDir };
}

/** Copies into a Git-mode store every object of a snapshot that the store
 *  only borrows and the user's HEAD does not reach: content of a reset or
 *  amended commit, a blob staged and then dropped, an old version a file was
 *  reverted to. Those survive the user's `gc` only for its grace periods,
 *  and `reflog expire --expire=now` + `gc --prune=now` would break the
 *  snapshot at once. What HEAD reaches stays shared, so capture never copies
 *  the repository: a user who rewrites history and prunes it on purpose
 *  loses the checkpoints that need it, and restoring them reports a failure.
 *  An unborn HEAD reaches nothing: every staged blob the store lacks is
 *  copied (the index is where an unborn repository's snapshot content can
 *  already exist). A clean worktree costs one `diff-tree`; objects the
 *  capture itself wrote are loose in the store and cost a `stat` each.
 *  The store's own gc would drop these copies again while the user's
 *  repository still holds the object (prune deletes loose duplicates of any
 *  pack, alternates' included; `repack -l` skips borrowed objects), so every
 *  store gc first moves them into a kept pack (`pinStoreObjects`). */
async function pinBorrowedObjects(
  git: GitRunner,
  repository: GitRepository,
  tree: string,
): Promise<boolean> {
  if (!borrowsObjects(repository)) return true;
  const env = snapshotRunnerEnv(repository);
  const changed = await invoke(
    git,
    ["diff-tree", "-r", "-t", "-z", "--no-renames", "--no-relative", "HEAD", tree, "--"],
    { env },
  );
  const candidates = new Set<string>();
  if (changed.code === 0) {
    // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
    const fields = changed.stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [, mode, , sha] = fields[index]!.slice(1).split(" ");
      if (mode !== "160000" && sha && !/^0+$/.test(sha)) candidates.add(sha);
    }
    // No difference means the snapshot is HEAD's own tree.
    if (candidates.size > 0) candidates.add(tree);
  } else {
    if (changed.error) return false;
    const head = await invoke(git, ["rev-parse", "--verify", "-q", "HEAD"], { env });
    if (head.code === 0 || head.error) return false;
    const staged = await invoke(git, ["ls-files", "-s", "-z"], { env });
    if (staged.code !== 0) return false;
    // Entries: "<mode> <object> <stage>\t<path>".
    for (const entry of staged.stdout.split("\0")) {
      const [mode, sha] = entry.split(" ");
      if (sha && mode !== "160000") candidates.add(sha);
    }
    candidates.add(tree);
  }
  const objects = join(repository.storeDir, "objects");
  const loose = await Promise.all(
    [...candidates].map((id) =>
      stat(join(objects, id.slice(0, 2), id.slice(2))).then(
        () => true,
        () => false,
      ),
    ),
  );
  const unknown = [...candidates].filter((_, index) => !loose[index]);
  if (unknown.length === 0) return true;
  // Without the alternates env only the store's own objects are visible.
  const local = await invoke(git, ["cat-file", "--batch-check=%(objectname)"], {
    env: { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
    stdin: `${unknown.join("\n")}\n`,
  });
  if (local.code !== 0) return false;
  const borrowed = local.stdout
    .split("\n")
    .filter((line) => line.endsWith(" missing"))
    .map((line) => line.slice(0, line.indexOf(" ")));
  if (borrowed.length === 0) return true;
  const packed = await invoke(git, ["pack-objects", "-q", join(objects, "pack", "pack")], {
    env,
    stdin: `${borrowed.join("\n")}\n`,
  });
  return packed.code === 0;
}

/** Content of the `.keep` file that marks a store's pins pack. */
const PINS_KEEP = "omp-undo-redo pins\n";

/** Runs right before a Git-mode store's prune and gc: packs every object the
 *  store's refs reach and the user's HEAD does not, borrowed ones included,
 *  into one pack kept from both (`.keep`), then unkeeps the previous pins
 *  pack so the same gc reclaims what no ref needs any more. Without it the
 *  gc would drop `pinBorrowedObjects`' copies (see there), and the user's
 *  `reflog expire --expire=now --all && gc --prune=now` would then break the
 *  snapshot. `--objects-edge-aggressive` also leaves out the blobs HEAD's
 *  tree holds: snapshot commits have no parent, so plain `--objects` would
 *  copy the whole checkout. An unborn HEAD reaches nothing, so everything is
 *  pinned. Any failure keeps the previous pins pack, so the gc then loses
 *  at most the copies made since. Private-Git stores borrow nothing.
 *  ponytail: no lock spans pinning and gc, so two processes maintaining one
 *  store at once can unkeep each other's pins pack, and a capture running
 *  meanwhile can lose its copy to this gc until the next maintenance
 *  re-pins it; only an aggressive user prune inside that gap loses data.
 *  Upgrade path: one store-wide lock file held across pin, prune and gc. */
export async function pinStoreObjects(
  git: GitRunner,
  repository: GitRepository,
  timeoutMs: number,
): Promise<void> {
  if (!borrowsObjects(repository)) return;
  const head = await invoke(git, ["rev-parse", "--verify", "-q", "HEAD"], {
    env: { GIT_DIR: repository.gitDir },
  });
  if (head.error) return;
  const headHash = head.code === 0 ? head.stdout.trim() : "";
  // A snapshot whose content the user already pruned stays broken; it must
  // not keep every other snapshot from being pinned.
  const listed = await invoke(
    git,
    [
      "rev-list",
      "--objects",
      "--objects-edge-aggressive",
      "--missing=allow-any",
      "--all",
      ...(headHash ? ["--not", headHash] : []),
    ],
    { timeoutMs },
  );
  if (listed.code !== 0 || listed.error) return;
  // Edges ("-<id>") are HEAD's commits, not objects to pin.
  const objects = listed.stdout.split("\n").filter((line) => line && !line.startsWith("-"));
  const packDir = join(repository.storeDir, "objects", "pack");
  let kept = "";
  if (objects.length > 0) {
    const packed = await invoke(git, ["pack-objects", "-q", join(packDir, "pack")], {
      stdin: `${objects.join("\n")}\n`,
      timeoutMs,
    });
    const hash = packed.stdout.trim();
    if (packed.code !== 0 || packed.error || !/^[0-9a-f]{40,64}$/.test(hash)) return;
    kept = `pack-${hash}.keep`;
    try {
      await writeFile(join(packDir, kept), PINS_KEEP);
    } catch {
      return;
    }
  }
  // Only after the new pack is kept. Unchanged pins rebuild the same pack.
  const names = await readdir(packDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".keep") || name === kept) continue;
    const path = join(packDir, name);
    if ((await readFile(path, "utf8").catch(() => "")) === PINS_KEEP) {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}

function checkpointRefs(
  sessionId: string,
  checkpointId: string,
  ownership: OwnershipMode,
  ownerId?: string,
): { beforeRef: string; afterRef: string } {
  const prefix =
    ownership === "v2" && ownerId
      ? `${REF_ROOT}/v2/${ownerId}/${checkpointId}`
      : `${REF_ROOT}/${checkpointNamespace(sessionId)}/${checkpointId}`;
  return { beforeRef: `${prefix}/before`, afterRef: `${prefix}/after` };
}

type GitCommandResult = Awaited<ReturnType<GitRunner>>;

/** Every command on a temporary index (`GIT_INDEX_FILE` in its env) runs with
 *  `core.splitIndex=false`: a repository that enables it would otherwise have
 *  git write the shared part of each temp index into the repository's git dir. */
async function invoke(
  git: GitRunner,
  args: string[],
  options?: Parameters<GitRunner>[1],
): Promise<GitCommandResult> {
  try {
    return await git(
      options?.env?.GIT_INDEX_FILE ? ["-c", "core.splitIndex=false", ...args] : args,
      options,
    );
  } catch {
    return { stdout: "", stderr: "", code: 1, error: "unavailable" };
  }
}

async function run(
  git: GitRunner,
  args: string[],
  options?: Parameters<GitRunner>[1],
): Promise<boolean> {
  return (await invoke(git, args, options)).code === 0;
}

async function canonicalPath(value: string, base: string): Promise<string> {
  const absolute = isAbsolute(value) ? value : resolve(base, value);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

export type RepositoryResolution =
  | { repository: DiscoveredRepository }
  | { reason: "git_unavailable" | "not_repository" | "repository_unresolvable" };

export async function resolveRepository(git: GitRunner): Promise<RepositoryResolution> {
  // One spawn: rev-parse prints each flag's answer on its own stdout line, in order.
  const result = await invoke(git, [
    "rev-parse",
    "--show-toplevel",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (result.error === "unavailable") return { reason: "git_unavailable" };
  const lines = result.code === 0 ? result.stdout.trim().split("\n") : [];
  const [worktree = "", gitDir = "", commonDir = ""] = lines.map((line) => line.trim());
  if (!worktree) {
    const cwd = git.cwd;
    if (!cwd) return { reason: "not_repository" };
    try {
      const gitPath = join(cwd, ".git");
      if (!(await stat(gitPath)).isDirectory()) return { reason: "repository_unresolvable" };
      const canonicalWorktree = await canonicalPath(cwd, cwd);
      const canonicalGitDir = await canonicalPath(gitPath, canonicalWorktree);
      return {
        repository: {
          worktree: canonicalWorktree,
          gitDir: canonicalGitDir,
          commonDir: canonicalGitDir,
        },
      };
    } catch {
      return { reason: "not_repository" };
    }
  }
  if (!gitDir || !commonDir) return { reason: "repository_unresolvable" };

  // git prints --git-dir/--git-common-dir relative to the process cwd, not to the
  // worktree root; resolving them against the worktree escapes the repo from a subdir.
  const base = git.cwd ?? worktree;
  return {
    repository: {
      worktree: await canonicalPath(worktree, worktree),
      gitDir: await canonicalPath(gitDir, base),
      commonDir: await canonicalPath(commonDir, base),
    },
  };
}

type SnapshotResult =
  | { hash: string; tree: string; snapshotIndexLease?: SnapshotIndexLease }
  | { reason: "invalid_head" | "snapshot_failed" };

type SeedSnapshotIndexResult =
  { status: "seeded"; headTree: string } | { status: "empty" | "invalid_head" | "failed" };

/** Seeds `env`'s index with `tree` plus the user's own index stat data for
 *  every entry whose blob `tree` still holds, so the `add -A` that follows
 *  re-hashes only changed files instead of every tracked one. `read-tree
 *  --reset` keeps an old entry only when it matches `tree` (`-m` would also
 *  refuse partially staged files and conflicts), so the result is a fresh
 *  `read-tree` with stat data. Declined (false) when the result could differ
 *  from a fresh seed, or reading the copy would touch the user's git dir:
 *  skip-worktree and assume-unchanged flags survive the merge and `add -A`
 *  would skip those paths, and a copied split index resolves its shared part
 *  from the git dir, whose mtime git then refreshes on every read. The copy's
 *  mtime is set just below the original's, so git's racy-clean check covers
 *  at least what it covers in the user's index.
 *  Streams, not `copyFile`: libuv opens with FILE_SHARE_DELETE on Windows, so
 *  a concurrent git can still replace the index. */
async function seedFromUserIndex(
  git: GitRunner,
  env: { GIT_INDEX_FILE: string },
  gitDir: string,
  tree: string,
): Promise<boolean> {
  const source = join(gitDir, "index");
  try {
    if ((await readdir(gitDir)).some((name) => name.startsWith("sharedindex."))) return false;
    const { atime, mtimeMs } = await stat(source);
    await pipeline(createReadStream(source), createWriteStream(env.GIT_INDEX_FILE));
    await utimes(env.GIT_INDEX_FILE, atime, new Date(mtimeMs - 1));
  } catch {
    return false;
  }
  if ((await invoke(git, ["read-tree", "--reset", tree], { env })).code !== 0) return false;
  // Tags: "H" plain, "S" skip-worktree, lowercase assume-unchanged.
  const entries = await invoke(git, ["ls-files", "-v", "-z"], { env });
  return (
    entries.code === 0 &&
    entries.stdout.split("\0").every((entry) => !entry || entry.startsWith("H "))
  );
}

/** `gitDir`: the repository whose index may seed stat data (`seedFromUserIndex`).
 *  A declined or failed attempt falls back to a plain `read-tree`, which
 *  replaces whatever the attempt left in the index file. */
async function seedSnapshotIndex(
  git: GitRunner,
  env: { GIT_INDEX_FILE: string },
  gitDir?: string,
): Promise<SeedSnapshotIndexResult> {
  const headTree = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const hash = headTree.stdout.trim();
  if (headTree.code === 0 && hash) {
    if (gitDir && (await seedFromUserIndex(git, env, gitDir, hash))) {
      return { status: "seeded", headTree: hash };
    }
    const seeded = await invoke(git, ["read-tree", hash], { env });
    return seeded.code === 0 ? { status: "seeded", headTree: hash } : { status: "failed" };
  }
  if (headTree.error === "unavailable") return { status: "failed" };

  const symbolicHead = await invoke(git, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolicHead.code !== 0 || !symbolicHead.stdout.trim()) return { status: "invalid_head" };
  const branchRef = symbolicHead.stdout.trim();
  const branch = await invoke(git, ["show-ref", "--verify", "--quiet", branchRef]);
  if (branch.code === 0) return { status: "invalid_head" };
  if (branch.error === "unavailable") return { status: "failed" };

  const empty = await invoke(git, ["read-tree", "--empty"], { env });
  return empty.code === 0 ? { status: "empty" } : { status: "failed" };
}

async function createCommitForTree(
  git: GitRunner,
  treeHash: string,
  message: string,
): Promise<SnapshotResult> {
  const commit = await invoke(git, [...GIT_AUTHOR, "commit-tree", treeHash, "-m", message]);
  if (commit.code !== 0) return { reason: "snapshot_failed" };
  const commitHash = commit.stdout.trim();
  return commitHash ? { hash: commitHash, tree: treeHash } : { reason: "snapshot_failed" };
}

/** A lease is usable only while its baseline still describes HEAD: the same
 *  HEAD tree for a born HEAD, and a still-unborn HEAD for an unborn lease.
 *  Checked once, after the tree is written: a check before the run would only
 *  fail a stale lease faster, and one spawn per snapshot costs more than the
 *  incremental pass a stale lease wastes before its caller reseeds. */
async function leaseBaselineCurrent(git: GitRunner, lease: SnapshotIndexLease): Promise<boolean> {
  const head = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (head.error === "unavailable") return false;
  const tree = head.code === 0 ? head.stdout.trim() : "";
  return lease.unborn ? tree === "" : tree === lease.baseTree;
}

/** Drops index entries that the current ignore rules exclude. With `baseTree`,
 *  entries the baseline tracks are kept: `read-tree HEAD` holds them in a fresh
 *  snapshot whatever the ignore rules say. Index-only: no worktree file is
 *  re-read, so the retained stat cache survives. */
async function pruneIgnoredEntries(
  git: GitRunner,
  env: Record<string, string>,
  baseTree?: string,
): Promise<boolean> {
  const ignored = await invoke(
    git,
    ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"],
    { env },
  );
  if (ignored.code !== 0) return false;
  let paths = ignored.stdout;
  if (paths && baseTree) {
    const added = await invoke(
      git,
      [
        "diff-index",
        "--cached",
        "--no-renames",
        "--diff-filter=A",
        "--name-only",
        "-z",
        baseTree,
        "--",
      ],
      { env },
    );
    if (added.code !== 0) return false;
    const untracked = new Set(added.stdout.split("\0"));
    paths = paths
      .split("\0")
      .filter((path) => path && untracked.has(path))
      .map((path) => `${path}\0`)
      .join("");
  }
  if (!paths) return true;
  const removed = await invoke(git, ["update-index", "--force-remove", "-z", "--stdin"], {
    env,
    stdin: paths,
  });
  return removed.code === 0;
}

/** Paths a snapshot left out, relative to the worktree root. */
interface OutsideSnapshot {
  nestedRepositories: string[];
  unreadableFiles: string[];
}

/** `git add -A` of the whole worktree. Two failures leave a path out instead
 *  of aborting every snapshot: an embedded repository with no commit checked
 *  out (cannot be recorded even as a gitlink; one `git init` in a subfolder
 *  would disable capture), and a file git cannot read (a database held open
 *  by a running app on Windows; it would disable capture for as long as the
 *  lock is held). The index keeps whatever entry an unreadable file had, so
 *  its tree entry is stale or missing: restores pin it (`applyPatch`) instead
 *  of treating it as deleted. Any other error still fails the snapshot, as
 *  does an error line not naming the file the following "unable to index"
 *  line reports. `LC_ALL=C` pins the messages being matched. */
async function addWorktree(
  git: GitRunner,
  env: Record<string, string>,
): Promise<OutsideSnapshot | null> {
  // `core.safecrlf` only warns (one stderr line per converted file) or, set to
  // true, aborts the add; the blobs written are the same either way.
  const added = await invoke(
    git,
    ["-c", "core.safecrlf=false", "add", "-A", "--ignore-errors", "--", WORKTREE_PATHSPEC],
    { env: { ...env, LC_ALL: "C" } },
  );
  const outside: OutsideSnapshot = { nestedRepositories: [], unreadableFiles: [] };
  if (added.code === 0) return outside;
  if (added.error || added.code !== 1) return null;
  // Error lines git printed for the file the next "unable to index" names.
  let reasons: string[] = [];
  for (const line of added.stderr.split(/\r?\n/)) {
    const noCommit = NO_COMMIT_ERROR.exec(line);
    if (noCommit) {
      outside.nestedRepositories.push(noCommit[1]!);
      continue;
    }
    const unable = UNABLE_TO_INDEX_ERROR.exec(line);
    if (unable) {
      const path = unable[1]!;
      if (reasons.length === 0) {
        if (path !== outside.nestedRepositories.at(-1)) return null;
      } else {
        if (!reasons.every((reason) => reason.includes(path))) return null;
        outside.unreadableFiles.push(path);
        reasons = [];
      }
      continue;
    }
    if (line.startsWith("fatal:")) return null;
    if (line.startsWith("error:")) reasons.push(line);
  }
  const leftOut = outside.nestedRepositories.length + outside.unreadableFiles.length;
  return reasons.length === 0 && leftOut > 0 ? outside : null;
}

function snapshotMessage(message: string, outside: OutsideSnapshot): string {
  const lines = [
    ...outside.nestedRepositories.map((path) => `${NESTED_REPOSITORY_LINE}${path}`),
    ...outside.unreadableFiles.map((path) => `${UNREADABLE_FILE_LINE}${path}`),
  ];
  return lines.length === 0 ? message : `${message}\n\n${lines.join("\n")}`;
}

async function releaseSnapshotIndexLease(lease: SnapshotIndexLease | undefined): Promise<boolean> {
  if (!lease) return true;
  leasesInUse.delete(lease);
  for (const [key, value] of persistentSnapshotIndices) {
    if (value === lease) persistentSnapshotIndices.delete(key);
  }
  try {
    await rm(lease.directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** Hands a finished run's lease back to the idle pool. No-op when the lease was
 *  released meanwhile (shutdown, stale baseline); when another run already
 *  pooled a lease for this key, the surplus one is deleted. */
async function returnLeaseToPool(lease: SnapshotIndexLease | undefined): Promise<void> {
  const key = lease && leasesInUse.get(lease);
  if (!lease || key === undefined) return;
  leasesInUse.delete(lease);
  if (persistentSnapshotIndices.has(key)) await releaseSnapshotIndexLease(lease);
  else persistentSnapshotIndices.set(key, lease);
}

export async function createSnapshotCommit(
  git: GitRunner,
  message: string,
  retainIndex = false,
  gitDir?: string,
): Promise<SnapshotResult> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-index-"));
    const indexPath = join(tempDirectory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    const seeded = await seedSnapshotIndex(git, env, gitDir);
    if (seeded.status === "invalid_head") return { reason: "invalid_head" };
    if (seeded.status === "failed") return { reason: "snapshot_failed" };
    const addEnv: Record<string, string> = { ...env };
    if (git.env?.GIT_DIR && git.cwd) addEnv.GIT_WORK_TREE = git.cwd;
    const outside = await addWorktree(git, addEnv);
    if (!outside) return { reason: "snapshot_failed" };
    const tree = await invoke(git, ["write-tree"], { env });
    if (tree.code !== 0) return { reason: "snapshot_failed" };
    const treeHash = tree.stdout.trim();
    if (!treeHash) return { reason: "snapshot_failed" };
    const commit = await createCommitForTree(git, treeHash, snapshotMessage(message, outside));
    if (!("hash" in commit)) return commit;
    if (retainIndex && (seeded.status === "seeded" || seeded.status === "empty")) {
      const snapshotIndexLease: SnapshotIndexLease =
        seeded.status === "seeded"
          ? { directory: tempDirectory, indexPath, baseTree: seeded.headTree }
          : // ponytail: unborn HEAD has no baseline commit, so the seeding
            // snapshot's own tree is the baseline. It is reachable from the
            // before/after refs; if it is ever pruned, diff-index fails and the
            // lease is simply reseeded.
            { directory: tempDirectory, indexPath, baseTree: treeHash, unborn: true };
      tempDirectory = null;
      return { ...commit, snapshotIndexLease };
    }
    return commit;
  } catch {
    return { reason: "snapshot_failed" };
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Paths a reused index restores from its baseline, from `diff-index --raw -z
 *  --diff-filter=ADT` output, as a NUL-separated pathspec file. Deletions and
 *  typechanges: `add -A` never re-adds an ignored path that a fresh `read-tree`
 *  would hold. Added gitlinks: `add -A` keeps a gitlink whose nested `.git` is
 *  gone, which would hide the directory's files from every later snapshot.
 *  Other added entries stay, so untracked files keep their stat cache instead of
 *  being re-hashed each snapshot; `pruneIgnoredEntries` drops the ones that
 *  became ignored. Bytes are sliced, never decoded, so any path survives.
 *  Null on malformed output. */
function normalizationPaths(raw: Buffer): Buffer | null {
  const paths: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const metaEnd = raw.indexOf(0, offset);
    const pathEnd = metaEnd < 0 ? -1 : raw.indexOf(0, metaEnd + 1);
    if (pathEnd < 0) return null;
    // `:<srcmode> <dstmode> <srcsha> <dstsha> <status>`
    const [, dstMode, , , status] = raw.toString("latin1", offset, metaEnd).split(" ");
    if (status !== "A" || dstMode === "160000") paths.push(raw.subarray(metaEnd + 1, pathEnd + 1));
    offset = pathEnd + 1;
  }
  return Buffer.concat(paths);
}

async function createSnapshotCommitFromLease(
  git: GitRunner,
  lease: SnapshotIndexLease,
  message: string,
): Promise<SnapshotResult> {
  const normalizationPath = join(lease.directory, `normalize-${randomUUID()}.nul`);
  const env = { GIT_INDEX_FILE: lease.indexPath };
  try {
    const differences = await invoke(
      git,
      [
        "diff-index",
        "--cached",
        "--no-renames",
        "--diff-filter=ADT",
        "--raw",
        "-z",
        `--output=${normalizationPath}`,
        lease.baseTree,
        "--",
      ],
      { env },
    );
    if (differences.code !== 0) return { reason: "snapshot_failed" };

    const restored = normalizationPaths(await readFile(normalizationPath));
    if (!restored) return { reason: "snapshot_failed" };
    if (restored.length > 0) {
      await writeFile(normalizationPath, restored);
      const reset = await invoke(
        git,
        [
          "--literal-pathspecs",
          "reset",
          "-q",
          lease.baseTree,
          `--pathspec-from-file=${normalizationPath}`,
          "--pathspec-file-nul",
        ],
        { env },
      );
      if (reset.code !== 0) return { reason: "snapshot_failed" };
    }

    const addEnv: Record<string, string> = { ...env };
    if (git.env?.GIT_DIR && git.cwd) addEnv.GIT_WORK_TREE = git.cwd;
    const outside = await addWorktree(git, addEnv);
    if (!outside) return { reason: "snapshot_failed" };
    // `add -A` cannot drop an entry that became ignored after it was staged, so
    // prune those explicitly; a fresh snapshot never holds one unless HEAD
    // tracks it (an unborn baseline tracks nothing).
    if (!(await pruneIgnoredEntries(git, addEnv, lease.unborn ? undefined : lease.baseTree))) {
      return { reason: "snapshot_failed" };
    }
    const tree = await invoke(git, ["write-tree"], { env });
    const treeHash = tree.stdout.trim();
    if (tree.code !== 0 || !treeHash) return { reason: "snapshot_failed" };

    if (!(await leaseBaselineCurrent(git, lease))) return { reason: "snapshot_failed" };
    return createCommitForTree(git, treeHash, snapshotMessage(message, outside));
  } catch {
    return { reason: "snapshot_failed" };
  } finally {
    await rm(normalizationPath, { force: true }).catch(() => undefined);
  }
}

interface RefRelease {
  repository: GitRepository;
  ref: string;
  expectedHash: string;
}

async function releaseLooseRef(
  repository: GitRepository,
  ref: string,
  expectedHash: string,
): Promise<boolean> {
  if (!ref.startsWith("refs/") || ref.includes("..")) return false;
  const path = join(repository.storeDir, ref);
  try {
    if ((await readFile(path, "utf8")).trim() !== expectedHash) return false;
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function releaseRefs(
  gitForRepository: (repository: GitRepository) => GitRunner,
  refs: readonly RefRelease[],
): Promise<boolean> {
  const grouped = new Map<string, RefRelease[]>();
  for (const ref of refs) {
    const list = grouped.get(ref.repository.storeDir);
    if (list) list.push(ref);
    else grouped.set(ref.repository.storeDir, [ref]);
  }
  const results = await Promise.allSettled(
    [...grouped.values()].map(async (groupedRefs) => {
      // Each group has at least one ref, so the head carries the repository.
      const { repository } = groupedRefs[0];
      try {
        await markGcPending(repository.storeDir);
        const outcome = await deleteRefsBatched(gitForRepository(repository), groupedRefs, {
          env: storeEnv(repository),
          onSingleFailure: ({ ref, expectedHash }) =>
            releaseLooseRef(repository, ref, expectedHash),
        });
        return outcome === "ok";
      } catch {
        return false;
      }
    }),
  );
  return results.every((result) => result.status === "fulfilled" && result.value);
}

export async function releaseCheckpoints(
  gitForRepository: (repository: GitRepository) => GitRunner,
  checkpoints: readonly GitCheckpoint[],
): Promise<boolean> {
  return releaseRefs(
    gitForRepository,
    checkpoints.flatMap((checkpoint) => [
      {
        repository: checkpoint.repository,
        ref: checkpoint.beforeRef,
        expectedHash: checkpoint.beforeHash,
      },
      {
        repository: checkpoint.repository,
        ref: checkpoint.afterRef,
        expectedHash: checkpoint.afterHash,
      },
    ]),
  );
}

export function releaseCheckpoint(git: GitRunner, checkpoint: GitCheckpoint): Promise<boolean> {
  return releaseCheckpoints(() => git, [checkpoint]);
}

/** `keepIndex`: hand the run's index lease back to the idle pool instead of
 *  deleting it. Only for a run that finished with the lease consistent (its
 *  index matches a real worktree read), e.g. a before-snapshot discarded for
 *  timing reasons; the next reuse re-reads the worktree and checks the baseline. */
export async function releasePendingCheckpoint(
  git: GitRunner,
  pending: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "snapshotIndexLease"
  >,
  keepIndex = false,
): Promise<boolean> {
  await markGcPending(pending.repository.storeDir);
  const [releasedRef, releasedLease] = await Promise.all([
    deleteRefsBatched(git, [{ ref: pending.beforeRef, expectedHash: pending.beforeHash }], {
      env: storeEnv(pending.repository),
      onSingleFailure: ({ ref, expectedHash }) =>
        releaseLooseRef(pending.repository, ref, expectedHash),
    }),
    keepIndex
      ? returnLeaseToPool(pending.snapshotIndexLease).then(() => true)
      : releaseSnapshotIndexLease(pending.snapshotIndexLease),
  ]);
  return releasedRef === "ok" && releasedLease;
}

export type PrepareBeforeTurnResult =
  | { status: "git"; checkpoint: PendingGitCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

export type FinishAfterTurnResult =
  | { status: "git"; checkpoint: GitCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

/** `known`: the store-bound repository `git` was created for. Callers holding
 *  the backend pass it, which spares a `rev-parse` per turn and lets a host
 *  runner factory that wraps runners without re-exposing `runner.env` still
 *  capture. Without it the repository is resolved from `git`. */
export async function prepareBeforeTurn(
  git: GitRunner,
  sessionId: string,
  ownerRegistry?: CheckpointOwnerRegistry,
  known?: GitRepository,
): Promise<PrepareBeforeTurnResult> {
  let repository: GitRepository;
  if (known) {
    // A git dir removed mid-session must not let discovery fall through to an
    // enclosing repository; a stat keeps the turn spawn-free.
    if (!(await stat(known.gitDir).catch(() => null))) {
      return { status: "session_only", reason: "not_repository" };
    }
    repository = known;
  } else {
    const resolved = await resolveRepository(git);
    if ("reason" in resolved) return { status: "session_only", reason: resolved.reason };
    // Fail closed: without a store, snapshot objects and refs would land in
    // the user's repository, where all-refs operations export them.
    const store = boundStore(git);
    if (!store) return { status: "session_only", reason: "repository_unresolvable" };
    repository = {
      ...resolved.repository,
      storeDir: await canonicalPath(store, resolved.repository.worktree),
    };
  }

  const ownership = ownerRegistry
    ? await ownerRegistry.ensureInitialized(repository, git)
    : "legacy";
  const checkpointId = newCheckpointId();
  const indexKey = persistentIndexKey(repository, sessionId);
  const priorLease = persistentSnapshotIndices.get(indexKey);
  if (priorLease) {
    persistentSnapshotIndices.delete(indexKey);
    leasesInUse.set(priorLease, indexKey);
  }
  let snapshot: SnapshotResult;
  let lease: SnapshotIndexLease | undefined;
  if (priorLease) {
    const reused = await createSnapshotCommitFromLease(
      git,
      priorLease,
      "omp-undo-redo: before turn",
    );
    if ("hash" in reused) {
      snapshot = reused;
      lease = priorLease;
    } else {
      await releaseSnapshotIndexLease(priorLease);
      snapshot = await createSnapshotCommit(
        git,
        "omp-undo-redo: before turn",
        true,
        repository.gitDir,
      );
      if ("hash" in snapshot) lease = snapshot.snapshotIndexLease;
    }
  } else {
    snapshot = await createSnapshotCommit(
      git,
      "omp-undo-redo: before turn",
      true,
      repository.gitDir,
    );
    if ("hash" in snapshot) lease = snapshot.snapshotIndexLease;
  }
  if (lease) leasesInUse.set(lease, indexKey);
  if (!("hash" in snapshot)) {
    return {
      status: "session_only",
      reason: snapshot.reason === "invalid_head" ? "invalid_head" : "before_snapshot_failed",
    };
  }
  if (!(await pinBorrowedObjects(git, repository, snapshot.tree))) {
    await releaseSnapshotIndexLease(lease);
    return { status: "session_only", reason: "before_snapshot_failed" };
  }
  const { beforeRef } = checkpointRefs(sessionId, checkpointId, ownership, ownerRegistry?.ownerId);
  if (
    !(await run(
      git,
      ["update-ref", "-m", "omp-undo-redo: retain before checkpoint", beforeRef, snapshot.hash],
      { env: storeEnv(repository) },
    ))
  ) {
    await releaseSnapshotIndexLease(lease);
    return {
      status: "session_only",
      reason: "before_ref_failed",
    };
  }
  // The lease stays checked out (`leasesInUse`) until finishAfterTurn returns it.
  return {
    status: "git",
    checkpoint: {
      kind: "git",
      repository,
      beforeHash: snapshot.hash,
      beforeRef,
      checkpointId,
      ...(lease ? { snapshotIndexLease: lease } : {}),
      parentLeafId: null,
    },
  };
}

export async function finishAfterTurn(
  git: GitRunner,
  before: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "snapshotIndexLease"
  >,
  parentLeafId: string | null,
  leafId: string | null,
): Promise<FinishAfterTurnResult> {
  let snapshot: SnapshotResult;
  let lease = before.snapshotIndexLease;
  if (lease) {
    snapshot = await createSnapshotCommitFromLease(git, lease, "omp-undo-redo: after turn");
    if (!("hash" in snapshot)) {
      // HEAD moved (or another failure occurred) since the turn began: the
      // retained alternate index is stale, so drop it and fall back to a fresh
      // snapshot whose index replaces it in the pool, sparing the next turn a
      // second full re-hash. No pool key means the lease was released meanwhile
      // (shutdown): nothing to retain then.
      const key = leasesInUse.get(lease);
      await releaseSnapshotIndexLease(lease);
      snapshot = await createSnapshotCommit(
        git,
        "omp-undo-redo: after turn",
        key !== undefined,
        before.repository.gitDir,
      );
      lease = "hash" in snapshot ? snapshot.snapshotIndexLease : undefined;
      if (lease && key !== undefined) leasesInUse.set(lease, key);
    }
    // On success the lease index now reflects the after-state and stays in the
    // persistent cache for the next turn's before snapshot.
  } else {
    snapshot = await createSnapshotCommit(
      git,
      "omp-undo-redo: after turn",
      false,
      before.repository.gitDir,
    );
  }
  const pending = { ...before, snapshotIndexLease: lease };
  if (!("hash" in snapshot)) {
    await releasePendingCheckpoint(git, pending);
    return {
      status: "session_only",
      reason: snapshot.reason === "invalid_head" ? "invalid_head" : "after_snapshot_failed",
    };
  }
  if (!(await pinBorrowedObjects(git, before.repository, snapshot.tree))) {
    await releasePendingCheckpoint(git, pending);
    return { status: "session_only", reason: "after_snapshot_failed" };
  }
  const afterRef = before.beforeRef.replace(/\/before$/, "/after");
  if (
    !(await run(
      git,
      ["update-ref", "-m", "omp-undo-redo: retain after checkpoint", afterRef, snapshot.hash],
      { env: storeEnv(before.repository) },
    ))
  ) {
    await releasePendingCheckpoint(git, pending);
    return { status: "session_only", reason: "after_ref_failed" };
  }
  await returnLeaseToPool(lease);
  return {
    status: "git",
    checkpoint: {
      kind: "git",
      repository: before.repository,
      beforeHash: before.beforeHash,
      beforeRef: before.beforeRef,
      afterHash: snapshot.hash,
      afterRef,
      parentLeafId,
      leafId,
    },
  };
}

export async function retainCheckpointForResume(
  git: GitRunner,
  sessionId: string,
  checkpoint: GitCheckpoint,
): Promise<GitCheckpoint> {
  const checkpointId = newCheckpointId();
  const prefix = `${historyRefPrefix(checkpointNamespace(sessionId))}${checkpointId}`;
  const beforeRef = `${prefix}/before`;
  const afterRef = `${prefix}/after`;
  const input = [
    `create ${beforeRef} ${checkpoint.beforeHash}`,
    `create ${afterRef} ${checkpoint.afterHash}`,
    `delete ${checkpoint.beforeRef} ${checkpoint.beforeHash}`,
    `delete ${checkpoint.afterRef} ${checkpoint.afterHash}`,
  ].join("\n");
  const retained = await invoke(git, ["update-ref", "--stdin"], {
    env: storeEnv(checkpoint.repository),
    stdin: `${input}\n`,
  });
  if (retained.code !== 0) return checkpoint;
  return { ...checkpoint, beforeRef, afterRef };
}

/** `nestedRepositories` and `unreadableFiles`: paths whose contents the
 *  restore could not touch, relative to the worktree root (see
 *  `pathsOutsideSnapshots`). */
export type CheckpointApplyResult =
  | { status: "applied"; nestedRepositories: string[]; unreadableFiles: string[] }
  | { status: "conflict" | "failed" };

/** Restore invocations get a far larger ceiling than the runner's default:
 *  diffing and applying a multi-GB binary change is slow but legitimate, and
 *  a killed `git apply` can leave the worktree half-written. The deadline
 *  exists only so a wedged child cannot hang the process forever. */
const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;

/** Paths of `paths` that `tree`'s own ignore rules exclude. The rules are
 *  materialized into a scratch worktree (`tree`'s `.gitignore` files only) so
 *  `check-ignore` evaluates them exactly as git would have when that tree was
 *  snapshotted, alongside the repository's `info/exclude` and global excludes. */
async function ignoredUnder(
  git: GitRunner,
  tree: string,
  paths: readonly string[],
  directory: string,
  label: string,
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const rules = join(directory, `${label}-rules`);
  await mkdir(rules);
  const env = { GIT_INDEX_FILE: join(directory, `${label}-index`), GIT_WORK_TREE: rules };
  if ((await invoke(git, ["read-tree", tree], { env })).code !== 0) return null;
  const files = await invoke(git, ["ls-files", "-z", "--", ":(glob)**/.gitignore"], { env });
  if (files.code !== 0) return null;
  if (files.stdout) {
    const written = await invoke(git, ["checkout-index", "-z", "--stdin"], {
      env,
      stdin: files.stdout,
    });
    if (written.code !== 0) return null;
  }
  const ignored = await invoke(git, ["check-ignore", "--no-index", "-z", "--stdin"], {
    env,
    stdin: paths.join("\0"),
  });
  if (ignored.error || (ignored.code !== 0 && ignored.code !== 1)) return null;
  return ignored.stdout.split("\0").filter(Boolean);
}

/** Snapshots omit ignored paths, so a path can be missing from a tree only
 *  because that tree's rules ignored it while the file stayed on disk.
 *  Restoring must leave such a path alone: deleting it destroys the user's
 *  ignored file (undoing a turn that un-ignored `.env`), and creating it
 *  collides with the file still on disk (redoing that turn). Returns the
 *  `--index-info` entries pinning those paths to their `sourceHash` state.
 *  Only a `.gitignore` change between the two trees can produce such a path,
 *  so every other restore costs one `diff-tree`. */
async function shieldIgnoredPaths(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  directory: string,
): Promise<string[] | null> {
  const changes = await invoke(git, ["diff-tree", "-r", "-z", sourceHash, targetHash], {
    timeoutMs: RESTORE_TIMEOUT_MS,
  });
  if (changes.error || changes.code !== 0) return null;
  // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  // The source mode/sha of an added path are zeros, which `--index-info` reads
  // as "remove", so one entry format pins both directions.
  const fields = changes.stdout.split("\0");
  const deleted = new Map<string, string>();
  const added = new Map<string, string>();
  let rulesChanged = false;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, , sourceSha, , status] = fields[index]!.slice(1).split(" ");
    const path = fields[index + 1]!;
    if (path === ".gitignore" || path.endsWith("/.gitignore")) rulesChanged = true;
    if (status === "D") deleted.set(path, `${sourceMode} ${sourceSha}`);
    else if (status === "A") added.set(path, `${sourceMode} ${sourceSha}`);
  }
  if (!rulesChanged || (deleted.size === 0 && added.size === 0)) return [];

  const keptOnDisk = await ignoredUnder(git, targetHash, [...deleted.keys()], directory, "target");
  const hiddenInSource = await ignoredUnder(
    git,
    sourceHash,
    [...added.keys()],
    directory,
    "source",
  );
  if (!keptOnDisk || !hiddenInSource) return null;
  const pinned = keptOnDisk.map((path) => `${deleted.get(path)}\t${path}\0`);
  if (hiddenInSource.length > 0) {
    const top = await invoke(git, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return null;
    const worktree = top.stdout.trim();
    for (const path of hiddenInSource) {
      // Absent on disk means nothing to collide with: let the patch create it.
      const onDisk = await lstat(join(worktree, path)).then(
        () => true,
        () => false,
      );
      if (onDisk) pinned.push(`${added.get(path)}\t${path}\0`);
    }
  }
  return pinned;
}

/** `targetHash` with `pins` (`--index-info -z` entries) applied, or
 *  `targetHash` itself when there is nothing to pin. */
async function pinnedTree(
  git: GitRunner,
  targetHash: string,
  pins: readonly string[],
  directory: string,
): Promise<string | null> {
  if (pins.length === 0) return targetHash;
  const env = { GIT_INDEX_FILE: join(directory, "pin-index") };
  if ((await invoke(git, ["read-tree", targetHash], { env })).code !== 0) return null;
  const updated = await invoke(git, ["update-index", "-z", "--index-info"], {
    env,
    stdin: pins.join(""),
  });
  if (updated.code !== 0) return null;
  const tree = await invoke(git, ["write-tree"], { env });
  const treeHash = tree.stdout.trim();
  return tree.code === 0 && treeHash ? treeHash : null;
}

interface SnapshotsOutside extends OutsideSnapshot {
  /** `--index-info -z` entries pinning every unreadable file to its source
   *  entry (a removal when the source has none). */
  unreadablePins: string[];
}

/** Paths neither commit holds the contents of. Nested repositories: gitlinks
 *  (a submodule or committed nested repository is recorded as its HEAD commit
 *  only, and `git apply` without an index skips gitlink hunks) plus the ones a
 *  snapshot left out for having no commit. Unreadable files: a snapshot's
 *  entry for one is stale or missing, so the restore must leave the file on
 *  disk alone. Null when a commit is unreadable. The listings are streamed,
 *  so memory stays bounded by what is kept, not by the tree's size.
 *  ponytail: lists every tree entry per restore; record gitlinks at capture
 *  time if undo in million-file trees gets slow. */
async function pathsOutsideSnapshots(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<SnapshotsOutside | null> {
  const nested = new Set<string>();
  const unreadable = new Set<string>();
  for (const commit of [sourceHash, targetHash]) {
    const object = await invoke(git, ["cat-file", "commit", commit]);
    if (object.error || object.code !== 0) return null;
    const message = object.stdout.slice(object.stdout.indexOf("\n\n") + 2);
    for (const line of message.split("\n")) {
      if (line.startsWith(NESTED_REPOSITORY_LINE)) {
        nested.add(line.slice(NESTED_REPOSITORY_LINE.length));
      } else if (line.startsWith(UNREADABLE_FILE_LINE)) {
        unreadable.add(line.slice(UNREADABLE_FILE_LINE.length));
      }
    }
  }
  const sourceEntries = new Map<string, string>();
  for (const commit of [sourceHash, targetHash]) {
    // Entries: "<mode> <type> <object>\t<path>", a format `--index-info` reads.
    let partial = "";
    const feed = (chunk: string) => {
      const entries = (partial + chunk).split("\0");
      partial = entries.pop()!;
      for (const entry of entries) {
        const path = entry.slice(entry.indexOf("\t") + 1);
        if (entry.startsWith("160000 ")) nested.add(path);
        if (commit === sourceHash && unreadable.has(path)) sourceEntries.set(path, entry);
      }
    };
    const tree = await invoke(git, ["ls-tree", "-r", "-z", "--full-tree", commit], {
      timeoutMs: RESTORE_TIMEOUT_MS,
      onStdout: feed,
    });
    if (tree.error || tree.code !== 0) return null;
    // A runner that ignores `onStdout` buffers instead; scanning twice is harmless.
    feed(`${tree.stdout}\0`);
  }
  // Mode 0 with an all-zero id of the repository's hash length removes a path.
  const removal = `0 ${"0".repeat(sourceHash.length)}`;
  return {
    nestedRepositories: [...nested].sort(),
    unreadableFiles: [...unreadable].sort(),
    unreadablePins: [...unreadable].map(
      (path) => `${sourceEntries.get(path) ?? `${removal}\t${path}`}\0`,
    ),
  };
}

/** Restores `targetHash`'s content over a worktree that currently matches
 *  `sourceHash`, via a patch instead of a checkout so the index is untouched.
 *  Nested repositories and unreadable files are outside the snapshots: the
 *  patch leaves them as they are, and an `applied` result lists them so the
 *  caller never reports their contents as restored. */
export async function applyCheckpoint(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<CheckpointApplyResult> {
  // Read first: failing after the patch landed would misreport a restore.
  const outside = await pathsOutsideSnapshots(git, sourceHash, targetHash);
  if (!outside) return { status: "failed" };
  const { nestedRepositories, unreadableFiles, unreadablePins } = outside;
  const status = await applyPatch(git, sourceHash, targetHash, unreadablePins);
  return status === "applied" ? { status, nestedRepositories, unreadableFiles } : { status };
}

/** `git apply` without an index first deletes every path it modifies, then
 *  writes them back, so a failed write (locked file, full disk, killed child)
 *  leaves paths missing and the rest at target content. Undoes exactly what
 *  apply did, from `sourceHash` through a scratch index: paths it removed,
 *  paths it wrote (content equals the target blob) and paths it created. A
 *  path still holding other content is left alone: `apply --check` accepts
 *  drift outside the hunks, and overwriting it would destroy that edit. The
 *  hash runs the clean filters because apply smudges what it writes (CRLF
 *  under `core.autocrlf`, LFS content), while tree blobs hold the cleaned form.
 *  Best effort: gitlinks are never touched by apply; a path with a newline in
 *  its name cannot be hashed; symlinks, typechanges and a directory sitting
 *  where a deleted file was are left as found. The hash-then-checkout window
 *  cannot be locked, so an edit landing inside it is overwritten. */
async function rollbackPartialApply(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  directory: string,
): Promise<void> {
  const worktree = git.cwd;
  if (!worktree) return;
  const timeoutMs = RESTORE_TIMEOUT_MS;
  const changes = await invoke(
    git,
    ["diff-tree", "-r", "-z", "--no-renames", sourceHash, targetHash],
    { timeoutMs },
  );
  if (changes.error || changes.code !== 0) return;

  // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  const restore: string[] = [];
  const written = new Map<string, string>();
  const fields = changes.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, targetMode, , targetSha, status] = fields[index]!.slice(1).split(" ");
    const path = fields[index + 1]!;
    if (sourceMode === "160000" || targetMode === "160000") continue;
    const present = await lstat(join(worktree, path)).catch(() => null);
    if (status === "A") {
      // `apply --check` proved the path absent, so anything there is apply's.
      if (present && !present.isDirectory()) {
        await rm(join(worktree, path), { force: true }).catch(() => undefined);
      }
    } else if (!present) {
      restore.push(path);
    } else if (status !== "D" && present.isFile() && !path.includes("\n")) {
      written.set(path, targetSha!);
    }
  }
  if (written.size > 0) {
    const paths = [...written.keys()];
    const hashed = await invoke(git, ["hash-object", "--stdin-paths"], {
      stdin: `${paths.join("\n")}\n`,
      timeoutMs,
    });
    if (hashed.code === 0 && !hashed.error) {
      const ids = hashed.stdout.split("\n");
      paths.forEach((path, index) => {
        if (ids[index] === written.get(path)) restore.push(path);
      });
    }
  }
  if (restore.length === 0) return;

  const env: Record<string, string> = { GIT_INDEX_FILE: join(directory, "rollback-index") };
  if (git.env?.GIT_DIR) env.GIT_WORK_TREE = worktree;
  if ((await invoke(git, ["read-tree", sourceHash], { env })).code !== 0) return;
  await invoke(git, ["checkout-index", "-f", "-z", "--stdin"], {
    env,
    stdin: restore.map((path) => `${path}\0`).join(""),
    timeoutMs,
  });
}

/** Every flag pins the plumbing contract against the user's own
 *  configuration, each of which otherwise kills restoration outright on that
 *  machine: `diff.noprefix`/`diff.srcPrefix`/`diff.dstPrefix` produce a patch
 *  `git apply -p1` cannot resolve; `color.diff=always` prefixes it with ANSI
 *  escapes ("No valid patches in input"); `diff.external` and textconv
 *  filters replace it with another program's output; `diff.submodule=log`
 *  replaces a gitlink hunk with a commit listing, which invalidates the whole
 *  patch; `diff.context=0` yields hunks `git apply` refuses without
 *  `--unidiff-zero`; `apply.whitespace=error` rejects content git itself
 *  snapshotted. */
async function applyPatch(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  unreadablePins: readonly string[],
): Promise<CheckpointApplyResult["status"]> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-patch-"));
    const patchPath = join(tempDirectory, "checkpoint.patch");
    const restore = { timeoutMs: RESTORE_TIMEOUT_MS };
    const ignoredPins = await shieldIgnoredPaths(git, sourceHash, targetHash, tempDirectory);
    if (!ignoredPins) return "failed";
    const effectiveTarget = await pinnedTree(
      git,
      targetHash,
      [...ignoredPins, ...unreadablePins],
      tempDirectory,
    );
    if (!effectiveTarget) return "failed";
    const diff = await invoke(
      git,
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--ignore-submodules=none",
        "--submodule=short",
        "-U3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--exit-code",
        "--binary",
        sourceHash,
        effectiveTarget,
        `--output=${patchPath}`,
      ],
      restore,
    );
    // A killed or unspawnable child also exits 1, which is `--exit-code`'s
    // "there were differences": without this the truncated patch `--output`
    // already wrote would be applied and reported as a complete restore.
    if (diff.error) return "failed";
    if (diff.code === 0) return "applied";
    if (diff.code !== 1) return "failed";

    const check = await invoke(git, ["apply", "--whitespace=nowarn", "--check", patchPath], {
      ...restore,
      env: { LC_ALL: "C" },
    });
    if (check.code !== 0) {
      if (check.error) return "failed";
      // `apply --check` failing does not prove the worktree drifted: a patch
      // git cannot parse fails identically. When the worktree still matches
      // the source snapshot, the patch is at fault — report that instead of
      // blaming the worktree and sending the user to clean an already clean
      // one.
      //
      // The probe runs against its own index seeded from `sourceHash`, never
      // the repository's: a private repo never writes its index at all (its
      // snapshots use alternates), so `git diff <commit>` there reports every
      // path as deleted, and a user's real index may carry staged adds or
      // deletes that are not worktree drift. `read-tree` records no stat data,
      // so the comparison must fall back to content — which is what
      // `diff.autoRefreshIndex` controls, hence pinning it.
      const probeEnv: Record<string, string> = {
        GIT_INDEX_FILE: join(tempDirectory, "probe-index"),
      };
      if (git.env?.GIT_DIR && git.cwd) probeEnv.GIT_WORK_TREE = git.cwd;
      const seeded = await invoke(git, ["read-tree", sourceHash], { env: probeEnv });
      if (seeded.error || seeded.code !== 0) return "failed";
      const tracked = await invoke(
        git,
        [
          "-c",
          "diff.autoRefreshIndex=true",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--quiet",
          sourceHash,
          "--",
        ],
        { env: probeEnv, timeoutMs: RESTORE_TIMEOUT_MS },
      );
      if (tracked.error) return "failed";
      if (tracked.code !== 0) return "conflict";
      if (check.stderr.includes("already exists in working directory")) return "conflict";
      return "failed";
    }

    const applied = await invoke(git, ["apply", "--whitespace=nowarn", patchPath], restore);
    if (applied.code === 0) return "applied";
    await rollbackPartialApply(git, sourceHash, effectiveTarget, tempDirectory).catch(
      () => undefined,
    );
    return "failed";
  } catch {
    return "failed";
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
