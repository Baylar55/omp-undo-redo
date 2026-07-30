import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import { SessionNavigation } from "./core/session-navigation.js";
import {
  finishAfterTurn,
  prepareBeforeTurn,
  releaseCheckpoint,
  releasePendingCheckpoint,
} from "./core/checkpoints.js";
import type { GitRunner, PendingTurnCheckpoint, SessionOnlyCheckpoint } from "./core/types.js";

const execFileAsync = promisify(execFile);

function promiseWithResolvers<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
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
  const runner: GitRunner = async (args, options) => {
    if (options?.stdin !== undefined) {
      const { promise, resolve } = promiseWithResolvers<{
        stdout: string;
        stderr: string;
        code: number;
        error?: "unavailable";
      }>();
      const child = spawn("git", args, {
        cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        resolve({
          stdout,
          stderr: `${stderr}${error.message}`,
          code: 1,
          error: "unavailable",
        });
      });
      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, code: typeof code === "number" ? code : 1 });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
      return await promise;
    }
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
        ...(typeof failure.code === "number" ? {} : { error: "unavailable" as const }),
      };
    }
  };
  runner.cwd = cwd;
  return runner;
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

export default function ompUndoRedo(pi: ExtensionAPI): void {
  const navigations = new Map<string, SessionNavigation>();
  const pending = new Map<string, PendingTurnCheckpoint>();
  const activeOperations = new Set<Promise<void>>();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let pendingSwitchSourceSessionId: string | null = null;
  let pendingBranchSourceSessionId: string | null = null;

  function track(operation: () => Promise<void>): Promise<void> {
    const { promise: tracked, resolve, reject } = promiseWithResolvers<void>();
    activeOperations.add(tracked);
    void (async () => {
      try {
        await operation();
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        activeOperations.delete(tracked);
      }
    })();
    return tracked;
  }

  async function releasePending(pendingCheckpoint: PendingTurnCheckpoint): Promise<void> {
    if (pendingCheckpoint.kind !== "git") return;
    await releasePendingCheckpoint(
      createGitRunner(pendingCheckpoint.repository.worktree),
      pendingCheckpoint,
    );
  }

  async function disposeDetached(
    detachedNavigations: readonly SessionNavigation[],
    detachedPending: readonly PendingTurnCheckpoint[],
  ): Promise<void> {
    await Promise.allSettled([
      ...detachedNavigations.map((navigation) => navigation.dispose()),
      ...detachedPending.map((pendingCheckpoint) => releasePending(pendingCheckpoint)),
    ]);
  }

  async function invalidateAllRedo(): Promise<void> {
    await Promise.allSettled(
      [...navigations.values()].map((navigation) => navigation.invalidateRedo()),
    );
  }

  async function drainState(): Promise<void> {
    const detachedNavigations = [...navigations.values()];
    const detachedPending = [...pending.values()];
    navigations.clear();
    pending.clear();
    await disposeDetached(detachedNavigations, detachedPending);
  }

  pi.on("session_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const previous = navigations.get(sessionId);
      navigations.delete(sessionId);
      const previousPending = pending.get(sessionId);
      pending.delete(sessionId);
      await disposeDetached(previous ? [previous] : [], previousPending ? [previousPending] : []);
      if (closing) return;
      navigations.set(sessionId, createNavigation(typed));
    }),
  );

  pi.on("session_tree", (event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      const navigation = navigations.get(typed.sessionManager.getSessionId());
      if (!navigation) return;
      await navigation.handleSessionTreeNavigation(event.oldLeafId, event.newLeafId);
    }),
  );

  pi.on("session_before_switch", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      pendingSwitchSourceSessionId = typed.sessionManager.getSessionId();
    }),
  );

  pi.on("session_switch", () =>
    track(async () => {
      if (closing) return;
      const sourceSessionId = pendingSwitchSourceSessionId;
      pendingSwitchSourceSessionId = null;
      if (sourceSessionId) {
        await navigations.get(sourceSessionId)?.invalidateRedo();
      } else {
        await invalidateAllRedo();
      }
    }),
  );

  pi.on("session_before_branch", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      pendingBranchSourceSessionId = typed.sessionManager.getSessionId();
    }),
  );

  pi.on("session_branch", () =>
    track(async () => {
      if (closing) return;
      const sourceSessionId = pendingBranchSourceSessionId;
      pendingBranchSourceSessionId = null;
      if (sourceSessionId) {
        await navigations.get(sourceSessionId)?.invalidateRedo();
      } else {
        await invalidateAllRedo();
      }
    }),
  );

  pi.on("before_agent_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const oldPending = pending.get(sessionId);
      pending.delete(sessionId);
      if (oldPending) await releasePending(oldPending);

      const prepared = await prepareBeforeTurn(createGitRunner(typed.cwd), sessionId);
      const parentLeafId = typed.sessionManager.getLeafId();
      const checkpoint: PendingTurnCheckpoint =
        prepared.status === "git"
          ? { ...prepared.checkpoint, parentLeafId }
          : { kind: "session", reason: prepared.reason, parentLeafId };
      if (closing) {
        await releasePending(checkpoint);
        return;
      }
      pending.set(sessionId, checkpoint);
    }),
  );

  pi.on("agent_end", (_event, ctx) =>
    track(async () => {
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const before = pending.get(sessionId);
      if (!before) return;
      pending.delete(sessionId);
      if (closing) {
        await releasePending(before);
        return;
      }

      let completed: SessionOnlyCheckpoint | undefined;
      if (before.kind === "session") {
        completed = {
          kind: "session",
          reason: before.reason,
          parentLeafId: before.parentLeafId,
          leafId: typed.sessionManager.getLeafId(),
        };
      } else {
        const result = await finishAfterTurn(
          createGitRunner(before.repository.worktree),
          before,
          before.parentLeafId,
          typed.sessionManager.getLeafId(),
        );
        if (result.status === "git") {
          if (closing) {
            await releaseCheckpoint(
              createGitRunner(result.checkpoint.repository.worktree),
              result.checkpoint,
            );
            return;
          }
          const nav = navigations.get(sessionId) ?? createNavigation(typed);
          navigations.set(sessionId, nav);
          await nav.recordTurnEnd(result.checkpoint);
          return;
        }
        completed = {
          kind: "session",
          reason: result.reason,
          parentLeafId: before.parentLeafId,
          leafId: typed.sessionManager.getLeafId(),
        };
      }
      const nav = navigations.get(sessionId) ?? createNavigation(typed);
      navigations.set(sessionId, nav);
      await nav.recordTurnEnd(completed);
    }),
  );

  pi.on("session_shutdown", () => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    pendingSwitchSourceSessionId = null;
    pendingBranchSourceSessionId = null;
    const detachedNavigations = [...navigations.values()];
    const detachedPending = [...pending.values()];
    navigations.clear();
    pending.clear();
    shutdownPromise = (async () => {
      await disposeDetached(detachedNavigations, detachedPending);
      await Promise.allSettled([...activeOperations]);
      await drainState();
    })();
    return shutdownPromise;
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
