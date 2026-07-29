import { createHash, randomUUID } from "node:crypto";
import type { GitCheckpoint, GitRunner, SessionReader } from "./types.js";

const GIT_AUTHOR = ["-c", "user.name=omp-undo-redo", "-c", "user.email=omp-undo-redo@local"];
const REF_ROOT = "refs/omp-undo-redo";

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

async function commitCheckpoint(git: GitRunner, message: string): Promise<string | null> {
  try {
    const add = await git(["add", "-A"]);
    if (add.code !== 0) return null;
    const commit = await git([...GIT_AUTHOR, "commit", "--allow-empty", "-m", message]);
    if (commit.code !== 0) return null;
    const hash = await git(["rev-parse", "HEAD"]);
    const value = hash.stdout.trim();
    return hash.code === 0 && value ? value : null;
  } catch {
    return null;
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
  pending: { beforeHash: string; beforeRef: string },
): Promise<boolean> {
  return releaseRef(git, pending.beforeRef, pending.beforeHash);
}

export async function prepareBeforeTurn(
  git: GitRunner,
  sessionId: string,
): Promise<{
  baseHash: string;
  beforeHash: string;
  beforeRef: string;
  checkpointId: string;
} | null> {
  let baseHash: string | null = null;
  let beforeHash: string | null = null;
  let beforeRef: string | null = null;
  let protectedCheckpoint = false;
  try {
    const base = await git(["rev-parse", "HEAD"]);
    if (base.code !== 0 || !(baseHash = base.stdout.trim())) return null;
    const checkpointId = randomUUID();
    beforeHash = await commitCheckpoint(git, "omp-undo-redo: before turn");
    if (!beforeHash) return null;
    beforeRef = checkpointRefs(sessionId, checkpointId).beforeRef;
    if (
      !(await run(git, [
        "update-ref",
        "-m",
        "omp-undo-redo: retain before checkpoint",
        beforeRef,
        beforeHash,
      ]))
    )
      return null;
    if (!(await run(git, ["reset", baseHash]))) return null;
    protectedCheckpoint = true;
    return { baseHash, beforeHash, beforeRef, checkpointId };
  } finally {
    if (baseHash && !protectedCheckpoint) {
      await run(git, ["reset", baseHash]);
      if (beforeHash && beforeRef) await releaseRef(git, beforeRef, beforeHash);
    }
  }
}
export async function finishAfterTurn(
  git: GitRunner,
  before: { baseHash: string; beforeHash: string; beforeRef: string; checkpointId: string },
  parentLeafId: string | null,
  leafId: string | null,
): Promise<GitCheckpoint | null> {
  let afterHash: string | null = null;
  let afterRef: string | null = null;
  let protectedCheckpoint = false;
  try {
    afterHash = await commitCheckpoint(git, "omp-undo-redo: after turn");
    if (!afterHash) return null;
    afterRef = before.beforeRef.replace(/\/before$/, "/after");
    if (
      !(await run(git, [
        "update-ref",
        "-m",
        "omp-undo-redo: retain after checkpoint",
        afterRef,
        afterHash,
      ]))
    )
      return null;
    if (!(await run(git, ["reset", before.baseHash]))) return null;
    protectedCheckpoint = true;
    return {
      baseHash: before.baseHash,
      beforeHash: before.beforeHash,
      beforeRef: before.beforeRef,
      afterHash,
      afterRef,
      parentLeafId,
      leafId,
    };
  } finally {
    await run(git, ["reset", before.baseHash]);
    if (!protectedCheckpoint) {
      await releaseRef(git, before.beforeRef, before.beforeHash);
      if (afterHash && afterRef) await releaseRef(git, afterRef, afterHash);
    }
  }
}

export async function restoreCheckpoint(
  git: GitRunner,
  checkpoint: GitCheckpoint,
  commitHash: string,
): Promise<boolean> {
  try {
    const restore = await git(["reset", "--hard", commitHash]);
    if (restore.code !== 0) return false;
    const reset = await git(["reset", checkpoint.baseHash]);
    return reset.code === 0;
  } catch {
    return false;
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
