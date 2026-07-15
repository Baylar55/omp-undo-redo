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
  if (outcome === "moved") {
    ctx.ui.notify(
      "Session context moved forward one checkpoint. Files and external changes were not reverted.",
      "info",
    );
  } else if (outcome === "cancelled") {
    ctx.ui.notify("Redo was cancelled.", "warning");
  } else {
    ctx.ui.notify("Nothing to redo.", outcome === "invalid" ? "warning" : "info");
  }
}
