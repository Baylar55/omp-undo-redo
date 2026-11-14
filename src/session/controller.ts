import { continuationOf } from "../host-contract.js";
import type { AnyContext } from "../host-contract.js";
import { historyDirectory } from "../history/layout.js";
import { releaseSessionHeartbeat } from "../history/liveness.js";
import { appendUnrecordedTurns, reconstructSessionHistory } from "../history/reconstruct.js";
import { SessionHistoryStore } from "../history/store.js";
import { track } from "../infra/async.js";
import { debugLog } from "../infra/debug-log.js";
import { checkpointNamespace } from "../infra/paths.js";
import type { RuntimeActionStateStore } from "../runtime/action-state.js";
import { defaultGitRunnerFactory, resolveBackend } from "../store/backend.js";
import type { FileBackend } from "../store/backend.js";
import type {
  CwdGitRunnerFactory,
  FileCheckpointUnavailableReason,
  GitRepository,
  GitRunner,
  NavigationState,
} from "../types.js";
import {
  expireRepository,
  startBootHousekeeping,
  sweepPrivateRepoRetention,
} from "./housekeeping.js";
import { SessionNavigation } from "./navigation.js";
import type { RestoreIntentPort } from "./navigation.js";
import {
  HISTORY_EXPIRED_NOTICE,
  HISTORY_UNLOADABLE_NOTICE,
  NOTIFICATION_MESSAGES,
} from "./notices.js";
import { settleInterruptedRestore } from "./recovery.js";
import type { ExtensionServices, SessionState } from "./services.js";

/** The record of `sessionId`, created on first use. */
export function stateOf(services: ExtensionServices, sessionId: string): SessionState {
  let state = services.sessions.get(sessionId);
  if (!state) services.sessions.set(sessionId, (state = {}));
  return state;
}

/** Where a navigation of `sessionId` saves its state and restore intents. */
function navigationPorts(
  ctx: AnyContext,
  sessionId: string,
  store: SessionHistoryStore | undefined,
  runtimeStore: RuntimeActionStateStore,
): { stateChanged: (state: NavigationState) => Promise<void>; intents: RestoreIntentPort } {
  return {
    stateChanged: async (state) => {
      const activeSessionLeaf = ctx.sessionManager.getLeafId();
      const [saved] = await Promise.allSettled([
        store?.save(state),
        runtimeStore.publishNavigation(sessionId, state, activeSessionLeaf),
      ]);
      // Rejecting keeps an in-flight restore's intent: the cursor is not durable.
      if (saved.status === "rejected") throw saved.reason;
    },
    intents: store
      ? {
          save: (intent) => store.saveRestoreIntent(intent),
          clear: () => store.clearRestoreIntent(),
        }
      : { save: async () => undefined, clear: async () => undefined },
  };
}

export function createNavigation(
  ctx: AnyContext,
  sessionId: string,
  store: SessionHistoryStore | undefined,
  runtimeStore: RuntimeActionStateStore,
  backend?: FileBackend,
  gitForRepository?: (repository: GitRepository) => GitRunner,
  gitRunnerFactory: CwdGitRunnerFactory = defaultGitRunnerFactory,
): SessionNavigation {
  const manager = ctx.sessionManager;
  const { stateChanged, intents } = navigationPorts(ctx, sessionId, store, runtimeStore);
  return new SessionNavigation(
    {
      getLeafId: () => manager.getLeafId(),
      getBranch: (fromId) => manager.getBranch(fromId),
      getEntry: (id) => manager.getEntry(id),
    },
    backend?.kind === "git" ? backend.git : gitRunnerFactory(ctx.cwd),
    gitForRepository ?? ((repository) => gitRunnerFactory(repository.worktree)),
    stateChanged,
    undefined,
    intents,
  );
}

/** The live session id. When the host moved the session to a new id
 *  (`continuationOf`), the old id's record is filed under the new one first,
 *  so a turn that started before the move still ends, and its navigation and
 *  history (file and refs) move to the new id. Every handler reads the
 *  session id through this. */
export function liveSessionId(services: ExtensionServices, ctx: AnyContext): string {
  const sessionId = ctx.sessionManager.getSessionId();
  if (services.sessions.has(sessionId)) return sessionId;
  const from = continuationOf(ctx);
  // A switch (`/resume`) into a copy of a session it leaves (or left, with the
  // release still running) is no move: that session's record is being
  // released, and refiled here it would bring its whole history, turns off the
  // copy's branch included, and then that release along.
  if (
    from !== undefined &&
    (from === services.flags.pendingNavigationSourceSessionId || services.leavingSessions.has(from))
  ) {
    debugLog({ event: "continuation not adopted: session being left", from, sessionId });
    return sessionId;
  }
  const state = from === undefined ? undefined : services.sessions.get(from);
  if (from === undefined || !state) return sessionId;
  services.sessions.delete(from);
  services.sessions.set(sessionId, state);
  services.explicitActiveHashes.delete(checkpointNamespace(from));
  services.explicitActiveHashes.add(checkpointNamespace(sessionId));

  // Built after any in-flight initialization: that is what sets `backend`.
  const move = async (navigation: SessionNavigation): Promise<void> => {
    const backend = state.backend;
    const store =
      backend?.kind === "git"
        ? new SessionHistoryStore(sessionId, backend.repository, backend.git)
        : undefined;
    await navigation.rekey(
      async (checkpoints) => (store ? store.adoptCheckpoints(checkpoints, from) : [...checkpoints]),
      navigationPorts(ctx, sessionId, store, services.runtimeStore),
    );
  };
  let moved: Promise<unknown> = Promise.resolve();
  if (state.navigation) {
    moved = move(state.navigation);
  } else if (state.initialization) {
    // Callers waiting on the initialization get the navigation once moved.
    const initialization = state.initialization.then(async (navigation) => {
      await move(navigation);
      return navigation;
    });
    state.initialization = initialization;
    moved = initialization.finally(() => {
      if (state.initialization === initialization) state.initialization = undefined;
    });
  }
  void track(async () => {
    await moved.catch(() => undefined);
    // As `releaseLeftSession` does for a session left by a switch.
    const backend = state.backend;
    await Promise.all([
      services.runtimeStore.releaseSession(from),
      services.leasePool.releasePersistentSnapshotIndices([from], { inUse: false }),
      backend?.kind === "git"
        ? releaseSessionHeartbeat(historyDirectory(backend.repository), checkpointNamespace(from))
        : undefined,
    ]);
  }, services.activeOperations);
  return sessionId;
}

/** The id `state` is filed under now: `liveSessionId` re-keys a record a
 *  deferred finalize still holds. `fallback` once the record was released. */
export function recordSessionId(
  services: ExtensionServices,
  state: SessionState,
  fallback: string,
): string {
  for (const [sessionId, record] of services.sessions) if (record === state) return sessionId;
  return fallback;
}

export function notifySessionOnly(
  services: ExtensionServices,
  ctx: AnyContext,
  sessionId: string,
  reason: FileCheckpointUnavailableReason,
): void {
  if (!ctx.ui?.notify) return;
  const key = `${sessionId}\0${reason}`;
  if (services.notifiedSessionReasons.has(key)) return;
  services.notifiedSessionReasons.add(key);
  ctx.ui.notify(NOTIFICATION_MESSAGES[reason], "warning");
}

/** `historyLeafId` bounds the history rebuilt or extended from the branch: a
 *  finalize passes its turn-start leaf, or the turn it is about to record
 *  would be taken from the branch and then recorded a second time. */
export async function initializeNavigation(
  services: ExtensionServices,
  ctx: AnyContext,
  replaceExisting: boolean,
  historyLeafId?: string | null,
): Promise<SessionNavigation> {
  const sessionId = liveSessionId(services, ctx);
  const sessionHash = checkpointNamespace(sessionId);
  services.explicitActiveHashes.add(sessionHash);
  const state = stateOf(services, sessionId);
  // Unbounded, a turn still capturing or finalizing is on the branch and
  // records itself: taking it from the branch too would record it twice.
  const extendFromBranch =
    historyLeafId !== undefined ||
    (state.capture === undefined && state.pending === undefined && state.finalize === undefined);
  const leafId = historyLeafId === undefined ? ctx.sessionManager.getLeafId() : historyLeafId;
  if (!replaceExisting) {
    const current = state.navigation;
    if (current) return current;
    const active = state.initialization;
    if (active) return active;
  }
  const initialization = (async () => {
    await services.runtimeStore.initialize();
    const previous = state.navigation;
    state.navigation = undefined;
    if (previous) await previous.suspend();
    const backend = await resolveBackend(
      ctx.cwd,
      services.privateRepositories,
      services.gitRunnerFactory,
    );
    state.backend = backend;
    if (backend.kind === "session") {
      notifySessionOnly(services, ctx, sessionId, backend.reason);
    }

    if (backend.kind === "git") void expireRepository(services, backend.repository, backend.git);
    // After boot eviction, which it would otherwise race (a gc holds
    // handles through eviction's rename and refreshes the idle mtimes).
    services.privateRetentionSweep ??= startBootHousekeeping(services)
      .then(() =>
        services.flags.closing
          ? undefined
          : track(() => sweepPrivateRepoRetention(services), services.housekeepingOperations),
      )
      .catch(() => undefined);

    const store =
      backend.kind === "git"
        ? new SessionHistoryStore(sessionId, backend.repository, backend.git)
        : undefined;
    const navigation = createNavigation(
      ctx,
      sessionId,
      store,
      services.runtimeStore,
      backend,
      services.gitRunnerFor,
    );
    const loadResult = store ? await store.load(ctx.sessionManager, continuationOf(ctx)) : null;
    let restored: NavigationState | null = null;
    if (loadResult?.status === "loaded") {
      restored = loadResult.state;
    } else if (loadResult?.status === "expired") {
      restored = null;
      if (ctx.ui?.notify) {
        ctx.ui.notify(HISTORY_EXPIRED_NOTICE, "warning");
      }
    } else if (loadResult?.status === "unavailable" && loadResult.reason === "unusable") {
      restored = null;
      if (ctx.ui?.notify) {
        ctx.ui.notify(HISTORY_UNLOADABLE_NOTICE, "warning");
      }
    } else {
      restored = null;
    }
    let navigationState = restored ?? reconstructSessionHistory(ctx.sessionManager, leafId);
    // ponytail: without loaded history (expired, unusable, missing) the intent
    // matches no git checkpoint and is dropped unreported, even over a
    // half-restored worktree. Probe the intent's own hashes if that ever matters.
    const intent = store ? await store.loadRestoreIntent() : null;
    if (store && intent) {
      navigationState = await settleInterruptedRestore(
        ctx,
        store,
        navigationState,
        intent,
        services.gitRunnerFor,
      );
    }
    // After the intent settled: it names the stored cursor's checkpoint.
    if (restored && extendFromBranch) {
      navigationState = appendUnrecordedTurns(ctx.sessionManager, navigationState, leafId);
    }
    navigation.restoreState(navigationState);
    await services.runtimeStore.initializeSession(
      sessionId,
      navigation.snapshot(),
      ctx.sessionManager.getLeafId(),
    );
    if (!services.flags.closing) state.navigation = navigation;
    return navigation;
  })();
  state.initialization = initialization;
  try {
    return await initialization;
  } finally {
    if (state.initialization === initialization) state.initialization = undefined;
  }
}

export async function ensureNavigation(
  services: ExtensionServices,
  ctx: AnyContext,
  historyLeafId?: string | null,
): Promise<SessionNavigation | null> {
  if (services.flags.closing) return null;
  return initializeNavigation(services, ctx, false, historyLeafId);
}

/** The backend a turn snapshots with. An unavailable store is not cached: a
 *  launch racing this one for it, or a store directory fixed meanwhile, may
 *  let a later turn snapshot. Nor is an unresolvable repository: a transient
 *  git failure or a fixed `safe.directory` may resolve on a later turn. */
export async function turnBackend(
  services: ExtensionServices,
  typed: AnyContext,
  sessionId: string,
): Promise<FileBackend> {
  const state = stateOf(services, sessionId);
  const cached = state.backend;
  if (
    cached &&
    !(
      cached.kind === "session" &&
      (cached.reason === "private_repository_unavailable" ||
        cached.reason === "store_unavailable" ||
        cached.reason === "repository_unresolvable")
    )
  )
    return cached;
  const resolved = await resolveBackend(
    typed.cwd,
    services.privateRepositories,
    services.gitRunnerFactory,
  );
  if (!cached || resolved.kind !== "git") return resolved;
  // Its navigation was built without a history store: rebuilt as
  // session_start does, or file checkpoints would not be persisted. Not
  // while a turn still finalizes into it; the next turn tries again.
  if (state.finalize !== undefined || state.initialization !== undefined) return cached;
  if (state.navigation === undefined) return resolved;
  await initializeNavigation(services, typed, true);
  return state.backend ?? resolved;
}
