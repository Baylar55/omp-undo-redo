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

export interface WorkspaceSnapshot {
  files: Record<string, string | null>;
}

export interface SnapshotStore {
  capture(): Promise<WorkspaceSnapshot | null>;
  restore(snapshot: WorkspaceSnapshot): Promise<boolean>;
}
export type GitRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;
