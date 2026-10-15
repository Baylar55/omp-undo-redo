import type { AnyContext } from "../host-contract.js";
import { reconstructSessionHistory } from "../history/reconstruct.js";
import { SessionHistoryStore } from "../history/store.js";
import { track } from "../infra/async.js";
import { checkpointNamespace } from "../infra/paths.js";
import type { RuntimeActionStateStore } from "../runtime/action-state.js";
import { defaultGitRunnerFactory, resolveBackend } from "../store/backend.js";
import type { FileBackend, SessionOnlyReason } from "../store/backend.js";
import type { CwdGitRunnerFactory, GitRepository, GitRunner, NavigationState } from "../types.js";
import {
  expireRepository,
  startBootHousekeeping,
  sweepPrivateRepoRetention,
} from "./housekeeping.js";
import { SessionNavigation } from "./navigation.js";
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
  return new SessionNavigation(
    {
      getLeafId: () => manager.getLeafId(),
      getBranch: (fromId) => manager.getBranch(fromId),
      getEntry: (id) => manager.getEntry(id),
    },
    backend?.kind === "git" ? backend.git : gitRunnerFactory(ctx.cwd),
    gitForRepository ?? ((repository) => gitRunnerFactory(repository.worktree)),
    async (state) => {
      const activeSessionLeaf = manager.getLeafId();
      const [saved] = await Promise.allSettled([
        store?.save(state),
        runtimeStore.publishNavigation(sessionId, state, activeSessionLeaf),
      ]);
      // Rejecting keeps an in-flight restore's intent: the cursor is not durable.
      if (saved.status === "rejected") throw saved.reason;
    },
    undefined,
    store && {
      save: (intent) => store.saveRestoreIntent(intent),
      clear: () => store.clearRestoreIntent(),
    },
  );
}

export function notifySessionOnly(
  services: ExtensionServices,
  ctx: AnyContext,
  sessionId: string,
  reason: SessionOnlyReason,
): void {
  if (!ctx.ui?.notify) return;
  const key = `${sessionId}\0${reason}`;
  if (services.notifiedSessionReasons.has(key)) return;
  services.notifiedSessionReasons.add(key);
  ctx.ui.notify(NOTIFICATION_MESSAGES[reason], "warning");
}

/** `historyLeafId` bounds the history rebuilt when no stored one loads: a
 *  finalize passes its turn-start leaf, or the turn it is about to record
 *  would be rebuilt from the branch and then recorded a second time. */
export async function initializeNavigation(
  services: ExtensionServices,
  ctx: AnyContext,
  replaceExisting: boolean,
  historyLeafId: string | null = ctx.sessionManager.getLeafId(),
): Promise<SessionNavigation> {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionHash = checkpointNamespace(sessionId);
  services.explicitActiveHashes.add(sessionHash);
  const state = stateOf(services, sessionId);
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
    const loadResult = store ? await store.load(ctx.sessionManager) : null;
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
    let navigationState = restored ?? reconstructSessionHistory(ctx.sessionManager, historyLeafId);
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
 *  let a later turn snapshot. */
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
      (cached.reason === "private_repository_unavailable" || cached.reason === "store_unavailable")
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
