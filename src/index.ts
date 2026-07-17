import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import { SessionNavigation } from "./core/session-navigation.js";
import { finishAfterTurn, prepareBeforeTurn } from "./core/checkpoints.js";
import type { GitRunner } from "./core/types.js";

type AnyContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(fromId?: string): SessionEntryLike[];
    getEntry(id: string): SessionEntryLike | undefined;
  };
};

function createGitRunner(pi: ExtensionAPI, cwd: string): GitRunner {
  return async (args: string[]) => {
    const result = await pi.exec("git", args, { cwd });
    if (typeof result === "string") return { stdout: result, stderr: "", code: 0 };
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      code: typeof result.code === "number" ? result.code : 0,
    };
  };
}

function createNavigation(pi: ExtensionAPI, ctx: AnyContext): SessionNavigation {
  const manager = ctx.sessionManager;
  return new SessionNavigation(
    {
      getLeafId: () => manager.getLeafId(),
      getBranch: (fromId) => manager.getBranch(fromId),
      getEntry: (id) => manager.getEntry(id),
    },
    createGitRunner(pi, ctx.cwd),
  );
}

const navigations = new Map<string, SessionNavigation>();
const pending = new Map<
  string,
  { baseHash: string; beforeHash: string; parentLeafId: string | null }
>();

export default function ompUndoRedo(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    navigations.set(sessionId, createNavigation(pi, ctx as unknown as AnyContext));
    pending.delete(sessionId);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const typed = ctx as unknown as AnyContext;
    const sessionId = typed.sessionManager.getSessionId();
    const before = await prepareBeforeTurn(createGitRunner(pi, typed.cwd));
    if (before) {
      pending.set(sessionId, {
        ...before,
        parentLeafId: typed.sessionManager.getLeafId(),
      });
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const typed = ctx as unknown as AnyContext;
    const sessionId = typed.sessionManager.getSessionId();
    const before = pending.get(sessionId);
    if (!before) return;
    const checkpoint = await finishAfterTurn(
      createGitRunner(pi, typed.cwd),
      before,
      before.parentLeafId,
      typed.sessionManager.getLeafId(),
    );
    pending.delete(sessionId);
    if (!checkpoint) return;
    const nav = navigations.get(sessionId) ?? createNavigation(pi, typed);
    navigations.set(sessionId, nav);
    nav.recordTurnEnd(checkpoint);
  });

  const undoHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const nav = navigations.get(ctx.sessionManager.getSessionId());
    if (!nav) {
      ctx.ui.notify("Undo is unavailable until a turn completes.", "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    await runUndo(nav, ctx);
  };

  const redoHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const nav = navigations.get(ctx.sessionManager.getSessionId());
    if (!nav) {
      ctx.ui.notify("Redo is unavailable until a turn completes.", "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    await runRedo(nav, ctx);
  };

  pi.registerCommand("undo", {
    description: "Revert file changes and session context for the last turn",
    handler: undoHandler,
  });
  pi.registerCommand("redo", {
    description: "Restore the most recently undone turn",
    handler: redoHandler,
  });
}
