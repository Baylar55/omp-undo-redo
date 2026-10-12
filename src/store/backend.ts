import { createGitRunner } from "../infra/git-runner.js";
import { ensurePrivateGitRepository, refusedPrivateWorkspace } from "./private-store.js";
import { migrateLegacySnapshots } from "./maintenance/legacy.js";
import type {
  CwdGitRunnerFactory,
  DiscoveredRepository,
  GitRepository,
  GitRunner,
} from "../types.js";
import { canonicalCwd, storeRootDirectory } from "../infra/paths.js";
import { ensureGitSnapshotStore, snapshotRunnerEnv } from "./git-store.js";
import { resolveRepository } from "./discovery.js";

export type SessionOnlyReason =
  | "git_unavailable"
  | "repository_unresolvable"
  | "private_repository_unavailable"
  | "store_unavailable"
  | "unsafe_workspace";

export type FileBackend =
  | { kind: "git"; repository: GitRepository; git: GitRunner }
  | { kind: "session"; reason: SessionOnlyReason };

export function defaultGitRunnerFactory(cwd: string, env?: Record<string, string>): GitRunner {
  return createGitRunner(cwd, { env });
}

/** Per-controller snapshot-store state: a ready entry carries the repository
 *  and the store-bound runner, with `ready` resolving true once init
 *  completes; a `failure` entry records a failed Private-Git init so session
 *  fallback is reused without retrying. Keyed by canonical cwd (private) or
 *  worktree (git mode). */
type ActivePrivateRepoEntry = {
  repository?: GitRepository;
  git?: GitRunner;
  ready: Promise<boolean>;
};

export type PrivateRepoEntry = ActivePrivateRepoEntry;

function startPrivateRepo(
  canonical: string,
  gitRunnerFactory: CwdGitRunnerFactory,
): ActivePrivateRepoEntry {
  const storeRoot = storeRootDirectory();
  const entry: ActivePrivateRepoEntry = {
    repository: undefined,
    git: undefined,
    ready: Promise.resolve(false),
  };
  entry.ready = (async (): Promise<boolean> => {
    try {
      const repository = await ensurePrivateGitRepository(gitRunnerFactory, canonical, storeRoot);
      if (!repository) return false;
      entry.repository = repository;
      entry.git = gitRunnerFactory(canonical, { GIT_DIR: repository.gitDir });
      return true;
    } catch {
      return false;
    }
  })();
  return entry;
}

async function resolvePrivateGit(
  cwd: string,
  privateRepositories: Map<string, PrivateRepoEntry>,
  gitRunnerFactory: CwdGitRunnerFactory,
): Promise<{ repository: GitRepository; git: GitRunner } | null> {
  const canonical = canonicalCwd(cwd);
  let entry = privateRepositories.get(canonical);
  if (!entry) {
    entry = startPrivateRepo(canonical, gitRunnerFactory);
    privateRepositories.set(canonical, entry);
  }
  if ((await entry.ready) && entry.repository && entry.git) {
    return { repository: entry.repository, git: entry.git };
  }
  // Not cached: the next resolution tries again (a launch racing this one
  // for the store, or a store directory fixed meanwhile).
  if (privateRepositories.get(canonical) === entry) privateRepositories.delete(canonical);
  return null;
}

/** Git mode: binds the worktree to its snapshot store, moving any snapshots an
 *  earlier version left in the user's `.git` into it first. */
function startGitStore(
  found: DiscoveredRepository,
  gitRunnerFactory: CwdGitRunnerFactory,
): ActivePrivateRepoEntry {
  const entry: ActivePrivateRepoEntry = { ready: Promise.resolve(false) };
  entry.ready = (async (): Promise<boolean> => {
    try {
      const storeDir = await ensureGitSnapshotStore(gitRunnerFactory, found, storeRootDirectory());
      if (!storeDir) return false;
      const repository: GitRepository = { ...found, storeDir };
      await migrateLegacySnapshots(gitRunnerFactory(found.worktree), repository).catch(
        () => undefined,
      );
      entry.repository = repository;
      // Rooted at the worktree, not at `cwd`: `git apply` silently ignores
      // patched paths outside its working directory, so a session started in
      // a subdirectory would restore only that subtree and still report
      // success. (`diff.relative=true` truncates the patch the same way.)
      entry.git = gitRunnerFactory(found.worktree, snapshotRunnerEnv(repository));
      return true;
    } catch {
      return false;
    }
  })();
  return entry;
}

export async function resolveBackend(
  cwd: string,
  privateRepositories: Map<string, PrivateRepoEntry> = new Map(),
  gitRunnerFactory: CwdGitRunnerFactory = defaultGitRunnerFactory,
): Promise<FileBackend> {
  const git = gitRunnerFactory(cwd);
  const resolved = await resolveRepository(git);
  if ("repository" in resolved) {
    const found = resolved.repository;
    // Keyed by `repository.worktree`, not `repository.commonDir`: linked
    // worktrees of the same repository share commonDir (and its store), so
    // keying by commonDir would make the second worktree reuse the first's
    // runner and run git operations in the wrong directory.
    let entry = privateRepositories.get(found.worktree);
    if (!entry || !(await entry.ready) || entry.repository?.gitDir !== found.gitDir) {
      entry = startGitStore(found, gitRunnerFactory);
      privateRepositories.set(found.worktree, entry);
    }
    if ((await entry.ready) && entry.repository && entry.git) {
      return { kind: "git", repository: entry.repository, git: entry.git };
    }
    if (privateRepositories.get(found.worktree) === entry)
      privateRepositories.delete(found.worktree);
    return { kind: "session", reason: "store_unavailable" };
  }
  if (resolved.reason !== "not_repository") return { kind: "session", reason: resolved.reason };
  // Checked before any store exists: a refused workspace never gets one.
  if (refusedPrivateWorkspace(canonicalCwd(cwd)))
    return { kind: "session", reason: "unsafe_workspace" };
  const priv = await resolvePrivateGit(cwd, privateRepositories, gitRunnerFactory);
  return priv
    ? { kind: "git", repository: priv.repository, git: priv.git }
    : { kind: "session", reason: "private_repository_unavailable" };
}
