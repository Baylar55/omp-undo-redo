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
      return "a later turn had no file checkpoint, so this older file checkpoint was discarded.";
    case "resumed_checkpoint_unavailable":
      return "the resumed turn has no usable file checkpoint.";
    case "private_repository_unavailable":
      return "the private snapshot repository could not be initialized.";
    default:
      return "the file checkpoint could not be created.";
  }
}

export async function runNavigation(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
  direction: NavigationDirection,
): Promise<CommandNavigationResult> {
  const verbs = VERBS[direction];
  await ctx.waitForIdle();
  if (!ctx.isIdle()) {
    ctx.ui.notify(verbs.busy, "warning");
    return { status: "busy" };
  }

  const outcome: NavigationResult = await navigation[direction]();
  switch (outcome.status) {
    case "moved": {
      const message =
        outcome.files === "unavailable"
          ? `${verbs.movedUnavailablePrefix}${unavailableMessage(outcome.reason)}`
          : verbs.movedSuccess;
      ctx.ui.notify(message, "info");
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
