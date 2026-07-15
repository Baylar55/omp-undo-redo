import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import { SessionNavigation } from "./core/session-navigation.js";

type NavigationContext = Pick<ExtensionCommandContext, "sessionManager" | "navigateTree">;

function createNavigation(ctx: NavigationContext): SessionNavigation {
  const manager = ctx.sessionManager;
  return new SessionNavigation({
    getLeafId: () => manager.getLeafId(),
    getBranch: (fromId) => manager.getBranch(fromId),
    getEntry: (id) => manager.getEntry(id),
    navigateTree: (targetId) => ctx.navigateTree(targetId),
  });
}

export default function ompUndoRedo(pi: ExtensionAPI): void {
  let navigation: SessionNavigation | undefined;

  pi.on("session_start", async () => {
    navigation = undefined;
  });

  pi.on("turn_end", async () => {
    navigation?.invalidateIfDiverged();
  });

  pi.registerCommand("undo", {
    description: "Move session context back one checkpoint",
    handler: async (_args, ctx) => {
      navigation ??= createNavigation(ctx);
      await runUndo(navigation, ctx);
    },
  });

  pi.registerCommand("redo", {
    description: "Restore the most recently undone checkpoint",
    handler: async (_args, ctx) => {
      navigation ??= createNavigation(ctx);
      await runRedo(navigation, ctx);
    },
  });
}
