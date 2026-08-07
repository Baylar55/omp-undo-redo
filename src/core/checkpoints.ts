import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { CheckpointOwnerRegistry } from "./checkpoint-owners.js";
import type {
  FileCheckpointUnavailableReason,
  GitCheckpoint,
  GitRepository,
  GitRunner,
  OwnershipMode,
  PendingGitCheckpoint,
  SnapshotIndexLease,
  SessionReader,
} from "./types.js";

const GIT_AUTHOR = ["-c", "user.name=omp-undo-redo", "-c", "user.email=omp-undo-redo@local"];
const REF_ROOT = "refs/omp-undo-redo";
const WORKTREE_PATHSPEC = ":(top)";

export function checkpointNamespace(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function checkpointRefs(
  sessionId: string,
  checkpointId: string,
  ownership: OwnershipMode,
  ownerId?: string,
): { beforeRef: string; afterRef: string } {
  const prefix =
    ownership === "v2" && ownerId
      ? `${REF_ROOT}/v2/${ownerId}/${checkpointNamespace(sessionId)}/${checkpointId}`
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
  const worktreeResult = await invoke(git, ["rev-parse", "--show-toplevel"]);
  if (worktreeResult.error === "unavailable") return { reason: "git_unavailable" };
  const worktree = worktreeResult.code === 0 ? worktreeResult.stdout.trim() : "";
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

  const gitDirResult = await invoke(git, ["rev-parse", "--git-dir"]);
  const commonDirResult = await invoke(git, ["rev-parse", "--git-common-dir"]);
  if (gitDirResult.error === "unavailable" || commonDirResult.error === "unavailable") {
    return { reason: "git_unavailable" };
  }
  const gitDir = gitDirResult.code === 0 ? gitDirResult.stdout.trim() : "";
  const commonDir = commonDirResult.code === 0 ? commonDirResult.stdout.trim() : "";
  if (!gitDir || !commonDir) return { reason: "repository_unresolvable" };

  const canonicalWorktree = await canonicalPath(worktree, worktree);
  return {
    repository: {
      worktree: canonicalWorktree,
      gitDir: await canonicalPath(gitDir, canonicalWorktree),
      commonDir: await canonicalPath(commonDir, canonicalWorktree),
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

async function releaseSnapshotIndexLease(lease: SnapshotIndexLease | undefined): Promise<boolean> {
  if (!lease) return true;
  try {
    await rm(lease.directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function createSnapshotCommit(
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
    const added = await invoke(git, ["add", "-A", "--", WORKTREE_PATHSPEC], { env });
    if (added.code !== 0) return { reason: "snapshot_failed" };
    const tree = await invoke(git, ["write-tree"], { env });
    if (tree.code !== 0) return { reason: "snapshot_failed" };
    const treeHash = tree.stdout.trim();
    if (!treeHash) return { reason: "snapshot_failed" };
    const commit = await createCommitForTree(git, treeHash, message);
    if (!("hash" in commit)) return commit;
    if (retainIndex && seeded.status === "seeded") {
      const snapshotIndexLease = {
        directory: tempDirectory,
        indexPath,
        headTree: seeded.headTree,
      };
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
  const currentHead = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (currentHead.code !== 0 || currentHead.stdout.trim() !== lease.headTree) {
    return { reason: "snapshot_failed" };
  }

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
        "--name-only",
        "-z",
        `--output=${normalizationPath}`,
        lease.headTree,
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
          lease.headTree,
          `--pathspec-from-file=${normalizationPath}`,
          "--pathspec-file-nul",
        ],
        { env },
      );
      if (reset.code !== 0) return { reason: "snapshot_failed" };
    }

    const added = await invoke(git, ["add", "-A", "--", WORKTREE_PATHSPEC], { env });
    if (added.code !== 0) return { reason: "snapshot_failed" };
    const tree = await invoke(git, ["write-tree"], { env });
    const treeHash = tree.stdout.trim();
    if (tree.code !== 0 || !treeHash) return { reason: "snapshot_failed" };

    const verifiedHead = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
    if (verifiedHead.code !== 0 || verifiedHead.stdout.trim() !== lease.headTree) {
      return { reason: "snapshot_failed" };
    }
    return createCommitForTree(git, treeHash, message);
  } catch {
    return { reason: "snapshot_failed" };
  } finally {
    await rm(normalizationPath, { force: true }).catch(() => undefined);
  }
}

export interface RefRelease {
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

async function releaseRefBatch(
  git: GitRunner,
  refs: readonly Pick<RefRelease, "ref" | "expectedHash">[],
  repository?: GitRepository,
  timeoutMs?: number,
): Promise<boolean> {
  if (refs.length === 0) return true;
  const input = refs.map(({ ref, expectedHash }) => `delete ${ref} ${expectedHash}`).join("\n");
  const options = repository
    ? { env: { GIT_DIR: repository.commonDir }, stdin: `${input}\n`, timeoutMs }
    : { stdin: `${input}\n`, timeoutMs };
  try {
    const result = await git(["update-ref", "--stdin"], options);
    if (result.code === 0) return true;
    if (result.error === "timeout") return false;
  } catch {
    // Retry smaller batches below.
  }
  if (refs.length === 1) {
    return repository
      ? await releaseLooseRef(repository, refs[0].ref, refs[0].expectedHash)
      : false;
  }
  const midpoint = Math.ceil(refs.length / 2);
  const left = await releaseRefBatch(git, refs.slice(0, midpoint), repository, timeoutMs);
  const right = await releaseRefBatch(git, refs.slice(midpoint), repository, timeoutMs);
  return left && right;
}

export async function releaseRefs(
  gitForRepository: (repository: GitRepository) => GitRunner,
  refs: readonly RefRelease[],
): Promise<boolean> {
  const grouped = new Map<string, { repository: GitRepository; refs: RefRelease[] }>();
  for (const ref of refs) {
    const key = ref.repository.commonDir;
    const group = grouped.get(key);
    if (group) {
      group.refs.push(ref);
    } else {
      grouped.set(key, { repository: ref.repository, refs: [ref] });
    }
  }

  const results = await Promise.allSettled(
    [...grouped.values()].map(async ({ repository, refs: groupedRefs }) => {
      try {
        return await releaseRefBatch(gitForRepository(repository), groupedRefs, repository);
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

export async function releaseCheckpoint(
  git: GitRunner,
  checkpoint: GitCheckpoint,
): Promise<boolean> {
  return releaseRefs(
    () => git,
    [
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
    ],
  );
}

export async function releasePendingCheckpoint(
  git: GitRunner,
  pending: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "snapshotIndexLease"
  >,
): Promise<boolean> {
  const [releasedRef, releasedLease] = await Promise.all([
    releaseRefBatch(
      git,
      [{ ref: pending.beforeRef, expectedHash: pending.beforeHash }],
      pending.repository,
    ),
    releaseSnapshotIndexLease(pending.snapshotIndexLease),
  ]);
  return releasedRef && releasedLease;
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
  const checkpointId = randomUUID();
  const snapshot = await createSnapshotCommit(git, "omp-undo-redo: before turn", true);
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
    await releaseSnapshotIndexLease(snapshot.snapshotIndexLease);
    return {
      status: "session_only",
      reason: "before_ref_failed",
    };
  }
  return {
    status: "git",
    checkpoint: {
      kind: "git",
      repository: resolved.repository,
      beforeHash: snapshot.hash,
      beforeRef,
      checkpointId,
      ...(snapshot.snapshotIndexLease ? { snapshotIndexLease: snapshot.snapshotIndexLease } : {}),
      parentLeafId: null,
    },
  };
}

export async function finishAfterTurn(
  git: GitRunner,
  before: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "checkpointId" | "snapshotIndexLease"
  >,
  parentLeafId: string | null,
  leafId: string | null,
): Promise<FinishAfterTurnResult> {
  let snapshot: SnapshotResult;
  if (before.snapshotIndexLease) {
    try {
      snapshot = await createSnapshotCommitFromLease(
        git,
        before.snapshotIndexLease,
        "omp-undo-redo: after turn",
      );
    } finally {
      await releaseSnapshotIndexLease(before.snapshotIndexLease);
    }
    if (!("hash" in snapshot)) {
      snapshot = await createSnapshotCommit(git, "omp-undo-redo: after turn");
    }
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
  const checkpointId = randomUUID();
  const prefix = `${REF_ROOT}/history/${checkpointNamespace(sessionId)}/${checkpointId}`;
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

export type CheckpointApplyResult = "applied" | "conflict" | "failed";

export async function applyCheckpoint(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<CheckpointApplyResult> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-patch-"));
    const patchPath = join(tempDirectory, "checkpoint.patch");
    const diff = await git([
      "diff",
      "--exit-code",
      "--binary",
      sourceHash,
      targetHash,
      `--output=${patchPath}`,
    ]);
    if (diff.code === 0) return "applied";
    if (diff.code !== 1) return "failed";

    const check = await git(["apply", "--check", patchPath]);
    if (check.code !== 0) return "conflict";

    const applied = await git(["apply", patchPath]);
    return applied.code === 0 ? "applied" : "failed";
  } catch {
    return "failed";
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export function previousCheckpoint(ctx: SessionReader): string | null {
  const leafId = ctx.getLeafId();
  if (!leafId) return null;
  const entries = ctx.getBranch(leafId);
  const currentIndex = entries.findIndex((e) => e.id === leafId);
  for (let i = currentIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "user") return entry.id;
  }
  return null;
}
