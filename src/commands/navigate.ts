import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type {
  CommandNavigationResult,
  FileCheckpointUnavailableReason,
  NavigationResult,
} from "../core/types.js";
import type { SessionNavigation } from "../core/session-navigation.js";

export type NavigationDirection = "undo" | "redo";

interface NavigationVerbs {
  busy: string;
  movedUnavailablePrefix: string;
  movedSuccess: string;
  movedPartialPrefix: string;
  empty: string;
  cancelled: string;
  rollbackFailed: string;
  conflict: string;
}

const VERBS: Record<NavigationDirection, NavigationVerbs> = {
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
  },
};

function unavailableMessage(reason: FileCheckpointUnavailableReason): string {
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
    case "private_repository_unavailable":
      return "the private snapshot repository could not be initialized.";
    case "unsafe_workspace":
      return "file snapshots are disabled in a home directory, drive root, or temp directory.";
    default:
      return "the file checkpoint could not be created.";
  }
}

const LISTED_PATHS = 5;

function listed(paths: readonly string[]): string {
  const more = paths.length - LISTED_PATHS;
  return `${paths.slice(0, LISTED_PATHS).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
}

function notRestoredMessage(nested: readonly string[], unreadable: readonly string[]): string {
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

export async function runNavigation(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
  direction: NavigationDirection,
): Promise<CommandNavigationResult> {
  const verbs = VERBS[direction];
  if (!ctx.isIdle()) {
    ctx.ui.notify(verbs.busy, "warning");
    return { status: "busy" };
  }

  const outcome: NavigationResult = await navigation[direction]();
  switch (outcome.status) {
    case "moved": {
      if (outcome.files === "unavailable") {
        ctx.ui.notify(
          `${verbs.movedUnavailablePrefix}${unavailableMessage(outcome.reason)}`,
          "info",
        );
      } else if (outcome.files === "partial") {
        ctx.ui.notify(
          `${verbs.movedPartialPrefix}${notRestoredMessage(outcome.nestedRepositories, outcome.unreadableFiles)}`,
          "warning",
        );
      } else {
        ctx.ui.notify(verbs.movedSuccess, "info");
      }
      break;
    }
    case "empty":
      ctx.ui.notify(verbs.empty, "info");
      break;
    case "cancelled":
      ctx.ui.notify(verbs.cancelled, "warning");
      break;
    case "rollback_failed":
      ctx.ui.notify(verbs.rollbackFailed, "error");
      break;
    case "git_failed":
      ctx.ui.notify(
        outcome.failure === "conflict" ? verbs.conflict : "Could not restore the Git checkpoint.",
        "warning",
      );
      break;
  }
  return outcome;
}
