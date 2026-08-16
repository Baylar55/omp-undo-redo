/** Shared types and constants for the content-addressed blob store.
 *  `index.ts` is the public facade; the other modules in this directory
 *  each own one internal concern and meet here for their common vocabulary. */

export interface TreeEntry {
  path: string;
  blobHash: string;
  mode: number;
}

export interface TreeManifest {
  treeId: string;
  entries: TreeEntry[];
  skippedPaths: string[];
}

export type SnapshotPhase = "before" | "after";
export type BlobApplyResult =
  { status: "applied"; partial: boolean } | { status: "conflict" } | { status: "failed" };

export const DEFAULT_BLOB_IGNORES = [
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".history",
  "dist",
  "coverage",
  ".omp",
  ".next",
  "build",
  "out",
  "target",
] as const;

export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  dev: number;
  ino: number;
  mode: number;
}

export interface CachedWorkspaceFile {
  fingerprint: FileFingerprint;
  entry: TreeEntry;
}

export interface WorkspaceCache {
  treeId: string;
  files: Map<string, CachedWorkspaceFile>;
  /** Wall-clock epoch (ms) when this cache was populated.  The racily-clean
   *  guard compares each file's cached mtime against this value so that only
   *  files whose mtime falls within RACILY_CLEAN_MS of the *prior* capture
   *  are forced to re-read — closing the FAT/SMB coarse-tick window where a
   *  rewrite and the observation land on the same tick. */
  captureTime: number;
}
