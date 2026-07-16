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

export interface Checkpoint {
  commitHash: string;
  leafId: string | null;
}

export type GitRunner = (
  args: string[],
) => Promise<{ stdout: string; stderr: string; code: number }>;
