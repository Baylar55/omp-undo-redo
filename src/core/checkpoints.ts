import type { GitCheckpoint, GitRunner, SessionReader } from "./types.js";

const GIT_AUTHOR = ["-c", "user.name=omp-undo-redo", "-c", "user.email=omp-undo-redo@local"];

async function commitCheckpoint(git: GitRunner, message: string): Promise<string | null> {
  try {
    const add = await git(["add", "-A"]);
    if (add.code !== 0) return null;
    const commit = await git([...GIT_AUTHOR, "commit", "--allow-empty", "-m", message]);
    if (commit.code !== 0) return null;
    const hash = await git(["rev-parse", "HEAD"]);
    return hash.code === 0 ? hash.stdout.trim() : null;
  } catch {
    return null;
  }
}

export async function prepareBeforeTurn(
  git: GitRunner,
): Promise<{ baseHash: string; beforeHash: string } | null> {
  try {
    const base = await git(["rev-parse", "HEAD"]);
    if (base.code !== 0) return null;
    const baseHash = base.stdout.trim();
    const beforeHash = await commitCheckpoint(git, "omp-undo-redo: before turn");
    if (!beforeHash) return null;
    const reset = await git(["reset", baseHash]);
    return reset.code === 0 ? { baseHash, beforeHash } : null;
  } catch {
    return null;
  }
}

export async function finishAfterTurn(
  git: GitRunner,
  before: { baseHash: string; beforeHash: string },
  parentLeafId: string | null,
  leafId: string | null,
): Promise<GitCheckpoint | null> {
  const afterHash = await commitCheckpoint(git, "omp-undo-redo: after turn");
  if (!afterHash) return null;
  const reset = await git(["reset", before.baseHash]);
  if (reset.code !== 0) return null;
  return { ...before, afterHash, parentLeafId, leafId };
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
