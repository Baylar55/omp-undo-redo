import type { AnyContext } from "../host-contract.js";
import { timedOutAfter } from "../infra/async.js";
import { debugLog } from "../infra/debug-log.js";
import { finishAfterTurn } from "../snapshot/capture.js";
import { releaseCheckpoint, retainCheckpointForResume } from "../snapshot/checkpoint-refs.js";
import type { SessionOnlyCheckpoint } from "../types.js";
import { createNavigation, ensureNavigation, notifySessionOnly, stateOf } from "./controller.js";
import type { SessionNavigation } from "./navigation.js";
import type { ExtensionServices, PendingCapture } from "./services.js";
import { releasePending } from "./turn-start.js";

function beginFinalizeTurn(
  services: ExtensionServices,
  typed: AnyContext,
  capture: PendingCapture,
  leafId: string | null,
  turnStartLeaf: string | null,
): Promise<void> {
  const sessionId = typed.sessionManager.getSessionId();
  const state = stateOf(services, sessionId);
  // Claim the capture: from here its checkpoint is this finalize's alone.
  // Taking the slot matters because the gate below can defer this finalize
  // past the next `before_agent_start`, which releases whatever `pending`
  // still holds.
  capture.owned = true;
  if (capture.checkpoint && state.pending === capture.checkpoint) {
    state.pending = undefined;
  }
  // Read here, not inside the finalize: a deferred finalize runs after the
  // next turn already bumped the counter, and the comparison below is
  // exactly what detects that.
  const turnSequence = state.turnSequence;
  // An earlier turn whose capture overran its deadline may still be
  // finalizing. Its checkpoint must land in the history before this turn's,
  // or the recorded order would not match the turn order (and a session-only
  // boundary would convert file checkpoints that are not yet recorded).
  const previousFinalize = state.finalize;
  const ready = previousFinalize ? previousFinalize.then(() => capture.complete) : capture.complete;
  let handlerRelease!: () => void;
  const handlerDone = new Promise<void>((resolve) => {
    handlerRelease = resolve;
  });
  const work = (async () => {
    try {
      if (await timedOutAfter(ready, services.captureDeadlineMs)) {
        // The capture (or the previous turn's finalize) overran the handler
        // deadline. Keep this turn's finalize identity-bound — same capture,
        // same leaf, same turn-start leaf, same context — so when it settles
        // it finalizes its own checkpoint instead of a later turn's.
        handlerRelease();
        await ready;
        await finalizeTurn(
          services,
          typed,
          sessionId,
          capture,
          leafId,
          turnStartLeaf,
          turnSequence,
        );
        return;
      }
      await finalizeTurn(services, typed, sessionId, capture, leafId, turnStartLeaf, turnSequence);
    } finally {
      handlerRelease();
    }
  })();
  // Undo/redo wait on this; it stays registered across a deferred
  // continuation so the commands cannot slip in before the turn is recorded.
  const tracked = work.then(
    () => undefined,
    // Best-effort diagnostics only: the tracked promise must stay
    // never-rejecting for awaiting undo/redo handlers.
    (error) => {
      // eslint-disable-next-line no-console
      console.error("[omp-undo-redo] finalize failed", error);
      debugLog({
        event: "finalize failed",
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
    },
  );
  state.finalize = tracked;
  // A slow after-snapshot must not hold the handler past the host cap. The
  // early return is the same state as the deferred path above: the work
  // stays in `finalize`, and overlapping turns are safe (index leases are
  // checked out per run; `turnSequence` flags the gap).
  void timedOutAfter(tracked, services.finalizeDeadlineMs).then(() => handlerRelease());
  void tracked.then(() => {
    if (state.finalize === tracked) state.finalize = undefined;
  });
  return handlerDone;
}

/** The navigation for `sessionId`, creating and publishing one when the
 *  session has none (a turn can finalize before any navigation was built).
 *  `typed.sessionManager` is live: a deferred finalize can outlive a `/new` or
 *  `/resume`, and then a navigation built from it would belong to the wrong
 *  session. Null means the session cannot be resolved safely. */
async function resolveNavigation(
  services: ExtensionServices,
  typed: AnyContext,
  sessionId: string,
  turnStartLeaf: string | null,
): Promise<SessionNavigation | null> {
  const state = stateOf(services, sessionId);
  const known = state.navigation ?? (await state.initialization);
  if (known) return known;
  if (typed.sessionManager.getSessionId() !== sessionId) return null;
  const nav =
    (await ensureNavigation(services, typed, turnStartLeaf)) ??
    createNavigation(
      typed,
      sessionId,
      undefined,
      services.runtimeStore,
      undefined,
      services.gitRunnerFor,
      services.gitRunnerFactory,
    );
  state.navigation = nav;
  return nav;
}

/** Records a turn without a file checkpoint and warns once per (session,
 *  reason): otherwise a store that broke mid-session goes unnoticed until
 *  /undo. Backend reasons were announced at turn start; the key dedupes them. */
async function recordSessionOnly(
  services: ExtensionServices,
  typed: AnyContext,
  sessionId: string,
  checkpoint: SessionOnlyCheckpoint,
): Promise<void> {
  const nav = await resolveNavigation(services, typed, sessionId, checkpoint.parentLeafId);
  if (!nav) return;
  await nav.recordTurnEnd(checkpoint);
  // A deferred finalize can outlive a session switch: never warn the new one.
  if (typed.sessionManager.getSessionId() === sessionId) {
    notifySessionOnly(services, typed, sessionId, checkpoint.reason);
  }
}

async function finalizeTurn(
  services: ExtensionServices,
  typed: AnyContext,
  sessionId: string,
  capture: PendingCapture,
  leafId: string | null,
  turnStartLeaf: string | null,
  turnSequence: number | undefined,
): Promise<void> {
  await capture.complete;
  const before = capture.checkpoint;
  if (!before) return;
  // Consume the checkpoint: exactly one finalize (this turn's) may record it.
  capture.checkpoint = null;
  // The checkpoint must belong to the turn that is finalizing: its pre-turn
  // leaf must be the turn-start leaf captured when this finalize was first
  // invoked. If a later turn's finalize reaches it first, releasing the
  // stale checkpoint is safer than recording it with the wrong leaf (which
  // would make an undo restore the wrong pre-turn state).
  if (before.parentLeafId !== turnStartLeaf) {
    await releasePending(services, before);
    return;
  }
  if (services.flags.closing) {
    await releasePending(services, before);
    return;
  }

  let completed: SessionOnlyCheckpoint | undefined;
  if (before.kind === "session") {
    completed = {
      kind: "session",
      reason: before.reason,
      parentLeafId: before.parentLeafId,
      leafId: leafId,
    };
  } else {
    const result = await finishAfterTurn(
      services.gitRunnerFor(before.repository),
      before,
      before.parentLeafId,
      leafId,
      services.leasePool,
    );
    if (result.status === "git") {
      if (services.flags.closing) {
        await releaseCheckpoint(
          services.gitRunnerFor(result.checkpoint.repository),
          result.checkpoint,
        );
        return;
      }
      // The next turn started before this after-snapshot finished, so the
      // snapshot also contains that turn's edits: restoring from it would
      // revert two turns of file changes while moving one session boundary.
      // Only this turn loses its file checkpoint — every earlier turn's
      // stays restorable, and `applyCheckpoint` patches rather than checks
      // out, so it reports a conflict instead of clobbering unrecorded
      // edits when an older restore crosses this gap.
      if (services.sessions.get(sessionId)?.turnSequence !== turnSequence) {
        await releaseCheckpoint(
          services.gitRunnerFor(result.checkpoint.repository),
          result.checkpoint,
        );
        await recordSessionOnly(services, typed, sessionId, {
          kind: "session",
          reason: "file_history_gap",
          parentLeafId: before.parentLeafId,
          leafId,
        });
        return;
      }
      const nav = await resolveNavigation(services, typed, sessionId, before.parentLeafId);
      if (!nav) {
        await releaseCheckpoint(
          services.gitRunnerFor(result.checkpoint.repository),
          result.checkpoint,
        );
        return;
      }
      const retained = await retainCheckpointForResume(
        services.gitRunnerFor(result.checkpoint.repository),
        sessionId,
        result.checkpoint,
      );
      await nav.recordTurnEnd(retained);
      return;
    }
    completed = {
      kind: "session",
      reason: result.reason,
      parentLeafId: before.parentLeafId,
      leafId: leafId,
    };
  }
  await recordSessionOnly(services, typed, sessionId, completed);
}

export async function agentEnd(services: ExtensionServices, typed: AnyContext): Promise<void> {
  const sessionId = typed.sessionManager.getSessionId();
  // A lookup, not stateOf: a turn with no record (a subagent's) has nothing to
  // finalize and must not leave an empty record behind.
  const state = services.sessions.get(sessionId);
  if (!state) return;
  const turnStartLeaf = state.turnStartLeaf ?? null;
  const own = state.pending ?? null;
  // Prefer this turn's own boundary. An in-flight capture belonging to an
  // earlier turn (the guard in before_agent_start skipped this turn's
  // capture) must not be finalized here: it is this turn's leaf that would
  // be attached to it, and the earlier turn's own deferred finalize is
  // already waiting to record it correctly.
  const capture = own?.parentLeafId === turnStartLeaf ? undefined : state.capture;
  // A capture that already settled leaves no entry (its finally deletes
  // it), but its checkpoint stays in the pending map — finalize from that.
  const settled = capture ? null : own;
  if (!capture && !settled) return;
  await beginFinalizeTurn(
    services,
    typed,
    capture ?? { complete: Promise.resolve(), checkpoint: settled },
    typed.sessionManager.getLeafId(),
    turnStartLeaf,
  );
}
