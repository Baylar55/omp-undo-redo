import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { FileCheckpointUnavailableReason, NavigationResult } from "../core/types.js";
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
    default:
      return "the file checkpoint could not be created.";
  }
}

export async function runUndo(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.waitForIdle();
  if (!ctx.isIdle()) {
    ctx.ui.notify("Cannot undo while the agent is busy.", "warning");
    return;
  }

  const outcome: NavigationResult = await navigation.undo();
  switch (outcome.status) {
    case "moved":
      ctx.ui.notify(
        outcome.files === "restored"
          ? "Undid last turn: session moved back and file snapshot restored."
          : `Undid the session turn, but files were not restored because ${unavailableMessage(outcome.reason)}`,
        "info",
      );
      break;
    case "empty":
      ctx.ui.notify("Nothing to undo in this session.", "info");
      break;
    case "cancelled":
      ctx.ui.notify("Undo was cancelled; the session and files were left unchanged.", "warning");
      break;
    case "rollback_failed":
      ctx.ui.notify(
        "Undo navigation was cancelled, but file rollback failed; inspect the session and worktree manually.",
        "error",
      );
      break;
    case "git_failed":
      ctx.ui.notify(
        outcome.failure === "conflict"
          ? "Worktree changed; nothing was undone."
          : "Could not restore the Git checkpoint.",
        "warning",
      );
      break;
  }
}
