import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import { SessionNavigation } from "./core/session-navigation.js";
import {
  finishAfterTurn,
  prepareBeforeTurn,
  releasePendingCheckpoint,
} from "./core/checkpoints.js";
import type { GitRunner, PendingCheckpoint } from "./core/types.js";

const execFileAsync = promisify(execFile);

type AnyContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(fromId?: string): SessionEntryLike[];
    getEntry(id: string): SessionEntryLike | undefined;
  };
};

function createGitRunner(cwd: string): GitRunner {
  return async (args, options) => {
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        env: { ...process.env, ...options?.env },
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as {
        stdout?: string;
        stderr?: string;
        code?: number;
      };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  };
}

function createNavigation(ctx: AnyContext): SessionNavigation {
  const manager = ctx.sessionManager;
  return new SessionNavigation(
    {
      getLeafId: () => manager.getLeafId(),
      getBranch: (fromId) => manager.getBranch(fromId),
      getEntry: (id) => manager.getEntry(id),
    },
    createGitRunner(ctx.cwd),
    (repository) => createGitRunner(repository.worktree),
  );
}

const navigations = new Map<string, SessionNavigation>();
const pending = new Map<string, PendingCheckpoint>();

export default function ompUndoRedo(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const previous = navigations.get(sessionId);
    if (previous) await previous.dispose();
    const previousPending = pending.get(sessionId);
    if (previousPending) {
      await releasePendingCheckpoint(
        createGitRunner(previousPending.repository.worktree),
        previousPending,
      );
    }
    navigations.set(sessionId, createNavigation(ctx as unknown as AnyContext));
    pending.delete(sessionId);
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    const typed = ctx as unknown as AnyContext;
    const sessionId = typed.sessionManager.getSessionId();
    const oldPending = pending.get(sessionId);
    if (oldPending) {
      await releasePendingCheckpoint(createGitRunner(oldPending.repository.worktree), oldPending);
      pending.delete(sessionId);
    }
    const before = await prepareBeforeTurn(createGitRunner(typed.cwd), sessionId);
    if (before) {
      pending.set(sessionId, {
        ...before,
        parentLeafId: typed.sessionManager.getLeafId(),
      });
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const typed = ctx as unknown as AnyContext;
    const sessionId = typed.sessionManager.getSessionId();
    const before = pending.get(sessionId);
    if (!before) return;
    pending.delete(sessionId);
    const checkpoint = await finishAfterTurn(
      createGitRunner(before.repository.worktree),
      before,
      before.parentLeafId,
      typed.sessionManager.getLeafId(),
    );
    if (!checkpoint) return;
    const nav = navigations.get(sessionId) ?? createNavigation(typed);
    navigations.set(sessionId, nav);
    await nav.recordTurnEnd(checkpoint);
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
