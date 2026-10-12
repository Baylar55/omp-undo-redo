import type { AnyContext } from "../host-contract.js";
import type { SessionHistoryStore } from "../history/store.js";
import { applyCheckpoint } from "../snapshot/restore.js";
import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  NavigationState,
  RestoreIntent,
} from "../types.js";
import { recoveryCompletedNotice, recoveryPartialNotice } from "./notices.js";

export type RestoreRecovery =
  /** No restore of `state` was in flight: the intent outlived a persisted cursor. */
  | { outcome: "stale" }
  /** The worktree is still at the source: nothing to do. */
  | { outcome: "unchanged" }
  /** Every file reached the target; `state` has the cursor moved to match. */
  | { outcome: "completed"; state: NavigationState }
  /** Files are neither at the source nor at the target. */
  | { outcome: "partial"; storeDir: string; sourceHash: string; targetHash: string }
  /** Git could not tell: keep the intent for the next load. */
  | { outcome: "unknown" };

/** Settles a restore the previous process was killed in the middle of.
 *  `applies(checkpoint, from, to)`: whether restoring `from` → `to` would
 *  apply to the worktree as it is (null: git failed). Applying cleanly from
 *  the source is the same check the next undo/redo makes, so it wins when
 *  both directions apply (an empty patch). Never writes a file. */
export async function recoverInterruptedRestore(
  state: NavigationState,
  intent: RestoreIntent,
  applies: (checkpoint: GitCheckpoint, from: string, to: string) => Promise<boolean | null>,
): Promise<RestoreRecovery> {
  const undo = intent.direction === "undo";
  const checkpoint = state.checkpoints[undo ? state.currentIndex : state.currentIndex + 1];
  if (
    checkpoint?.kind !== "git" ||
    checkpoint.beforeRef !== intent.beforeRef ||
    checkpoint.beforeHash !== intent.beforeHash ||
    checkpoint.afterRef !== intent.afterRef ||
    checkpoint.afterHash !== intent.afterHash
  )
    return { outcome: "stale" };
  const sourceHash = undo ? checkpoint.afterHash : checkpoint.beforeHash;
  const targetHash = undo ? checkpoint.beforeHash : checkpoint.afterHash;
  const atSource = await applies(checkpoint, sourceHash, targetHash);
  if (atSource === null) return { outcome: "unknown" };
  if (atSource) return { outcome: "unchanged" };
  const atTarget = await applies(checkpoint, targetHash, sourceHash);
  if (atTarget === null) return { outcome: "unknown" };
  if (!atTarget) {
    return { outcome: "partial", storeDir: checkpoint.repository.storeDir, sourceHash, targetHash };
  }
  return {
    outcome: "completed",
    state: {
      checkpoints: [...state.checkpoints],
      currentIndex: state.currentIndex + (undo ? -1 : 1),
    },
  };
}

/** Settles the restore a killed process left behind (`RestoreIntent`).
 *  Only the cursor moves: files are never written at load. */
export async function settleInterruptedRestore(
  ctx: AnyContext,
  store: SessionHistoryStore,
  state: NavigationState,
  intent: RestoreIntent,
  gitRunnerFor: (repository: GitRepository) => GitRunner,
): Promise<NavigationState> {
  const recovery = await recoverInterruptedRestore(state, intent, async (checkpoint, from, to) => {
    const { status } = await applyCheckpoint(gitRunnerFor(checkpoint.repository), from, to, true);
    return status === "failed" ? null : status === "applied";
  }).catch(() => ({ outcome: "unknown" as const }));
  if (recovery.outcome === "unknown") return state;
  const command = `/${intent.direction}`;
  if (recovery.outcome === "completed") {
    ctx.ui?.notify?.(recoveryCompletedNotice(command), "info");
    // Unsaved, the intent stays and the next load moves the cursor again.
    const saved = await store.save(recovery.state).then(
      () => true,
      () => false,
    );
    if (saved) await store.clearRestoreIntent().catch(() => undefined);
    return recovery.state;
  }
  if (recovery.outcome === "partial") {
    ctx.ui?.notify?.(
      recoveryPartialNotice(command, recovery.storeDir, recovery.sourceHash, recovery.targetHash),
      "warning",
    );
  }
  await store.clearRestoreIntent().catch(() => undefined);
  return state;
}
