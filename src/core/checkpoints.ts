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

type RepositoryResolution =
  | { repository: GitRepository }
  | { reason: "git_unavailable" | "not_repository" | "repository_unresolvable" };

async function resolveRepository(git: GitRunner): Promise<RepositoryResolution> {
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

type SnapshotResult = { hash: string } | { reason: "invalid_head" | "snapshot_failed" };

async function seedSnapshotIndex(
  git: GitRunner,
  env: Record<string, string>,
): Promise<"seeded" | "empty" | "invalid_head" | "failed"> {
  const headTree = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (headTree.code === 0 && headTree.stdout.trim()) {
    const seeded = await invoke(git, ["read-tree", headTree.stdout.trim()], { env });
    return seeded.code === 0 ? "seeded" : "failed";
  }
  if (headTree.error === "unavailable") return "failed";

  const symbolicHead = await invoke(git, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolicHead.code !== 0 || !symbolicHead.stdout.trim()) return "invalid_head";
  const branchRef = symbolicHead.stdout.trim();
  const branch = await invoke(git, ["show-ref", "--verify", "--quiet", branchRef]);
  if (branch.code === 0) return "invalid_head";
  if (branch.error === "unavailable") return "failed";

  const empty = await invoke(git, ["read-tree", "--empty"], { env });
  return empty.code === 0 ? "empty" : "failed";
}

async function createSnapshotCommit(git: GitRunner, message: string): Promise<SnapshotResult> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-index-"));
    const indexPath = join(tempDirectory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    const seeded = await seedSnapshotIndex(git, env);
    if (seeded === "invalid_head") return { reason: "invalid_head" };
    if (seeded === "failed") return { reason: "snapshot_failed" };
    const added = await invoke(git, ["add", "-A", "--", WORKTREE_PATHSPEC], { env });
    if (added.code !== 0) return { reason: "snapshot_failed" };
    const tree = await invoke(git, ["write-tree"], { env });
    if (tree.code !== 0) return { reason: "snapshot_failed" };
    const treeHash = tree.stdout.trim();
    if (!treeHash) return { reason: "snapshot_failed" };
    const commit = await invoke(git, [...GIT_AUTHOR, "commit-tree", treeHash, "-m", message]);
    if (commit.code !== 0) return { reason: "snapshot_failed" };
    const commitHash = commit.stdout.trim();
    return commitHash ? { hash: commitHash } : { reason: "snapshot_failed" };
  } catch {
    return { reason: "snapshot_failed" };
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
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
  pending: Pick<PendingGitCheckpoint, "repository" | "beforeHash" | "beforeRef">,
): Promise<boolean> {
  return releaseRefBatch(
    git,
    [{ ref: pending.beforeRef, expectedHash: pending.beforeHash }],
    pending.repository,
  );
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
  const snapshot = await createSnapshotCommit(git, "omp-undo-redo: before turn");
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
      parentLeafId: null,
    },
  };
}

export async function finishAfterTurn(
  git: GitRunner,
  before: Pick<PendingGitCheckpoint, "repository" | "beforeHash" | "beforeRef" | "checkpointId">,
  parentLeafId: string | null,
  leafId: string | null,
): Promise<FinishAfterTurnResult> {
  const snapshot = await createSnapshotCommit(git, "omp-undo-redo: after turn");
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
