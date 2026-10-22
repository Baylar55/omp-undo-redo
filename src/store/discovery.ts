import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { DiscoveredRepository, GitRunner } from "../types.js";
import { invoke } from "../infra/git-runner.js";

export async function canonicalPath(value: string, base: string): Promise<string> {
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
  const result = await invoke(
    git,
    ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    // Pins the "not a git repository" message matched below.
    { env: { LC_ALL: "C" } },
  );
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
      // Only git's own verdict means "outside any repository": any other failure
      // (timeout, dubious ownership, unreadable config) may hide an enclosing
      // repository whose .gitignore a Private-Git snapshot would not honor.
      const outside =
        result.code !== 0 && !result.error && /not a git repository/i.test(result.stderr);
      return { reason: outside ? "not_repository" : "repository_unresolvable" };
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
