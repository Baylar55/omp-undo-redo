import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type {
  CommandNavigationResult,
  FileCheckpointUnavailableReason,
  NavigationResult,
} from "../core/types.js";
import type { SessionNavigation } from "../core/session-navigation.js";

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
    case "workspace_unresolvable":
      return "the working directory could not be resolved.";
    case "private_repository_unavailable":
      return "the private snapshot repository could not be initialized.";
    case "history_expired":
      return "undo/redo file history for this session expired due to inactivity.";
    default:
      return "the file checkpoint could not be created.";
  }
}

export async function runRedo(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
): Promise<CommandNavigationResult> {
  await ctx.waitForIdle();
  if (!ctx.isIdle()) {
    ctx.ui.notify("Cannot redo while the agent is busy.", "warning");
    return { status: "busy" };
  }

  const outcome: NavigationResult = await navigation.redo();
  switch (outcome.status) {
    case "moved": {
      let message: string;
      if (outcome.files === "unavailable") {
        message = `Redid the session turn, but files were not restored because ${unavailableMessage(outcome.reason)}`;
      } else if (outcome.files === "partially_restored") {
        message =
          "Redid last turn: tracked files restored, but some paths were not included (unsupported type or size limit).";
      } else {
        message = "Redid last turn: session moved forward and file snapshot restored.";
      }
      ctx.ui.notify(message, "info");
      break;
    }
    case "empty":
      ctx.ui.notify("Nothing to redo in this session.", "info");
      break;
    case "cancelled":
      ctx.ui.notify("Redo was cancelled; the session and files were left unchanged.", "warning");
      break;
    case "rollback_failed":
      ctx.ui.notify(
        "Redo navigation was cancelled, but file rollback failed; inspect the session and worktree manually.",
        "error",
      );
      break;
    case "git_failed":
      ctx.ui.notify(
        outcome.failure === "conflict"
          ? "Worktree changed; nothing was redone."
          : "Could not restore the Git checkpoint.",
        "warning",
      );
      break;
  }
  return outcome;
}
