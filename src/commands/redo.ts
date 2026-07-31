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
    case "file_history_gap":
      return "a later turn had no file checkpoint, so this older file checkpoint was discarded.";
    case "resumed_checkpoint_unavailable":
      return "the resumed turn has no usable file checkpoint.";
    default:
      return "the file checkpoint could not be created.";
  }
}

export async function runRedo(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.waitForIdle();
  if (!ctx.isIdle()) {
    ctx.ui.notify("Cannot redo while the agent is busy.", "warning");
    return;
  }

  const outcome: NavigationResult = await navigation.redo();
  switch (outcome.status) {
    case "moved":
      ctx.ui.notify(
        outcome.files === "restored"
          ? "Redid last turn: session moved forward and worktree snapshot restored; Git index left unchanged."
          : `Redid the session turn, but files were not restored because ${unavailableMessage(outcome.reason)}`,
        "info",
      );
      break;
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
}
