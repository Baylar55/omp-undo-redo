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
  if (outcome === "moved") {
    ctx.ui.notify(
      "Session context moved back one checkpoint. Files and external changes were not reverted.",
      "info",
    );
  } else if (outcome === "empty") {
    ctx.ui.notify("Nothing to undo in this session.", "info");
  } else if (outcome === "cancelled") {
    ctx.ui.notify("Undo was cancelled.", "warning");
  } else {
    ctx.ui.notify("Nothing to undo in this session.", "warning");
  }
}
