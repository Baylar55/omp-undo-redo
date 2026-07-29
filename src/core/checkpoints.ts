import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  PendingCheckpoint,
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
): { beforeRef: string; afterRef: string } {
  const prefix = `${REF_ROOT}/${checkpointNamespace(sessionId)}/${checkpointId}`;
  return { beforeRef: `${prefix}/before`, afterRef: `${prefix}/after` };
}

async function run(git: GitRunner, args: string[]): Promise<boolean> {
  try {
    return (await git(args)).code === 0;
  } catch {
    return false;
  }
}

async function output(git: GitRunner, args: string[]): Promise<string | null> {
  try {
    const result = await git(args);
    if (result.code !== 0) return null;
    const value = result.stdout.trim();
    return value || null;
  } catch {
    return null;
  }
}

async function canonicalPath(value: string, base: string): Promise<string> {
  const absolute = isAbsolute(value) ? value : resolve(base, value);
  try {
    return await realpath(absolute);
  } catch {
    return absolute;
  }
}

async function resolveRepository(git: GitRunner): Promise<GitRepository | null> {
  const worktree = await output(git, ["rev-parse", "--show-toplevel"]);
  const gitDir = await output(git, ["rev-parse", "--git-dir"]);
  const commonDir = await output(git, ["rev-parse", "--git-common-dir"]);
  if (!worktree || !gitDir || !commonDir) return null;
  const canonicalWorktree = await canonicalPath(worktree, worktree);
  return {
    worktree: canonicalWorktree,
    gitDir: await canonicalPath(gitDir, canonicalWorktree),
    commonDir: await canonicalPath(commonDir, canonicalWorktree),
  };
}

async function createSnapshotCommit(git: GitRunner, message: string): Promise<string | null> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-index-"));
  const indexPath = join(tempDirectory, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  try {
    const seeded = await git(["read-tree", "HEAD"], { env });
    if (seeded.code !== 0) return null;
    const added = await git(["add", "-A", "--", WORKTREE_PATHSPEC], { env });
    if (added.code !== 0) return null;
    const tree = await git(["write-tree"], { env });
    if (tree.code !== 0) return null;
    const treeHash = tree.stdout.trim();
    if (!treeHash) return null;
    const commit = await git([...GIT_AUTHOR, "commit-tree", treeHash, "-m", message]);
    if (commit.code !== 0) return null;
    const commitHash = commit.stdout.trim();
    return commitHash || null;
  } catch {
    return null;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function releaseRef(git: GitRunner, ref: string, hash: string): Promise<boolean> {
  return run(git, ["update-ref", "-d", ref, hash]);
}

export async function releaseCheckpoint(
  git: GitRunner,
  checkpoint: GitCheckpoint,
): Promise<boolean> {
  const before = await releaseRef(git, checkpoint.beforeRef, checkpoint.beforeHash);
  const after = await releaseRef(git, checkpoint.afterRef, checkpoint.afterHash);
  return before && after;
}

export async function releasePendingCheckpoint(
  git: GitRunner,
  pending: Pick<PendingCheckpoint, "beforeHash" | "beforeRef">,
): Promise<boolean> {
  return releaseRef(git, pending.beforeRef, pending.beforeHash);
}

export async function prepareBeforeTurn(
  git: GitRunner,
  sessionId: string,
): Promise<PendingCheckpoint | null> {
  const repository = await resolveRepository(git);
  if (!repository) return null;
  const head = await output(git, ["rev-parse", "HEAD"]);
  if (!head) return null;

  const checkpointId = randomUUID();
  const beforeHash = await createSnapshotCommit(git, "omp-undo-redo: before turn");
  if (!beforeHash) return null;
  const beforeRef = checkpointRefs(sessionId, checkpointId).beforeRef;
  if (
    !(await run(git, [
      "update-ref",
      "-m",
      "omp-undo-redo: retain before checkpoint",
      beforeRef,
      beforeHash,
    ]))
  ) {
    return null;
  }
  return { repository, beforeHash, beforeRef, checkpointId, parentLeafId: null };
}

export async function finishAfterTurn(
  git: GitRunner,
  before: Pick<PendingCheckpoint, "repository" | "beforeHash" | "beforeRef" | "checkpointId">,
  parentLeafId: string | null,
  leafId: string | null,
): Promise<GitCheckpoint | null> {
  const afterHash = await createSnapshotCommit(git, "omp-undo-redo: after turn");
  if (!afterHash) {
    await releasePendingCheckpoint(git, before);
    return null;
  }
  const afterRef = before.beforeRef.replace(/\/before$/, "/after");
  if (
    !(await run(git, [
      "update-ref",
      "-m",
      "omp-undo-redo: retain after checkpoint",
      afterRef,
      afterHash,
    ]))
  ) {
    await releasePendingCheckpoint(git, before);
    return null;
  }
  return {
    repository: before.repository,
    beforeHash: before.beforeHash,
    beforeRef: before.beforeRef,
    afterHash,
    afterRef,
    parentLeafId,
    leafId,
  };
}

export type CheckpointApplyResult = "applied" | "conflict" | "failed";

export async function applyCheckpoint(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<CheckpointApplyResult> {
  const tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-patch-"));
  const patchPath = join(tempDirectory, "checkpoint.patch");
  try {
    const diff = await git(["diff", "--binary", sourceHash, targetHash, `--output=${patchPath}`]);
    if (diff.code !== 0) return "failed";

    const check = await git(["apply", "--check", patchPath]);
    if (check.code !== 0) return "conflict";

    const applied = await git(["apply", patchPath]);
    return applied.code === 0 ? "applied" : "failed";
  } catch {
    return "failed";
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
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
