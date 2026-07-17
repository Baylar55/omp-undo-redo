import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionNavigation } from "../core/session-navigation.js";

export async function runUndo(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
): Promise<void> {
  await ctx.waitForIdle();
  if (!ctx.isIdle()) {
    ctx.ui.notify("Cannot undo while the agent is busy.", "warning");
    return;
  }

  const outcome = await navigation.undo();
  switch (outcome) {
    case "moved":
      ctx.ui.notify("Undid last turn: session moved back and file snapshot restored.", "info");
      break;
    case "empty":
      ctx.ui.notify("Nothing to undo in this session.", "info");
      break;
    case "cancelled":
      ctx.ui.notify("Undo was cancelled.", "warning");
      break;
    case "git_failed":
      ctx.ui.notify("Could not restore the Git checkpoint.", "warning");
      break;
    default:
      ctx.ui.notify("Nothing to undo in this session.", "warning");
  }
}
