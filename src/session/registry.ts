import { SHUTDOWN_BUDGET_MS, SHUTDOWN_TURN_DRAIN_MS } from "../host-contract.js";
import type { AnyContext } from "../host-contract.js";
import { historyDirectory } from "../history/layout.js";
import { touchSessionHeartbeat } from "../history/liveness.js";
import { timedOutAfter, track } from "../infra/async.js";
import { checkpointNamespace } from "../infra/paths.js";
import type { ActionId, PendingTurnCheckpoint } from "../types.js";
import { ensureNavigation, initializeNavigation, stateOf } from "./controller.js";
import { isMainSession, runShutdownHousekeeping } from "./housekeeping.js";
import type { SessionNavigation } from "./navigation.js";
import type { ExtensionServices } from "./services.js";
import { agentEnd } from "./turn-end.js";
import { beforeAgentStart, releasePending, toolCall } from "./turn-start.js";

/** Why `/undo` or `/redo` cannot run now, or the navigation to run it on. */
export type CommandNavigation =
  | { status: "ready"; navigation: SessionNavigation }
  | { status: "subagent" | "capturing" | "finalizing" | "closing" };

/** The one entry point `host/` uses into `session/`. */
export type SessionRegistry = {
  publishActionResult(
    sessionId: string,
    navigation: SessionNavigation,
    ctx: AnyContext,
    id: ActionId,
    token: string,
    applied: boolean,
  ): Promise<void>;
  commandNavigation(
    typed: AnyContext,
    waitForIdle: () => Promise<void>,
  ): Promise<CommandNavigation>;
  sessionStart(typed: AnyContext): Promise<void>;
  sessionTree(
    typed: AnyContext,
    event: { oldLeafId: string | null; newLeafId: string | null },
  ): Promise<void>;
  rememberNavigationSource(event: unknown, ctx: unknown): void;
  adoptSwitchedSession(typed: AnyContext): Promise<void>;
  beforeAgentStart(typed: AnyContext): Promise<void>;
  toolCall(typed: AnyContext): Promise<void>;
  agentEnd(typed: AnyContext): Promise<void>;
  shutdown(): Promise<void>;
};

/** Every session of this extension copy: session lifecycle events, switching
 *  away from a session, the liveness heartbeat, and shutdown. */
export function createRegistry(services: ExtensionServices): SessionRegistry {
  const { sessions } = services;
  let shutdownPromise: Promise<void> | null = null;

  // Cross-process liveness beats: load/save touch .active markers, but a
  // session left open and idle would otherwise go stale past the heartbeat
  // TTL while its owner process is still running. A slow unref'd interval
  // re-asserts liveness for exactly the locally active sessions (the same
  // set the sweeps already treat as protected), so foreign sweepers never
  // see a live session as expired. Sessions left via a switch drop out of
  // that set (releaseLeftSession). Deliberately not `backend`: membership
  // there is a cache entry, not liveness.
  const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
  const heartbeatTimer = setInterval(() => {
    const tracked = new Set<string>([
      ...[...sessions].flatMap(([id, s]) => (s.navigation === undefined ? [] : [id])),
      ...[...sessions].flatMap(([id, s]) => (s.initialization === undefined ? [] : [id])),
      ...[...sessions].flatMap(([id, s]) => (s.pending === undefined ? [] : [id])),
    ]);
    for (const sessionId of tracked) {
      const backend = sessions.get(sessionId)?.backend;
      if (!backend || backend.kind === "session") continue;
      const sessionHash = checkpointNamespace(sessionId);
      void touchSessionHeartbeat(historyDirectory(backend.repository), sessionHash);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const navigations = (): SessionNavigation[] =>
    [...sessions.values()].flatMap((s) => (s.navigation === undefined ? [] : [s.navigation]));

  async function publishActionResult(
    sessionId: string,
    navigation: SessionNavigation,
    ctx: AnyContext,
    id: ActionId,
    token: string,
    applied: boolean,
  ): Promise<void> {
    await services.runtimeStore.publishActionResult(
      sessionId,
      navigation.snapshot(),
      ctx.sessionManager.getLeafId(),
      { id, applied, token },
    );
  }

  /** `/undo` and `/redo`: the session's navigation once the last turn's
   *  capture and finalize settled. */
  async function commandNavigation(
    typed: AnyContext,
    waitForIdle: () => Promise<void>,
  ): Promise<CommandNavigation> {
    if (!isMainSession(services, typed)) return { status: "subagent" };
    const sessionId = typed.sessionManager.getSessionId();
    // Commands run even mid-stream: the turn's finalize only registers at
    // agent_end, so the guards below must be read after the idle wait.
    await waitForIdle();
    const state = sessions.get(sessionId);
    const guards: [Promise<unknown> | undefined, "capturing" | "finalizing"][] = [
      [state?.capture?.complete, "capturing"],
      [state?.finalize, "finalizing"],
    ];
    for (const [work, status] of guards) {
      if (work && (await timedOutAfter(work, services.captureDeadlineMs))) return { status };
    }
    const navigation = await ensureNavigation(services, typed);
    return navigation ? { status: "ready", navigation } : { status: "closing" };
  }

  async function suspendDetached(
    detachedNavigations: readonly SessionNavigation[],
    detachedPending: readonly PendingTurnCheckpoint[],
  ): Promise<void> {
    await Promise.allSettled([
      ...detachedNavigations.map((navigation) => navigation.suspend()),
      ...detachedPending.map((pendingCheckpoint) => releasePending(services, pendingCheckpoint)),
    ]);
  }

  async function invalidateAllRedo(): Promise<void> {
    await Promise.allSettled(navigations().map((navigation) => navigation.invalidateRedo()));
  }

  async function drainState(): Promise<void> {
    const detachedNavigations = navigations();
    const detachedPending = [...sessions.values()].flatMap((s) =>
      s.pending === undefined ? [] : [s.pending],
    );
    for (const s of sessions.values()) {
      s.navigation = undefined;
      s.pending = undefined;
    }
    await suspendDetached(detachedNavigations, detachedPending);
  }

  /** `/new`, `/resume`, fork and handoff leave `sessionId`. Keeping it in the
   *  local active set would beat its heartbeat and shield it from retention
   *  for the process's lifetime; a later resume reloads it from its persisted
   *  history, as after a restart. Its in-flight work settles first so the
   *  last turn still lands in that history. */
  async function releaseLeftSession(typed: AnyContext, sessionId: string): Promise<void> {
    const state = stateOf(services, sessionId);
    for (;;) {
      const busy = state.finalize ?? state.initialization ?? state.capture?.complete;
      if (!busy) break;
      await Promise.allSettled([busy]);
    }
    // Resumed (or reloaded) again meanwhile: it is live.
    if (services.flags.closing || typed.sessionManager.getSessionId() === sessionId) return;
    const navigation = state.navigation;
    const left = state.pending;
    state.navigation = undefined;
    state.pending = undefined;
    state.backend = undefined;
    state.turnStartLeaf = undefined;
    state.turnSequence = undefined;
    // Nothing in flight (the loop above) and nothing left: drop the record, as
    // a later resume rebuilds it. Only this exact record: a concurrent release
    // of the same id may already have replaced it with a resumed session's.
    if (sessions.get(sessionId) === state && Object.values(state).every((v) => v === undefined)) {
      sessions.delete(sessionId);
    }
    services.explicitActiveHashes.delete(checkpointNamespace(sessionId));
    await Promise.all([
      services.runtimeStore.releaseSession(sessionId),
      suspendDetached(navigation ? [navigation] : [], left ? [left] : []),
    ]);
  }

  async function sessionStart(typed: AnyContext): Promise<void> {
    if (services.flags.closing) return;
    if (!isMainSession(services, typed)) return;
    const sessionId = typed.sessionManager.getSessionId();
    const state = stateOf(services, sessionId);
    const previousPending = state.pending;
    state.pending = undefined;
    if (previousPending) await releasePending(services, previousPending);
    state.turnStartLeaf = undefined;
    state.turnSequence = undefined;
    // An in-flight capture for this session no longer belongs to a live turn:
    // it self-releases on completion via the identity check in beginCapture.
    state.capture = undefined;
    state.beforeSnapshotGate = undefined;
    if (services.flags.closing) return;
    await initializeNavigation(services, typed, true);
  }

  async function sessionTree(
    typed: AnyContext,
    event: { oldLeafId: string | null; newLeafId: string | null },
  ): Promise<void> {
    if (services.flags.closing) return;
    const navigation = sessions.get(typed.sessionManager.getSessionId())?.navigation;
    if (!navigation) return;
    await navigation.handleSessionTreeNavigation(event.oldLeafId, event.newLeafId);
  }

  // Switch and branch share one slot; if it is empty (never set, or clobbered by
  // an interleaved navigation) the post-event invalidates every session's redo,
  // which is a safe superset, and releases no session (unknown source).
  const rememberNavigationSource = (_event: unknown, ctx: unknown): void => {
    if (services.flags.closing) return;
    services.flags.pendingNavigationSourceSessionId = (
      ctx as AnyContext
    ).sessionManager.getSessionId();
  };

  // The host emits no `session_start` for the session it switched to, so its
  // navigation is built here, before any turn: built lazily by that turn's
  // finalize, it would rebuild a branch that already holds the turn.
  async function adoptSwitchedSession(typed: AnyContext): Promise<void> {
    if (services.flags.closing) return;
    if (!isMainSession(services, typed)) return;
    const sourceSessionId = services.flags.pendingNavigationSourceSessionId;
    services.flags.pendingNavigationSourceSessionId = null;
    if (sourceSessionId) {
      await sessions.get(sourceSessionId)?.navigation?.invalidateRedo();
      // Detached: the switch must not wait out the source's deferred finalize.
      void track(() => releaseLeftSession(typed, sourceSessionId), services.activeOperations);
    } else {
      await invalidateAllRedo();
    }
    // Keeps a live navigation (same-id reload, or a resume racing the
    // release above); otherwise loads the stored history.
    await ensureNavigation(services, typed);
  }

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    services.flags.closing = true;
    services.flags.pendingNavigationSourceSessionId = null;
    const detachedNavigations = navigations();
    const detachedPending = [...sessions.values()].flatMap((s) =>
      s.pending === undefined ? [] : [s.pending],
    );
    for (const s of sessions.values()) {
      s.navigation = undefined;
      s.initialization = undefined;
      s.pending = undefined;
    }
    shutdownPromise = (async () => {
      clearInterval(heartbeatTimer);
      // Priority order: whatever OMP's cap cuts off runs on in the background
      // and is lost only if the process exits first.
      const teardown = (async () => {
        try {
          // Local cleanup first: idle index leases (a checked-out one may sit
          // under a running git) and the runtime directory.
          await Promise.all([
            services.leasePool.releasePersistentSnapshotIndices(services.leaseSessionIds, {
              inUse: false,
            }),
            services.runtimeStore.shutdown(),
          ]);
          await suspendDetached(detachedNavigations, detachedPending);
          // Turn work only, never gcs or sweeps. A capture or finalize still
          // running after this releases its own checkpoint on completion
          // (closing is set); the boot sweep reclaims an index it leaves behind.
          await timedOutAfter(
            Promise.allSettled([
              ...services.activeOperations,
              ...[...sessions.values()].flatMap((s) =>
                s.finalize === undefined ? [] : [s.finalize],
              ),
            ]),
            SHUTDOWN_TURN_DRAIN_MS,
          );
          await services.leasePool.releasePersistentSnapshotIndices(services.leaseSessionIds);
          await drainState();
          await services.ownerRegistry.shutdown();
        } finally {
          // Even when a step above rejected: a failed subagent shutdown must
          // not pin its pool in `livePools` for the process's lifetime.
          services.leasePool.dispose();
        }
      })();
      // A git step that overran the budget must not cost the checked-out
      // leases: drop them now, filesystem only.
      if (await timedOutAfter(teardown, SHUTDOWN_BUDGET_MS)) {
        await services.leasePool.releasePersistentSnapshotIndices(services.leaseSessionIds);
      }
      void runShutdownHousekeeping(services, teardown);
    })();
    return shutdownPromise;
  }

  return {
    publishActionResult,
    commandNavigation,
    sessionStart,
    sessionTree,
    rememberNavigationSource,
    adoptSwitchedSession,
    beforeAgentStart: (typed) => beforeAgentStart(services, typed),
    toolCall: (typed) => toolCall(services, typed),
    agentEnd: (typed) => agentEnd(services, typed),
    shutdown,
  };
}
