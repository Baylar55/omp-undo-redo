import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import {
  CheckpointOwnerRegistry,
  resolvePersistentHostId,
  resolveRuntimeScope,
} from "./core/checkpoint-owners.js";
import { createGitRunner } from "./core/git-runner.js";
import { SessionNavigation } from "./core/session-navigation.js";
import {
  finishAfterTurn,
  prepareBeforeTurn,
  releaseCheckpoint,
  releasePendingCheckpoint,
  resolveRepository,
  retainCheckpointForResume,
} from "./core/checkpoints.js";
import { reconstructSessionHistory, SessionHistoryStore } from "./core/history-store.js";
import type { ActionId, PendingTurnCheckpoint, SessionOnlyCheckpoint } from "./core/types.js";
import { RuntimeActionStateStore } from "./core/runtime-action-state-store.js";

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

function createNavigation(
  ctx: AnyContext,
  sessionId: string,
  store: SessionHistoryStore | undefined,
  runtimeStore: RuntimeActionStateStore,
): SessionNavigation {
  const manager = ctx.sessionManager;
  return new SessionNavigation(
    {
      getLeafId: () => manager.getLeafId(),
      getBranch: (fromId) => manager.getBranch(fromId),
      getEntry: (id) => manager.getEntry(id),
    },
    createGitRunner(ctx.cwd),
    (repository) => createGitRunner(repository.worktree),
    async (state) => {
      const activeSessionLeaf = manager.getLeafId();
      await Promise.allSettled([
        ...(store ? [store.save(state)] : []),
        runtimeStore.publishNavigation(sessionId, state, activeSessionLeaf),
      ]);
    },
  );
}

export default function ompUndoRedo(pi: ExtensionAPI): void {
  const ownerRegistry = new CheckpointOwnerRegistry({
    resolveHostIdentity: resolvePersistentHostId,
    resolveRuntimeScope,
  });
  const runtimeStore = new RuntimeActionStateStore();
  const runtimeReady = runtimeStore.initialize();
  const navigations = new Map<string, SessionNavigation>();
  const pending = new Map<string, PendingTurnCheckpoint>();
  const initializations = new Map<string, Promise<SessionNavigation>>();
  const activeOperations = new Set<Promise<void>>();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let pendingSwitchSourceSessionId: string | null = null;
  let pendingBranchSourceSessionId: string | null = null;

  async function initializeNavigation(
    ctx: AnyContext,
    replaceExisting: boolean,
  ): Promise<SessionNavigation> {
    const sessionId = ctx.sessionManager.getSessionId();
    if (!replaceExisting) {
      const current = navigations.get(sessionId);
      if (current) return current;
      const active = initializations.get(sessionId);
      if (active) return active;
    }
    const initialization = (async () => {
      await runtimeReady;
      const previous = navigations.get(sessionId);
      navigations.delete(sessionId);
      if (previous) await previous.suspend();
      const git = createGitRunner(ctx.cwd);
      const resolved = await resolveRepository(git);
      const store =
        "repository" in resolved
          ? new SessionHistoryStore(sessionId, resolved.repository, git)
          : undefined;
      const navigation = createNavigation(ctx, sessionId, store, runtimeStore);
      const restored = store ? await store.load(ctx.sessionManager) : null;
      navigation.restoreState(restored ?? reconstructSessionHistory(ctx.sessionManager));
      await runtimeStore.initializeSession(
        sessionId,
        navigation.snapshot(),
        ctx.sessionManager.getLeafId(),
      );
      if (!closing) navigations.set(sessionId, navigation);
      return navigation;
    })();
    initializations.set(sessionId, initialization);
    try {
      return await initialization;
    } finally {
      if (initializations.get(sessionId) === initialization) initializations.delete(sessionId);
    }
  }

  async function ensureNavigation(ctx: AnyContext): Promise<SessionNavigation | null> {
    if (closing) return null;
    return initializeNavigation(ctx, false);
  }

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

  async function publishActionResult(
    sessionId: string,
    navigation: SessionNavigation,
    ctx: AnyContext,
    id: ActionId,
    token: string,
    applied: boolean,
  ): Promise<void> {
    await runtimeStore.publishActionResult(
      sessionId,
      navigation.snapshot(),
      ctx.sessionManager.getLeafId(),
      { id, applied, token },
    );
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
    releaseNavigations = true,
  ): Promise<void> {
    await Promise.allSettled([
      ...detachedNavigations.map((navigation) =>
        releaseNavigations ? navigation.dispose() : navigation.suspend(),
      ),
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
    await disposeDetached(detachedNavigations, detachedPending, false);
  }

  pi.on("session_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const previousPending = pending.get(sessionId);
      pending.delete(sessionId);
      if (previousPending) await releasePending(previousPending);
      if (closing) return;
      await initializeNavigation(typed, true);
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

      const prepared = await prepareBeforeTurn(
        createGitRunner(typed.cwd),
        sessionId,
        ownerRegistry,
      );
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
          const retained = await retainCheckpointForResume(
            createGitRunner(result.checkpoint.repository.worktree),
            sessionId,
            result.checkpoint,
          );
          const nav =
            (await ensureNavigation(typed)) ??
            createNavigation(typed, sessionId, undefined, runtimeStore);
          navigations.set(sessionId, nav);
          await nav.recordTurnEnd(retained);
          return;
        }
        completed = {
          kind: "session",
          reason: result.reason,
          parentLeafId: before.parentLeafId,
          leafId: typed.sessionManager.getLeafId(),
        };
      }
      const nav =
        (await ensureNavigation(typed)) ??
        createNavigation(typed, sessionId, undefined, runtimeStore);
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
    initializations.clear();
    pending.clear();
    shutdownPromise = (async () => {
      await disposeDetached(detachedNavigations, detachedPending, false);
      await Promise.allSettled([...activeOperations]);
      await drainState();
      await ownerRegistry.shutdown();
      await runtimeStore.shutdown();
    })();
    return shutdownPromise;
  });

  const undoHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const token = randomUUID();
    const typed = ctx as unknown as AnyContext;
    const nav = await ensureNavigation(typed);
    if (!nav) {
      ctx.ui.notify("Undo is unavailable while the session is closing.", "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    const outcome = await runUndo(nav, ctx);
    await publishActionResult(
      typed.sessionManager.getSessionId(),
      nav,
      typed,
      "undo",
      token,
      outcome.status === "moved",
    );
  };

  const redoHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const token = randomUUID();
    const typed = ctx as unknown as AnyContext;
    const nav = await ensureNavigation(typed);
    if (!nav) {
      ctx.ui.notify("Redo is unavailable while the session is closing.", "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    const outcome = await runRedo(nav, ctx);
    await publishActionResult(
      typed.sessionManager.getSessionId(),
      nav,
      typed,
      "redo",
      token,
      outcome.status === "moved",
    );
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
