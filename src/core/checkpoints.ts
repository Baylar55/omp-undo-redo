import type { GitRunner, SessionReader } from "./types.js";

const COMMIT_PREFIX = "omp-undo:";

const GIT_AUTHOR = [
  "-c", "user.name=omp-undo",
  "-c", "user.email=omp-undo@local",
];

function gitCommit(git: GitRunner, message: string) {
  return git([...GIT_AUTHOR, "commit", "--allow-empty", "-m", message]);
}

export function previousCheckpoint(ctx: SessionReader): string | null {
  const leafId = ctx.getLeafId();
  if (!leafId) return null;
  const entries = ctx.getBranch(leafId);
  const currentIndex = entries.findIndex((e) => e.id === leafId);
  for (let i = currentIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "user") {
      return entry.id;
    }
  }
  return null;
}

export async function captureInitialState(git: GitRunner): Promise<string | null> {
  try {
    const add = await git(["add", "-A"]);
    if (add.code !== 0) return null;
    const commit = await gitCommit(git, `${COMMIT_PREFIX} initial`);
    if (commit.code !== 0) return null;
    const hash = await git(["rev-parse", "HEAD"]);
    if (hash.code !== 0) return null;
    return hash.stdout.trim();
  } catch {
    return null;
  }
}

export async function capturePostTurnCheckpoint(
  git: GitRunner,
  turnIndex: number,
): Promise<string | null> {
  try {
    const add = await git(["add", "-A"]);
    if (add.code !== 0) return null;
    const commit = await gitCommit(git, `${COMMIT_PREFIX} turn ${turnIndex}`);
    if (commit.code !== 0) return null;
    const hash = await git(["rev-parse", "HEAD"]);
    if (hash.code !== 0) return null;
    return hash.stdout.trim();
  } catch {
    return null;
  }
}

export async function restoreToCheckpoint(git: GitRunner, commitHash: string): Promise<boolean> {
  try {
    const reset = await git(["reset", "--hard", commitHash]);
    return reset.code === 0;
  } catch {
    return false;
  }
}
