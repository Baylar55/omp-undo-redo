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

export interface NavigationResult {
  cancelled: boolean;
}

export interface NavigationPort extends SessionReader {
  navigateTree(targetId: string): Promise<NavigationResult>;
}

export interface GitRunOptions {
  env?: Record<string, string | undefined>;
}

export type GitRunner = (
  args: string[],
  options?: GitRunOptions,
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface GitRepository {
  worktree: string;
  gitDir: string;
  commonDir: string;
}

export interface GitCheckpoint {
  repository: GitRepository;
  beforeHash: string;
  beforeRef: string;
  afterHash: string;
  afterRef: string;
  parentLeafId: string | null;
  leafId: string | null;
}

export interface PendingCheckpoint {
  repository: GitRepository;
  beforeHash: string;
  beforeRef: string;
  checkpointId: string;
  parentLeafId: string | null;
}

export type GitRunnerFactory = (repository: GitRepository) => GitRunner;
