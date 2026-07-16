import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import { SessionNavigation } from "./core/session-navigation.js";
import { captureInitialState } from "./core/checkpoints.js";

type AnyContext = {
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(fromId?: string): SessionEntryLike[];
    getEntry(id: string): SessionEntryLike | undefined;
  };
  navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
};

function createGitRunner(pi: ExtensionAPI) {
  return async (args: string[]) => {
    const ctx: Record<string, unknown> = {};
    const result = await pi.exec("git", args, ctx);
    if (typeof result === "string") {
      return { stdout: result, stderr: "", code: 0 };
    }
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      code: typeof result.code === "number" ? result.code : 0,
    };
  };
}

function createNavigation(pi: ExtensionAPI, ctx: AnyContext): SessionNavigation {
  const manager = ctx.sessionManager;
  const git = createGitRunner(pi);
  return new SessionNavigation(
    {
      getLeafId: () => manager.getLeafId(),
      getBranch: (fromId) => manager.getBranch(fromId),
      getEntry: (id) => manager.getEntry(id),
      navigateTree: (targetId) => ctx.navigateTree(targetId),
    },
    git,
  );
}

const navigations = new Map<string, SessionNavigation>();
const initialised = new Set<string>();
let turnCounter = 0;

export default function ompUndoRedo(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    navigations.delete(sessionId);
    initialised.delete(sessionId);
  });

  pi.on("turn_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    let nav = navigations.get(sessionId);
    if (!nav) {
      nav = createNavigation(pi, ctx as unknown as AnyContext);
      navigations.set(sessionId, nav);
    }

    if (!initialised.has(sessionId)) {
      const hash = await captureInitialState(createGitRunner(pi));
      if (hash) {
        nav.setInitialCheckpoint(hash);
      }
      initialised.add(sessionId);
    }

    turnCounter++;
    await nav.recordTurnEnd(turnCounter);
  });

  pi.registerCommand("undo", {
    description: "Revert file changes and session context for the last assistant turn",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const nav = navigations.get(sessionId) ?? createNavigation(pi, ctx);
      navigations.set(sessionId, nav);
      await runUndo(nav, ctx);
    },
  });

  pi.registerCommand("redo", {
    description: "Restore the most recently undone assistant turn",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const nav = navigations.get(sessionId) ?? createNavigation(pi, ctx);
      navigations.set(sessionId, nav);
      await runRedo(nav, ctx);
    },
  });
}
