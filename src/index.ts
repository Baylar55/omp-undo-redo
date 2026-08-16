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
import { BlobStore, blobStoreRootDirectory } from "./core/blob-store/index.js";
import {
  finishAfterTurnBlob,
  prepareBeforeTurnBlob,
  releaseBlobCheckpoint,
  releaseBlobPendingCheckpoint,
  retainBlobCheckpointForResume,
} from "./core/blob-checkpoints.js";
import { BlobHistoryStore } from "./core/blob-history-store.js";
import {
  blobNavigationApplier,
  blobNavigationReleaser,
  SessionNavigation,
} from "./core/session-navigation.js";
import { checkpointNamespace } from "./core/checkpoints.js";
import {
  finishAfterTurn,
  prepareBeforeTurn,
  releaseCheckpoint,
  releasePendingCheckpoint,
  resolveRepository,
  retainCheckpointForResume,
} from "./core/checkpoints.js";
import {
  expireGitSessionHistories,
  reconstructSessionHistory,
  SessionHistoryStore,
} from "./core/history-store.js";
import type {
  ActionId,
  GitRepository,
  NavigationState,
  PendingTurnCheckpoint,
  SessionOnlyCheckpoint,
} from "./core/types.js";
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
  ui?: {
    notify(message: string, level: string): void;
  };
};

function readRetentionConfig(): { retentionDays: number; maxStoreBytes: number } {
  const days = parseInt(process.env.OMP_UNDO_REDO_RETENTION_DAYS ?? "", 10);
  const mb = parseInt(process.env.OMP_UNDO_REDO_MAX_STORE_MB ?? "", 10);
  return {
    retentionDays: Number.isFinite(days) && days >= 0 ? days : 2,
    maxStoreBytes: Number.isFinite(mb) && mb >= 0 ? mb * 1024 * 1024 : 1024 * 1024 * 1024,
  };
}

type FileBackend =
  | { kind: "git"; repository: GitRepository; git: ReturnType<typeof createGitRunner> }
  | { kind: "blob"; store: BlobStore; workspaceRoot: string }
  | { kind: "session"; reason: "git_unavailable" | "not_repository" | "repository_unresolvable" };

type HistoryWriter = { save(state: NavigationState): Promise<void> };

async function hasGitMarkerInAncestors(cwd: string): Promise<boolean> {
  const { lstat } = await import("node:fs/promises");
  const { dirname, resolve } = await import("node:path");
  let current = resolve(cwd);
  while (true) {
    try {
      await lstat(`${current}/.git`);
      return true;
    } catch {
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

async function resolveBackend(
  cwd: string,
  blobStoreFor: (workspaceRoot: string) => BlobStore,
): Promise<FileBackend> {
  const git = createGitRunner(cwd);
  const resolved = await resolveRepository(git);
  if ("repository" in resolved) return { kind: "git", repository: resolved.repository, git };
  const marker = await hasGitMarkerInAncestors(cwd);
  if (resolved.reason !== "not_repository" && !(resolved.reason === "git_unavailable" && !marker)) {
    return { kind: "session", reason: resolved.reason };
  }
  try {
    const { realpath } = await import("node:fs/promises");
    const workspaceRoot = await realpath(cwd);
    return { kind: "blob", store: blobStoreFor(workspaceRoot), workspaceRoot };
  } catch {
    return { kind: "session", reason: "repository_unresolvable" };
  }
}

function createNavigation(
  ctx: AnyContext,
  sessionId: string,
  store: HistoryWriter | undefined,
  runtimeStore: RuntimeActionStateStore,
  backend?: FileBackend,
): SessionNavigation {
  const manager = ctx.sessionManager;
  const blobDependencies =
    backend?.kind === "blob"
      ? {
          applier: blobNavigationApplier(backend.store),
          releaser: blobNavigationReleaser(backend.store),
        }
      : undefined;
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
    blobDependencies?.applier,
    blobDependencies?.releaser,
  );
}

export default function ompUndoRedo(pi: ExtensionAPI): void {
  const retentionConfig = readRetentionConfig();
  const ownerRegistry = new CheckpointOwnerRegistry({
    resolveHostIdentity: resolvePersistentHostId,
    resolveRuntimeScope,
  });
  const runtimeStore = new RuntimeActionStateStore();
  const runtimeReady = runtimeStore.initialize();
  const navigations = new Map<string, SessionNavigation>();
  const backends = new Map<string, FileBackend>();
  const blobStores = new Map<string, BlobStore>();
  const pending = new Map<string, PendingTurnCheckpoint>();
  const initializations = new Map<string, Promise<SessionNavigation>>();
  const activeOperations = new Set<Promise<void>>();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let pendingSwitchSourceSessionId: string | null = null;
  let pendingBranchSourceSessionId: string | null = null;
  const expirationPromises = new Map<string, Promise<void>>();
  const expirationCancels = new Map<string, () => void>();
  const explicitActiveHashes = new Set<string>();
  // Defer the background expiry sweep so the first capture of a fresh process
  // (agent start or undo) wins the store lock instead of queueing behind a
  // whole-store scan. The sweep still runs shortly after and always at close.
  const EXPIRATION_GRACE_MS = 2_000;

  function activeSessionHashes(): ReadonlySet<string> {
    const hashes = new Set<string>();
    for (const sessionId of navigations.keys()) {
      hashes.add(checkpointNamespace(sessionId));
    }
    for (const sessionId of pending.keys()) {
      hashes.add(checkpointNamespace(sessionId));
    }
    for (const sessionId of initializations.keys()) {
      hashes.add(checkpointNamespace(sessionId));
    }
    for (const hash of explicitActiveHashes) {
      hashes.add(hash);
    }
    return hashes;
  }

  function blobStoreFor(_workspaceRoot: string): BlobStore {
    const root = blobStoreRootDirectory();
    const existing = blobStores.get(root);
    if (existing) return existing;
    const store = new BlobStore(root);
    blobStores.set(root, store);
    const { retentionDays, maxStoreBytes } = retentionConfig;
    const key = `blob:${root}`;
    const operation =
      retentionDays > 0 || maxStoreBytes > 0
        ? () => store.expireAndCollect(retentionDays, maxStoreBytes, () => activeSessionHashes())
        : () => store.garbageCollect();
    let cancel: (() => void) | undefined;
    const expiration = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        expirationCancels.delete(key);
        void operation()
          .catch(() => undefined)
          .then(resolve);
      }, EXPIRATION_GRACE_MS);
      timer.unref?.();
      cancel = () => {
        // No-op once the sweep has started; the promise then resolves when
        // the sweep finishes, so shutdown still waits for the store lock.
        if (!expirationCancels.has(key)) return;
        clearTimeout(timer);
        expirationCancels.delete(key);
        resolve();
      };
    });
    expirationCancels.set(key, cancel!);
    expirationPromises.set(key, expiration);
    return store;
  }

  async function initializeNavigation(
    ctx: AnyContext,
    replaceExisting: boolean,
  ): Promise<SessionNavigation> {
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionHash = checkpointNamespace(sessionId);
    explicitActiveHashes.add(sessionHash);
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
      const backend = await resolveBackend(ctx.cwd, (workspaceRoot) => blobStoreFor(workspaceRoot));
      backends.set(sessionId, backend);

      if (
        backend.kind === "git" &&
        !expirationPromises.has(`git:${backend.repository.commonDir}`)
      ) {
        const { retentionDays } = retentionConfig;
        const expiration = expireGitSessionHistories(
          backend.repository,
          backend.git,
          retentionDays,
          () => activeSessionHashes(),
        ).catch(() => undefined);
        expirationPromises.set(`git:${backend.repository.commonDir}`, expiration);
      }

      const store =
        backend.kind === "git"
          ? new SessionHistoryStore(sessionId, backend.repository, backend.git)
          : backend.kind === "blob"
            ? new BlobHistoryStore(sessionId, backend.workspaceRoot, backend.store)
            : undefined;
      const navigation = createNavigation(ctx, sessionId, store, runtimeStore, backend);
      const loadResult = store ? await store.load(ctx.sessionManager) : null;
      let restored: NavigationState | null = null;
      if (loadResult?.status === "loaded") {
        restored = loadResult.state;
      } else if (loadResult?.status === "expired") {
        restored = null;
        if (ctx.ui?.notify) {
          if (loadResult.reason === "age") {
            ctx.ui.notify(
              "Undo/redo file history for this session expired due to inactivity.\nSession navigation still works, but file changes cannot be restored.",
              "warning",
            );
          } else if (loadResult.reason === "storage_cap") {
            ctx.ui.notify(
              "Undo/redo file history for this session was removed to free storage space.\nSession navigation still works, but file changes cannot be restored.",
              "warning",
            );
          }
        }
      } else {
        restored = null;
      }
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
    if (pendingCheckpoint.kind === "git") {
      await releasePendingCheckpoint(
        createGitRunner(pendingCheckpoint.repository.worktree),
        pendingCheckpoint,
      );
      return;
    }
    if (pendingCheckpoint.kind === "blob") {
      const store =
        blobStores.get(blobStoreRootDirectory()) ?? new BlobStore(blobStoreRootDirectory());
      await releaseBlobPendingCheckpoint(store, pendingCheckpoint);
    }
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

      const backend =
        backends.get(sessionId) ??
        (await resolveBackend(typed.cwd, (workspaceRoot) => blobStoreFor(workspaceRoot)));
      backends.set(sessionId, backend);
      const prepared =
        backend.kind === "git"
          ? await prepareBeforeTurn(backend.git, sessionId, ownerRegistry)
          : backend.kind === "blob"
            ? await prepareBeforeTurnBlob(
                backend.store,
                backend.workspaceRoot,
                checkpointNamespace(sessionId),
              )
            : { status: "session_only" as const, reason: backend.reason };
      const parentLeafId = typed.sessionManager.getLeafId();
      const checkpoint: PendingTurnCheckpoint =
        prepared.status === "git"
          ? { ...prepared.checkpoint, parentLeafId }
          : prepared.status === "blob"
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
      } else if (before.kind === "git") {
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
      } else {
        const backend = backends.get(sessionId);
        const store =
          backend?.kind === "blob" ? backend.store : new BlobStore(blobStoreRootDirectory());
        const result = await finishAfterTurnBlob(
          store,
          before,
          before.parentLeafId,
          typed.sessionManager.getLeafId(),
        );
        if (result.status === "blob") {
          if (closing) {
            await releaseBlobCheckpoint(store, result.checkpoint);
            return;
          }
          const retained = await retainBlobCheckpointForResume(store, sessionId, result.checkpoint);
          if (retained) {
            const nav =
              (await ensureNavigation(typed)) ??
              createNavigation(typed, sessionId, undefined, runtimeStore, backend);
            navigations.set(sessionId, nav);
            await nav.recordTurnEnd(retained);
            return;
          }
          await releaseBlobCheckpoint(store, result.checkpoint);
          completed = {
            kind: "session",
            reason: "after_blob_failed",
            parentLeafId: before.parentLeafId,
            leafId: typed.sessionManager.getLeafId(),
          };
        } else {
          completed = {
            kind: "session",
            reason: result.reason,
            parentLeafId: before.parentLeafId,
            leafId: typed.sessionManager.getLeafId(),
          };
        }
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
      // Let an in-flight expiry finish (it holds the store lock) and cancel one
      // that never started, then stop protecting sessions so shutdown GC can
      // reclaim their data.
      for (const cancel of expirationCancels.values()) cancel();
      expirationCancels.clear();
      await Promise.allSettled([...expirationPromises.values()]);
      explicitActiveHashes.clear();
      await disposeDetached(detachedNavigations, detachedPending, false);
      await Promise.allSettled([...activeOperations]);
      await drainState();
      await ownerRegistry.shutdown();
      await Promise.allSettled(
        [...blobStores.values()].map(async (store) => {
          await store.garbageCollect().catch(() => undefined);
          await store.shutdown();
        }),
      );
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
