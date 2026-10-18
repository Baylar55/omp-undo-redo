import type { CommandNavigation } from "../session/registry.js";
import type { FileCheckpointUnavailableReason, ActionId } from "../types.js";

interface NavigationVerbs {
  busy: string;
  movedUnavailablePrefix: string;
  movedSuccess: string;
  movedPartialPrefix: string;
  empty: string;
  cancelled: string;
  rollbackFailed: string;
  conflict: string;
  linked: string;
}

export const VERBS: Record<ActionId, NavigationVerbs> = {
  undo: {
    busy: "Cannot undo while the agent is busy.",
    movedUnavailablePrefix: "Undid the session turn, but files were not restored because ",
    movedSuccess: "Undid last turn: session moved back and file snapshot restored.",
    movedPartialPrefix: "Undid last turn: session moved back and file snapshot restored, but ",
    empty: "Nothing to undo in this session.",
    cancelled: "Undo was cancelled; the session and files were left unchanged.",
    rollbackFailed:
      "Undo navigation was cancelled, but file rollback failed; inspect the session and worktree manually.",
    conflict: "Worktree changed; nothing was undone.",
    linked:
      "Files sit under a symlink or junction, which undo never writes through; nothing was undone.",
  },
  redo: {
    busy: "Cannot redo while the agent is busy.",
    movedUnavailablePrefix: "Redid the session turn, but files were not restored because ",
    movedSuccess: "Redid last turn: session moved forward and file snapshot restored.",
    movedPartialPrefix: "Redid last turn: session moved forward and file snapshot restored, but ",
    empty: "Nothing to redo in this session.",
    cancelled: "Redo was cancelled; the session and files were left unchanged.",
    rollbackFailed:
      "Redo navigation was cancelled, but file rollback failed; inspect the session and worktree manually.",
    conflict: "Worktree changed; nothing was redone.",
    linked:
      "Files sit under a symlink or junction, which redo never writes through; nothing was redone.",
  },
};

export function unavailableMessage(reason: FileCheckpointUnavailableReason): string {
  switch (reason) {
    case "git_unavailable":
      return "Git was unavailable when the checkpoint was created.";
    case "not_repository":
      return "the working directory is not a Git repository.";
    case "repository_unresolvable":
      return "the Git repository could not be resolved.";
    case "invalid_head":
      return "the Git repository has an invalid HEAD.";
    case "file_history_gap":
      return "the next turn started before this turn's file snapshot finished.";
    case "resumed_checkpoint_unavailable":
      return "the resumed turn has no usable file checkpoint.";
    case "checkpoint_removed":
      return "this turn's file snapshot was removed from the snapshot store.";
    case "private_repository_unavailable":
      return "the private snapshot repository could not be initialized.";
    case "store_unavailable":
      return "the snapshot store for this Git repository could not be initialized.";
    case "unsafe_workspace":
      return "file snapshots are disabled in a home directory, drive root, or temp directory.";
    case "before_snapshot_failed":
      return "the file snapshot before this turn failed or was still running when the turn started.";
    case "before_ref_failed":
      return "the file snapshot taken before this turn could not be saved.";
    case "after_snapshot_failed":
      return "the file snapshot after this turn failed.";
    case "after_ref_failed":
      return "the file snapshot taken after this turn could not be saved.";
  }
}

const LISTED_PATHS = 5;

export function listed(paths: readonly string[]): string {
  const more = paths.length - LISTED_PATHS;
  return `${paths.slice(0, LISTED_PATHS).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

export function notRestoredMessage(
  nested: readonly string[],
  unreadable: readonly string[],
): string {
  const parts: string[] = [];
  if (nested.length > 0) {
    parts.push(
      `files inside nested Git repositories are outside the snapshot and were not restored: ${listed(nested)}`,
    );
  }
  if (unreadable.length > 0) {
    parts.push(
      `files Git could not read when the snapshot was taken (locked by another process or no read permission) were left as they are: ${listed(unreadable)}`,
    );
  }
  return `${parts.join("; ")}.`;
}

/** The snapshots cover the whole worktree, so this names every file the
 *  restore touched, including ones edited during the turn by someone other
 *  than the agent (an editor, another process). */
export function restoredFilesMessage(paths: readonly string[]): string {
  return paths.length > 0 ? ` Restored files: ${listed(paths)}.` : " No files changed.";
}

export function commandBlockedMessage(
  id: ActionId,
  status: Exclude<CommandNavigation["status"], "ready">,
): string {
  switch (status) {
    case "subagent":
      return `/${id} is unavailable in a subagent session.`;
    case "capturing":
      return `Cannot ${id} while the file checkpoint is still being captured; try again shortly.`;
    case "finalizing":
      return `Cannot ${id} while the last turn is still being finalized; try again shortly.`;
    case "closing":
      return `${id === "undo" ? "Undo" : "Redo"} is unavailable while the session is closing.`;
  }
}
