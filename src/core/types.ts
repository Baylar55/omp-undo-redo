export interface SessionEntryLike {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string };
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
  | "file_history_gap";

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

export interface NavigationPort extends SessionReader {
  navigateTree(targetId: string): Promise<TreeNavigationResult>;
}

export interface GitRunOptions {
  env?: Record<string, string | undefined>;
  stdin?: string;
}

export type GitRunner = ((
  args: string[],
  options?: GitRunOptions,
) => Promise<{
  stdout: string;
  stderr: string;
  code: number;
  error?: "unavailable";
}>) & {
  cwd?: string;
};

export interface GitRepository {
  worktree: string;
  gitDir: string;
  commonDir: string;
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

export interface PendingGitCheckpoint {
  kind: "git";
  repository: GitRepository;
  beforeHash: string;
  beforeRef: string;
  checkpointId: string;
  parentLeafId: string | null;
}

export interface PendingSessionCheckpoint {
  kind: "session";
  reason: FileCheckpointUnavailableReason;
  parentLeafId: string | null;
}

export type PendingTurnCheckpoint = PendingGitCheckpoint | PendingSessionCheckpoint;

export type GitRunnerFactory = (repository: GitRepository) => GitRunner;
