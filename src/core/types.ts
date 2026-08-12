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

export type FileCheckpointUnavailableReason =
  | "git_unavailable"
  | "not_repository"
  | "repository_unresolvable"
  | "invalid_head"
  | "before_snapshot_failed"
  | "before_ref_failed"
  | "after_snapshot_failed"
  | "after_ref_failed"
  | "file_history_gap"
  | "resumed_checkpoint_unavailable"
  | "workspace_unresolvable"
  | "before_blob_failed"
  | "after_blob_failed"
  | "blob_apply_failed"
  | "history_expired";

export type TreeNavigationResult = {
  cancelled: boolean;
};

export type NavigationResult =
  | { status: "moved"; files: "restored" | "partially_restored" }
  | {
      status: "moved";
      files: "unavailable";
      reason: FileCheckpointUnavailableReason;
    }
  | { status: "empty" }
  | { status: "cancelled" }
  | { status: "git_failed"; failure: "conflict" | "failed" }
  | { status: "blob_failed"; failure: "conflict" | "failed" }
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
};

export interface GitRepository {
  worktree: string;
  gitDir: string;
  commonDir: string;
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

export interface BlobCheckpoint {
  kind: "blob";
  workspaceRoot: string;
  sessionHash: string;
  checkpointId: string;
  beforeTreeId: string;
  afterTreeId: string;
  parentLeafId: string | null;
  leafId: string | null;
}

export interface SessionOnlyCheckpoint {
  kind: "session";
  reason: FileCheckpointUnavailableReason;
  parentLeafId: string | null;
  leafId: string | null;
}

export type TurnCheckpoint = GitCheckpoint | BlobCheckpoint | SessionOnlyCheckpoint;

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

export interface PendingBlobCheckpoint {
  kind: "blob";
  workspaceRoot: string;
  sessionHash: string;
  checkpointId: string;
  beforeTreeId: string;
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
  reason: "age" | "storage_cap";
}

export type HistoryLoadResult =
  | { status: "loaded"; state: NavigationState }
  | { status: "expired"; reason: "age" | "storage_cap" }
  | { status: "unavailable" };

export type PendingTurnCheckpoint =
  PendingGitCheckpoint | PendingBlobCheckpoint | PendingSessionCheckpoint;

export type GitRunnerFactory = (repository: GitRepository) => GitRunner;
