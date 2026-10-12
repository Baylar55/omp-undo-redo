import type { SessionOnlyReason } from "../store/backend.js";

export const NOTIFICATION_MESSAGES: Record<SessionOnlyReason, string> = {
  git_unavailable:
    "Git is not available.\nSession navigation still works, but file changes cannot be restored.",
  private_repository_unavailable:
    "The private snapshot repository could not be initialized.\nSession navigation still works, but file changes cannot be restored.",
  store_unavailable:
    "The snapshot store for this Git repository could not be initialized.\nSession navigation still works, but file changes cannot be restored.",
  unsafe_workspace:
    "File snapshots are disabled in a home directory, drive root, or temp directory: they would copy its private files.\nSession navigation still works, but file changes cannot be restored. Start OMP in a project folder to enable them.",
  repository_unresolvable:
    "The Git repository could not be resolved.\nSession navigation still works, but file changes cannot be restored.",
};

export const HISTORY_EXPIRED_NOTICE =
  "Undo/redo file history for this session expired due to inactivity.\nSession navigation still works, but file changes cannot be restored.";

export const HISTORY_UNLOADABLE_NOTICE =
  "Undo/redo file history for this session could not be loaded.\nSession navigation still works, but earlier file changes cannot be restored.";

export function recoveryCompletedNotice(command: string): string {
  return `The ${command} interrupted by the last exit had already restored the files; undo history now matches them.`;
}

export function recoveryPartialNotice(
  command: string,
  storeDir: string,
  sourceHash: string,
  targetHash: string,
): string {
  return `The ${command} interrupted by the last exit left files partly restored; undo history was left as it was. Restore them by hand from the snapshots in ${storeDir}: ${sourceHash} (before the ${command}) and ${targetHash} (its result).`;
}
