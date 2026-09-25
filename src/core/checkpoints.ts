import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CheckpointOwnerRegistry } from "./checkpoint-owners.js";
import { deleteRefsBatched } from "./git-refs.js";
import type {
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

/** Commit-message line naming a nested repository a snapshot left out. */
const NESTED_REPOSITORY_LINE = "Nested repository outside snapshot: ";
const NO_COMMIT_ERROR = /^error: '(.+?)\/?' does not have a commit checked out$/;

/** Single spelling of the retained-history ref namespace. Takes an
 *  already-hashed session (`checkpointNamespace(sessionId)`), never a raw id. */
export const HISTORY_REF_ROOT = `${REF_ROOT}/history/`;
export function historyRefPrefix(sessionHash: string): string {
  return `${HISTORY_REF_ROOT}${sessionHash}/`;
}

// Alternate index reused across turns so each turn is not a full `git add -A`
// re-hash of the whole worktree. The first turn seeds it (a full `add -A` that
// records a valid stat cache); every later turn's before/after snapshot reuses
// it, so unchanged files are skipped via git's stat-dance instead of being
// re-read. Keyed by repository + session so concurrent sessions/repos stay
// isolated. The lease is dropped (and reseeded) whenever its baseline tree
// changes, and evicted whenever its directory is released. With an unborn HEAD
// there is no baseline commit, so the seeding snapshot's own tree is the
// baseline and the lease goes stale once HEAD becomes born.
const persistentSnapshotIndices = new Map<string, SnapshotIndexLease>();

function persistentIndexKey(repository: GitRepository, sessionId: string): string {
  return `${repository.worktree}\u0000${checkpointNamespace(sessionId)}`;
}

export async function releaseAllPersistentSnapshotIndices(): Promise<void> {
  const leases = [...persistentSnapshotIndices.values()];
  persistentSnapshotIndices.clear();
  await Promise.all(leases.map((lease) => releaseSnapshotIndexLease(lease)));
}

export function checkpointNamespace(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

/** Ref paths are loose files under `.git/refs/`, so on Windows the repository
 *  path plus the ref must fit MAX_PATH. `core.longpaths` is deliberately not
 *  forced: refs written past MAX_PATH are invisible to the user's own git, whose
 *  `gc` would then prune the snapshot objects. Hence 16-hex checkpoint ids
 *  (64 random bits) and no session hash in v2 refs. */
function newCheckpointId(): string {
  return randomBytes(8).toString("hex");
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

async function invoke(
  git: GitRunner,
  args: string[],
  options?: Parameters<GitRunner>[1],
): Promise<GitCommandResult> {
  try {
    return await git(args, options);
  } catch {
    return { stdout: "", stderr: "", code: 1, error: "unavailable" };
  }
}

async function run(git: GitRunner, args: string[]): Promise<boolean> {
  return (await invoke(git, args)).code === 0;
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
  | { repository: GitRepository }
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
  | { hash: string; snapshotIndexLease?: SnapshotIndexLease }
  | { reason: "invalid_head" | "snapshot_failed" };

type SeedSnapshotIndexResult =
  { status: "seeded"; headTree: string } | { status: "empty" | "invalid_head" | "failed" };

async function seedSnapshotIndex(
  git: GitRunner,
  env: Record<string, string>,
): Promise<SeedSnapshotIndexResult> {
  const headTree = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const hash = headTree.stdout.trim();
  if (headTree.code === 0 && hash) {
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
  return commitHash ? { hash: commitHash } : { reason: "snapshot_failed" };
}

/** A lease is usable only while its baseline still describes HEAD: the same
 *  HEAD tree for a born HEAD, and a still-unborn HEAD for an unborn lease. */
async function leaseBaselineCurrent(git: GitRunner, lease: SnapshotIndexLease): Promise<boolean> {
  const head = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (head.error === "unavailable") return false;
  const tree = head.code === 0 ? head.stdout.trim() : "";
  return lease.unborn ? tree === "" : tree === lease.baseTree;
}

/** Drops index entries that the current ignore rules exclude. Index-only: no
 *  worktree file is re-read, so the retained stat cache survives. */
async function pruneIgnoredEntries(git: GitRunner, env: Record<string, string>): Promise<boolean> {
  const ignored = await invoke(
    git,
    ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"],
    { env },
  );
  if (ignored.code !== 0) return false;
  if (!ignored.stdout) return true;
  const removed = await invoke(git, ["update-index", "--force-remove", "-z", "--stdin"], {
    env,
    stdin: ignored.stdout,
  });
  return removed.code === 0;
}

/** `git add -A` of the whole worktree. An embedded repository with no commit
 *  checked out cannot be recorded even as a gitlink, and would otherwise abort
 *  every snapshot — one `git init` in a subfolder would disable capture. Such
 *  repositories are left out and returned; any other error still fails the
 *  snapshot, since silently omitting an unreadable file would let a restore
 *  treat it as deleted. `LC_ALL=C` pins the message being matched. */
async function addWorktree(git: GitRunner, env: Record<string, string>): Promise<string[] | null> {
  const added = await invoke(git, ["add", "-A", "--ignore-errors", "--", WORKTREE_PATHSPEC], {
    env: { ...env, LC_ALL: "C" },
  });
  if (added.code === 0) return [];
  if (added.error || added.code !== 1) return null;
  const skipped: string[] = [];
  for (const line of added.stderr.split(/\r?\n/)) {
    const match = NO_COMMIT_ERROR.exec(line);
    if (match) skipped.push(match[1]!);
    else if (line.startsWith("error:") || line.startsWith("fatal:")) return null;
  }
  return skipped.length > 0 ? skipped : null;
}

function snapshotMessage(message: string, skipped: readonly string[]): string {
  if (skipped.length === 0) return message;
  return `${message}\n\n${skipped.map((path) => `${NESTED_REPOSITORY_LINE}${path}`).join("\n")}`;
}

async function releaseSnapshotIndexLease(lease: SnapshotIndexLease | undefined): Promise<boolean> {
  if (!lease) return true;
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

export async function createSnapshotCommit(
  git: GitRunner,
  message: string,
  retainIndex = false,
): Promise<SnapshotResult> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-index-"));
    const indexPath = join(tempDirectory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    const seeded = await seedSnapshotIndex(git, env);
    if (seeded.status === "invalid_head") return { reason: "invalid_head" };
    if (seeded.status === "failed") return { reason: "snapshot_failed" };
    const addEnv: Record<string, string> = { ...env };
    if (git.env?.GIT_DIR && git.cwd) addEnv.GIT_WORK_TREE = git.cwd;
    const skipped = await addWorktree(git, addEnv);
    if (!skipped) return { reason: "snapshot_failed" };
    const tree = await invoke(git, ["write-tree"], { env });
    if (tree.code !== 0) return { reason: "snapshot_failed" };
    const treeHash = tree.stdout.trim();
    if (!treeHash) return { reason: "snapshot_failed" };
    const commit = await createCommitForTree(git, treeHash, snapshotMessage(message, skipped));
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
      return { hash: commit.hash, snapshotIndexLease };
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

async function createSnapshotCommitFromLease(
  git: GitRunner,
  lease: SnapshotIndexLease,
  message: string,
): Promise<SnapshotResult> {
  if (!(await leaseBaselineCurrent(git, lease))) return { reason: "snapshot_failed" };

  const normalizationPath = join(lease.directory, `normalize-${randomUUID()}.nul`);
  const env = { GIT_INDEX_FILE: lease.indexPath };
  try {
    const differences = await invoke(
      git,
      [
        "diff-index",
        "--cached",
        "--no-renames",
        // Added entries are normalized away only for a real HEAD baseline, where
        // `reset` restores a tracked path cheaply. An unborn baseline never grows,
        // so every file created during the session would be flagged `A` and
        // re-hashed each turn; `pruneIgnoredEntries` covers the one case the drop
        // exists for (a staged path that later became ignored).
        `--diff-filter=${lease.unborn ? "DT" : "ADT"}`,
        "--name-only",
        "-z",
        `--output=${normalizationPath}`,
        lease.baseTree,
        "--",
      ],
      { env },
    );
    if (differences.code !== 0) return { reason: "snapshot_failed" };

    const normalization = await stat(normalizationPath);
    if (normalization.size > 0) {
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
    const skipped = await addWorktree(git, addEnv);
    if (!skipped) return { reason: "snapshot_failed" };
    // An unborn baseline's fresh equivalent is `read-tree --empty` + `add -A`,
    // which never holds an ignored path. `add -A` cannot drop an entry that
    // became ignored after it was staged, so prune those explicitly.
    if (lease.unborn && !(await pruneIgnoredEntries(git, addEnv))) {
      return { reason: "snapshot_failed" };
    }
    const tree = await invoke(git, ["write-tree"], { env });
    const treeHash = tree.stdout.trim();
    if (tree.code !== 0 || !treeHash) return { reason: "snapshot_failed" };

    if (!(await leaseBaselineCurrent(git, lease))) return { reason: "snapshot_failed" };
    return createCommitForTree(git, treeHash, snapshotMessage(message, skipped));
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
  const path = join(repository.commonDir, ref);
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
    const list = grouped.get(ref.repository.commonDir);
    if (list) list.push(ref);
    else grouped.set(ref.repository.commonDir, [ref]);
  }
  const results = await Promise.allSettled(
    [...grouped.values()].map(async (groupedRefs) => {
      // Each group has at least one ref, so the head carries the repository.
      const { repository } = groupedRefs[0];
      try {
        const outcome = await deleteRefsBatched(gitForRepository(repository), groupedRefs, {
          env: { GIT_DIR: repository.commonDir },
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

export async function releasePendingCheckpoint(
  git: GitRunner,
  pending: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "snapshotIndexLease"
  >,
): Promise<boolean> {
  const [releasedRef, releasedLease] = await Promise.all([
    deleteRefsBatched(git, [{ ref: pending.beforeRef, expectedHash: pending.beforeHash }], {
      env: { GIT_DIR: pending.repository.commonDir },
      onSingleFailure: ({ ref, expectedHash }) =>
        releaseLooseRef(pending.repository, ref, expectedHash),
    }),
    releaseSnapshotIndexLease(pending.snapshotIndexLease),
  ]);
  return releasedRef === "ok" && releasedLease;
}

export type PrepareBeforeTurnResult =
  | { status: "git"; checkpoint: PendingGitCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

export type FinishAfterTurnResult =
  | { status: "git"; checkpoint: GitCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

export async function prepareBeforeTurn(
  git: GitRunner,
  sessionId: string,
  ownerRegistry?: CheckpointOwnerRegistry,
): Promise<PrepareBeforeTurnResult> {
  const resolved = await resolveRepository(git);
  if ("reason" in resolved) return { status: "session_only", reason: resolved.reason };

  const ownership = ownerRegistry
    ? await ownerRegistry.ensureInitialized(resolved.repository, git)
    : "legacy";
  const checkpointId = newCheckpointId();
  const indexKey = persistentIndexKey(resolved.repository, sessionId);
  const priorLease = persistentSnapshotIndices.get(indexKey);
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
      snapshot = await createSnapshotCommit(git, "omp-undo-redo: before turn", true);
      if ("hash" in snapshot) lease = snapshot.snapshotIndexLease;
    }
  } else {
    snapshot = await createSnapshotCommit(git, "omp-undo-redo: before turn", true);
    if ("hash" in snapshot) lease = snapshot.snapshotIndexLease;
  }
  if (!("hash" in snapshot)) {
    return {
      status: "session_only",
      reason: snapshot.reason === "invalid_head" ? "invalid_head" : "before_snapshot_failed",
    };
  }
  const { beforeRef } = checkpointRefs(sessionId, checkpointId, ownership, ownerRegistry?.ownerId);
  if (
    !(await run(git, [
      "update-ref",
      "-m",
      "omp-undo-redo: retain before checkpoint",
      beforeRef,
      snapshot.hash,
    ]))
  ) {
    await releaseSnapshotIndexLease(lease);
    return {
      status: "session_only",
      reason: "before_ref_failed",
    };
  }
  if (lease) persistentSnapshotIndices.set(indexKey, lease);
  return {
    status: "git",
    checkpoint: {
      kind: "git",
      repository: resolved.repository,
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
  if (before.snapshotIndexLease) {
    const lease = before.snapshotIndexLease;
    snapshot = await createSnapshotCommitFromLease(git, lease, "omp-undo-redo: after turn");
    if (!("hash" in snapshot)) {
      // HEAD moved (or another failure occurred) since the turn began: the
      // retained alternate index is stale, so drop it and fall back to a fresh
      // snapshot. The next turn will reseed the persistent index from HEAD.
      await releaseSnapshotIndexLease(lease);
      snapshot = await createSnapshotCommit(git, "omp-undo-redo: after turn");
    }
    // On success the lease index now reflects the after-state and stays in the
    // persistent cache for the next turn's before snapshot.
  } else {
    snapshot = await createSnapshotCommit(git, "omp-undo-redo: after turn");
  }
  if (!("hash" in snapshot)) {
    await releasePendingCheckpoint(git, before);
    return {
      status: "session_only",
      reason: snapshot.reason === "invalid_head" ? "invalid_head" : "after_snapshot_failed",
    };
  }
  const afterRef = before.beforeRef.replace(/\/before$/, "/after");
  if (
    !(await run(git, [
      "update-ref",
      "-m",
      "omp-undo-redo: retain after checkpoint",
      afterRef,
      snapshot.hash,
    ]))
  ) {
    await releasePendingCheckpoint(git, before);
    return { status: "session_only", reason: "after_ref_failed" };
  }
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
  const retained = await invoke(git, ["update-ref", "--stdin"], { stdin: `${input}\n` });
  if (retained.code !== 0) return checkpoint;
  return { ...checkpoint, beforeRef, afterRef };
}

/** `nestedRepositories`: repositories whose contents the restore could not
 *  touch, relative to the worktree root (see `nestedRepositoriesOutside`). */
export type CheckpointApplyResult =
  { status: "applied"; nestedRepositories: string[] } | { status: "conflict" | "failed" };

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
 *  collides with the file still on disk (redoing that turn). Returns a tree
 *  equal to `targetHash` with those paths pinned to their `sourceHash` state,
 *  or `targetHash` itself when nothing needs pinning. Only a `.gitignore`
 *  change between the two trees can produce such a path, so every other
 *  restore costs one `diff-tree`. */
async function shieldIgnoredPaths(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  directory: string,
): Promise<string | null> {
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
  if (!rulesChanged || (deleted.size === 0 && added.size === 0)) return targetHash;

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
  if (pinned.length === 0) return targetHash;

  const env = { GIT_INDEX_FILE: join(directory, "shield-index") };
  if ((await invoke(git, ["read-tree", targetHash], { env })).code !== 0) return null;
  const updated = await invoke(git, ["update-index", "-z", "--index-info"], {
    env,
    stdin: pinned.join(""),
  });
  if (updated.code !== 0) return null;
  const tree = await invoke(git, ["write-tree"], { env });
  const treeHash = tree.stdout.trim();
  return tree.code === 0 && treeHash ? treeHash : null;
}

/** Nested repositories whose contents none of `commits` hold: gitlinks (a
 *  submodule or committed nested repository is recorded as its HEAD commit
 *  only, and `git apply` without an index skips gitlink hunks) plus the ones a
 *  snapshot left out for having no commit. Null when a commit is unreadable.
 *  ponytail: lists every tree entry per restore; record gitlinks at capture
 *  time if undo in million-file trees gets slow. */
async function nestedRepositoriesOutside(
  git: GitRunner,
  commits: readonly string[],
): Promise<string[] | null> {
  const paths = new Set<string>();
  for (const commit of commits) {
    const tree = await invoke(git, ["ls-tree", "-r", "-z", "--full-tree", commit], {
      timeoutMs: RESTORE_TIMEOUT_MS,
    });
    const object = await invoke(git, ["cat-file", "commit", commit]);
    if (tree.error || tree.code !== 0 || object.error || object.code !== 0) return null;
    // Entries: "<mode> <type> <object>\t<path>".
    for (const entry of tree.stdout.split("\0")) {
      if (entry.startsWith("160000 ")) paths.add(entry.slice(entry.indexOf("\t") + 1));
    }
    const message = object.stdout.slice(object.stdout.indexOf("\n\n") + 2);
    for (const line of message.split("\n")) {
      if (line.startsWith(NESTED_REPOSITORY_LINE)) {
        paths.add(line.slice(NESTED_REPOSITORY_LINE.length));
      }
    }
  }
  return [...paths].sort();
}

/** Restores `targetHash`'s content over a worktree that currently matches
 *  `sourceHash`, via a patch instead of a checkout so the index is untouched.
 *  Nested repositories are outside every snapshot: an `applied` result lists
 *  them so the caller never reports their contents as restored. */
export async function applyCheckpoint(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<CheckpointApplyResult> {
  // Read first: failing after the patch landed would misreport a restore.
  const nestedRepositories = await nestedRepositoriesOutside(git, [sourceHash, targetHash]);
  if (!nestedRepositories) return { status: "failed" };
  const status = await applyPatch(git, sourceHash, targetHash);
  return status === "applied" ? { status, nestedRepositories } : { status };
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
): Promise<CheckpointApplyResult["status"]> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-patch-"));
    const patchPath = join(tempDirectory, "checkpoint.patch");
    const restore = { timeoutMs: RESTORE_TIMEOUT_MS };
    const effectiveTarget = await shieldIgnoredPaths(git, sourceHash, targetHash, tempDirectory);
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
    return applied.code === 0 ? "applied" : "failed";
  } catch {
    return "failed";
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
