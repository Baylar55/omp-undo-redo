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

const navigations = new Map<string, SessionNavigation>();

export default function ompUndoRedo(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    navigations.delete(sessionId);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const navigation = navigations.get(sessionId);
    navigation?.invalidateIfDiverged();
  });

  pi.registerCommand("undo", {
    description: "Move session context back one checkpoint",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      let navigation = navigations.get(sessionId);
      if (!navigation) {
        navigation = createNavigation(ctx);
        navigations.set(sessionId, navigation);
      }
      await runUndo(navigation, ctx);
    },
  });

  pi.registerCommand("redo", {
    description: "Restore the most recently undone checkpoint",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      let navigation = navigations.get(sessionId);
      if (!navigation) {
        navigation = createNavigation(ctx);
        navigations.set(sessionId, navigation);
      }
      await runRedo(navigation, ctx);
    },
  });
}
