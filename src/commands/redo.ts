import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionNavigation } from "../core/session-navigation.js";

export async function runRedo(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.waitForIdle();
  if (!ctx.isIdle()) {
    ctx.ui.notify("Cannot redo while the agent is busy.", "warning");
    return;
  }

  const outcome = await navigation.redo();
  switch (outcome) {
    case "moved":
      ctx.ui.notify("Redid last turn: session moved forward and file changes reapplied.", "info");
      break;
    case "empty":
      ctx.ui.notify("Nothing to redo in this session.", "info");
      break;
    case "cancelled":
      ctx.ui.notify("Redo was cancelled.", "warning");
      break;
    case "git_failed":
      ctx.ui.notify("Could not reapply file changes (git checkpoint missing).", "warning");
      break;
    default:
      ctx.ui.notify("Nothing to redo in this session.", "warning");
  }
}
