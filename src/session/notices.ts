import type { FileCheckpointUnavailableReason } from "../types.js";

const TURN_LOST = "Undo cannot restore this turn's file changes:";
const TURN_SUFFIX = "\nSession navigation still works. Shown once per session for each cause.";

/** Backend reasons say why the whole session lost file protection; the rest
 *  name the turn that just lost its checkpoint. */
export const NOTIFICATION_MESSAGES: Record<FileCheckpointUnavailableReason, string> = {
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
  not_repository: `${TURN_LOST} the working directory is no longer a Git repository.${TURN_SUFFIX}`,
  invalid_head: `${TURN_LOST} the Git repository has an invalid HEAD.${TURN_SUFFIX}`,
  before_snapshot_failed: `${TURN_LOST} the file snapshot before this turn failed or was still running when the turn started.${TURN_SUFFIX}`,
  before_ref_failed: `${TURN_LOST} the file snapshot taken before this turn could not be saved.${TURN_SUFFIX}`,
  after_snapshot_failed: `${TURN_LOST} the file snapshot after this turn failed.${TURN_SUFFIX}`,
  after_ref_failed: `${TURN_LOST} the file snapshot taken after this turn could not be saved.${TURN_SUFFIX}`,
  file_history_gap: `${TURN_LOST} the next turn started before this turn's file snapshot finished.${TURN_SUFFIX}`,
  resumed_checkpoint_unavailable: `${TURN_LOST} the resumed turn has no usable file checkpoint.${TURN_SUFFIX}`,
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
  return `The ${command} interrupted by the last exit left files partly restored; undo history was left as it was. Restore them by hand from the snapshots in ${storeDir}: ${sourceHash} (before the ${command}) and ${targetHash} (its result). Steps: https://github.com/Baylar55/omp-undo-redo/blob/main/docs/troubleshooting.md#restoring-files-after-an-interrupted-undo-or-redo`;
}
