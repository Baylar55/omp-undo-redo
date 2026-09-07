export interface SessionEntryLike {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string };
  customType?: string;
}

export interface SessionReader {
  getLeafId(): string | null;
  getBranch(fromId?: string): SessionEntryLike[];
  getEntry(id: string): SessionEntryLike | undefined;
}

export const UNAVAILABLE_REASONS = [
  "git_unavailable",
  "not_repository",
  "repository_unresolvable",
  "invalid_head",
  "before_snapshot_failed",
  "before_ref_failed",
  "after_snapshot_failed",
  "after_ref_failed",
  "file_history_gap",
  "resumed_checkpoint_unavailable",
  "private_repository_unavailable",
] as const;

export type FileCheckpointUnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

export type TreeNavigationResult = {
  cancelled: boolean;
};

export type NavigationResult =
  | { status: "moved"; files: "restored" }
  | {
      status: "moved";
      files: "unavailable";
      reason: FileCheckpointUnavailableReason;
    }
  | { status: "empty" }
  | { status: "cancelled" }
  | { status: "git_failed"; failure: "conflict" | "failed" }
  | { status: "rollback_failed" };

export type ActionId = "undo" | "redo";

export interface ActionInvocationResult {
  id: ActionId;
  applied: boolean;
  token: string;
}

export interface RuntimeActionState {
  actions: Array<{ id: ActionId; enabled: boolean }>;
  sessionRevision: string;
  activeSessionLeaf: string | null;
  actionResult?: ActionInvocationResult;
}

export type CommandNavigationResult = NavigationResult | { status: "busy" } | { status: "closing" };

export interface NavigationPort extends SessionReader {
  navigateTree(targetId: string): Promise<TreeNavigationResult>;
}

export interface GitRunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
  timeoutMs?: number;
}

export type GitRunError = "unavailable" | "timeout";

export type OwnershipMode = "v2" | "legacy";

export type GitCommandResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: GitRunError;
};

export type GitRunner = ((args: string[], options?: GitRunOptions) => Promise<GitCommandResult>) & {
  cwd?: string;
  /** Fixed env merged into every invocation (set via createGitRunner's `env`). */
  env?: Record<string, string>;
};

export interface GitRepository {
  worktree: string;
  gitDir: string;
  commonDir: string;
  /** Set only by `ensurePrivateGitRepository`: this repository is the
   *  extension's own snapshot store, not the user's. Ownership is marked at
   *  construction because it can never be inferred from a shared map that
   *  holds user repositories too (gc/prune must never touch those). */
  private?: true;
}

export interface SnapshotIndexLease {
  directory: string;
  indexPath: string;
  headTree: string;
}

export interface GitCheckpoint {
  kind: "git";
  repository: GitRepository;
  beforeHash: string;
  beforeRef: string;
  afterHash: string;
  afterRef: string;
  parentLeafId: string | null;
  leafId: string | null;
}

export interface SessionOnlyCheckpoint {
  kind: "session";
  reason: FileCheckpointUnavailableReason;
  parentLeafId: string | null;
  leafId: string | null;
}

export type TurnCheckpoint = GitCheckpoint | SessionOnlyCheckpoint;

export interface NavigationState {
  checkpoints: TurnCheckpoint[];
  currentIndex: number;
}

export interface PendingGitCheckpoint {
  kind: "git";
  repository: GitRepository;
  beforeHash: string;
  beforeRef: string;
  checkpointId: string;
  snapshotIndexLease?: SnapshotIndexLease;
  parentLeafId: string | null;
}

export interface PendingSessionCheckpoint {
  kind: "session";
  reason: FileCheckpointUnavailableReason;
  parentLeafId: string | null;
}

export interface ExpirationTombstone {
  expired: true;
  sessionHash: string;
  expiredAt: string;
  reason: "age";
}

export type HistoryLoadResult =
  | { status: "loaded"; state: NavigationState }
  | { status: "expired" }
  | { status: "unavailable"; reason?: "missing" | "unusable" };

export type PendingTurnCheckpoint = PendingGitCheckpoint | PendingSessionCheckpoint;

export type GitRunnerFactory = (repository: GitRepository) => GitRunner;

/** Creates a runner bound to a worktree, optionally with a fixed environment
 *  (used for private per-workspace repositories that pin `GIT_DIR`). Distinct
 *  from `GitRunnerFactory`, which is keyed by an already-resolved repository. */
export type CwdGitRunnerFactory = (cwd: string, env?: Record<string, string>) => GitRunner;
