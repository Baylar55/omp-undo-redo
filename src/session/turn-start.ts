import type { AnyContext } from "../host-contract.js";
import { timedOutAfter, track } from "../infra/async.js";
import { debugLog } from "../infra/debug-log.js";
import { prepareBeforeTurn } from "../snapshot/capture.js";
import { releasePendingCheckpoint } from "../snapshot/checkpoint-refs.js";
import { runCaptureGc } from "../store/maintenance/gc.js";
import type { PendingTurnCheckpoint } from "../types.js";
import { notifySessionOnly, stateOf, turnBackend } from "./controller.js";
import { gcKey, isMainSession } from "./housekeeping.js";
import type { ExtensionServices, PendingCapture } from "./services.js";

export async function releasePending(
  services: ExtensionServices,
  pendingCheckpoint: PendingTurnCheckpoint,
  keepIndex = false,
): Promise<void> {
  if (pendingCheckpoint.kind === "git") {
    await releasePendingCheckpoint(
      services.gitRunnerFor(pendingCheckpoint.repository),
      pendingCheckpoint,
      services.leasePool,
      keepIndex,
    );
  }
}

export function beginCapture(
  services: ExtensionServices,
  sessionId: string,
  task: () => Promise<PendingTurnCheckpoint>,
): PendingCapture {
  const state = stateOf(services, sessionId);
  // Read before the task runs: the next turn may move turnStartLeaf on.
  const parentLeafId = state.turnStartLeaf ?? null;
  const { promise: complete, resolve } = Promise.withResolvers<void>();
  const capture: PendingCapture = { complete, checkpoint: null };
  void track(async () => {
    try {
      // A capture that throws still owes its turn a boundary, or the turn
      // drops out of the history and undo rewinds it with the turn before.
      const checkpoint = await task().catch((error: unknown): PendingTurnCheckpoint => {
        debugLog({
          event: "capture failed",
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
        });
        return { kind: "session", reason: "before_snapshot_failed", parentLeafId };
      });
      // The capture's own turn is over once turnStartLeaf moved on. Its
      // checkpoint then belongs to the finalize that claimed this capture —
      // and to nobody at all if no `agent_end` ever claimed it (two
      // `before_agent_start` events without one in between), in which case
      // this is the only place left that can release it.
      const ownTurn = state.turnStartLeaf === checkpoint.parentLeafId;
      if (services.flags.closing || state.capture !== capture || !(ownTurn || capture.owned)) {
        await releasePending(services, checkpoint);
      } else {
        capture.checkpoint = checkpoint;
        // `pending` holds only unowned checkpoints: publishing an owned one
        // would let the next turn's `before_agent_start` release it while
        // its finalize is still deferred.
        if (ownTurn && !capture.owned) state.pending = checkpoint;
        if (checkpoint.kind === "git") {
          const { repository } = checkpoint;
          const capturesInFlight = [...services.sessions.values()].filter(
            (s) => s.capture !== undefined,
          ).length;
          if (services.gcQueue.countCapture(gcKey(repository), capturesInFlight > 1)) {
            void track(
              () => services.gcQueue.schedule(repository, runCaptureGc),
              services.housekeepingOperations,
            );
          }
        }
      }
    } catch {
      // Nothing to unwind: the finally below unblocks waiters.
    } finally {
      resolve();
      if (state.capture === capture) state.capture = undefined;
    }
  }, services.activeOperations);
  state.capture = capture;
  return capture;
}

export async function beforeAgentStart(
  services: ExtensionServices,
  typed: AnyContext,
): Promise<void> {
  if (services.flags.closing) return;
  if (!isMainSession(services, typed)) return;
  const sessionId = typed.sessionManager.getSessionId();
  const state = stateOf(services, sessionId);
  const oldPending = state.pending;
  state.pending = undefined;
  state.beforeSnapshotGate = undefined;
  if (oldPending) await releasePending(services, oldPending);

  // Record the leaf this turn starts from, then bound concurrent captures:
  // a turn that starts while the previous turn's capture is still in flight
  // gets no new capture instead of stacking overlapping `git add` runs over
  // the same workspace. Its boundary is recorded as session-only right
  // here — leaving `pending` empty would drop the turn from the history
  // entirely, because agent_end would then finalize the earlier turn's
  // in-flight capture and this turn would produce no checkpoint at all.
  const turnStartLeaf = typed.sessionManager.getLeafId();
  state.turnStartLeaf = turnStartLeaf;
  services.turnSequence += 1;
  if (state.capture !== undefined) {
    state.pending = {
      kind: "session",
      reason: "before_snapshot_failed",
      parentLeafId: turnStartLeaf,
    };
    return;
  }

  const backend = await turnBackend(services, typed, sessionId);
  state.backend = backend;
  if (backend.kind === "session") {
    notifySessionOnly(services, typed, sessionId, backend.reason);
  }
  if (backend.kind === "git") services.leaseSessionIds.add(sessionId);
  const gate = { complete: Promise.resolve(), late: false };
  const capture = beginCapture(services, sessionId, async () => {
    const prepared =
      backend.kind === "git"
        ? await prepareBeforeTurn(
            backend.git,
            sessionId,
            services.leasePool,
            services.ownerRegistry,
            backend.repository,
          )
        : { status: "session_only" as const, reason: backend.reason };
    // Bound to the leaf recorded above, never a fresh getLeafId(): the
    // finalize identity check and the pending-slot check both compare
    // against that value.
    const checkpoint: PendingTurnCheckpoint =
      prepared.status === "git"
        ? { ...prepared.checkpoint, parentLeafId: turnStartLeaf }
        : { kind: "session", reason: prepared.reason, parentLeafId: turnStartLeaf };
    // A tool ran before this snapshot finished, so it may contain the
    // turn's own edits: undo would "restore" them and report success.
    // Only the ref is wrong; the index is a valid stat cache of a real
    // worktree read. Deleting it would make the next turn re-hash from
    // scratch, overrun again, and never get a checkpoint.
    if (checkpoint.kind === "git" && gate.late) {
      await releasePending(services, checkpoint, true).catch(() => undefined);
      return { kind: "session", reason: "before_snapshot_failed", parentLeafId: turnStartLeaf };
    }
    return checkpoint;
  });
  gate.complete = capture.complete;
  state.beforeSnapshotGate = gate;
  void capture.complete.then(() => {
    if (state.beforeSnapshotGate === gate) state.beforeSnapshotGate = undefined;
  });
  await timedOutAfter(capture.complete, services.captureDeadlineMs);
}

export async function toolCall(services: ExtensionServices, typed: AnyContext): Promise<void> {
  const gate = services.sessions.get(typed.sessionManager.getSessionId())?.beforeSnapshotGate;
  if (!gate || gate.late || services.flags.closing) return;
  if (await timedOutAfter(gate.complete, services.toolCallDeadlineMs)) gate.late = true;
}
