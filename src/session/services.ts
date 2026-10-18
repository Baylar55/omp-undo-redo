import {
  DEFAULT_CAPTURE_DEADLINE_MS,
  DEFAULT_FINALIZE_DEADLINE_MS,
  DEFAULT_TOOL_CALL_DEADLINE_MS,
} from "../host-contract.js";
import { readRetentionDays } from "../history/retention.js";
import { RuntimeActionStateStore } from "../runtime/action-state.js";
import { IndexLeasePool } from "../snapshot/index-leases.js";
import { defaultGitRunnerFactory } from "../store/backend.js";
import type { FileBackend, PrivateRepoEntry } from "../store/backend.js";
import { snapshotRunnerEnv } from "../store/git-store.js";
import { resolvePersistentHostId, resolveRuntimeScope } from "../store/host-identity.js";
import { GcQueue } from "../store/maintenance/gc.js";
import { CheckpointOwnerRegistry } from "../store/owners.js";
import type {
  CwdGitRunnerFactory,
  GitRepository,
  GitRunner,
  PendingTurnCheckpoint,
} from "../types.js";
import type { SessionNavigation } from "./navigation.js";

export type PendingCapture = {
  complete: Promise<void>;
  checkpoint: PendingTurnCheckpoint | null;
  /** Set when a finalize claims this capture. An owned capture's checkpoint
   *  belongs to that finalize alone: it is never published into `pending`
   *  (where the next turn would release it mid-finalize), and it is never
   *  released by the capture itself. An unowned capture whose turn is gone
   *  has no finalize coming, so it releases its own checkpoint. */
  owned?: boolean;
};

/** One session's turn and navigation state. A field left `undefined` means
 *  "no entry": `turnStartLeaf` may hold `null` (a turn started on an empty
 *  session), which is a value, not an absence. */
export type SessionState = {
  navigation?: SessionNavigation;
  initialization?: Promise<SessionNavigation>;
  backend?: FileBackend;
  /** The CURRENT turn's checkpoint while no finalize owns it. Anything left
   *  here when the next turn starts is released: ownership is what keeps a
   *  deferred finalize's checkpoint alive (see `PendingCapture.owned`). */
  pending?: PendingTurnCheckpoint;
  capture?: PendingCapture;
  finalize?: Promise<void>;
  /** Leaf the current turn started from. Used to bind a checkpoint to the
   *  turn that captured it: a deferred finalize whose checkpoint predates the
   *  current turn is released, never recorded with the wrong leaf. */
  turnStartLeaf?: string | null;
  /** The current turn's in-flight before-snapshot. `before_agent_start`
   *  stops waiting at the handler deadline, so the agent's tools can run while
   *  git is still reading the workspace. Tool calls wait on `complete`; one
   *  that gives up sets `late`, and the capture then discards its snapshot
   *  (it may hold the turn's own edits) instead of recording a wrong baseline. */
  beforeSnapshotGate?: { complete: Promise<void>; late: boolean };
};

export type OmpUndoRedoDependencies = {
  /** Overrides how git runners are created, letting hosts and tests inject
   *  behavior (e.g. slowing captures to exercise the bounded handler path).
   *  Receives the canonical worktree and an optional fixed env (used for
   *  private per-workspace repositories). */
  gitRunnerFactory?: CwdGitRunnerFactory;
  /** How long the before_agent_start / agent_end / undo / redo handlers wait
   *  for an in-flight checkpoint capture before returning without it. The
   *  capture keeps running and the turn is finalized when it settles. */
  captureDeadlineMs?: number;
  /** How long a `tool_call` waits for the turn's before-snapshot. Must stay
   *  under the host's 30 s `tool_call` cap, which blocks the tool on timeout. */
  toolCallDeadlineMs?: number;
  /** How long `agent_end` waits for the turn's finalize (after-snapshot and
   *  history write) before returning. Must stay under the host's 30 s handler
   *  cap; the finalize keeps running and undo/redo still wait on it. */
  finalizeDeadlineMs?: number;
};

/** Everything one extension copy shares across its sessions. A data holder:
 *  logic lives in the session modules, which take it as first parameter. */
export type ExtensionServices = {
  gitRunnerFactory: CwdGitRunnerFactory;
  captureDeadlineMs: number;
  toolCallDeadlineMs: number;
  finalizeDeadlineMs: number;
  retentionDays: number;
  privateRepositories: Map<string, PrivateRepoEntry>;
  ownerRegistry: CheckpointOwnerRegistry;
  /** Joined on the first navigation, not at load: a subagent's copy never
   *  builds one, so it never holds the process's runtime directory. */
  runtimeStore: RuntimeActionStateStore;
  gcQueue: GcQueue;
  leasePool: IndexLeasePool;
  bootEviction: Promise<void> | null;
  privateRetentionSweep: Promise<void> | null;
  /** One record per session id. Only `releaseLeftSession` removes one, and
   *  only once the session's finalize, initialization and capture settled (the
   *  only work that writes to a record it read before an `await`), the
   *  session is no longer current, and every field is empty. */
  sessions: Map<string, SessionState>;
  /** Turns started in this copy, across all its sessions: every session
   *  shares the workspace, so an after-snapshot still running when ANY next
   *  turn starts also holds that turn's edits, which makes it unrestorable.
   *  Never reset, so a session start cannot make a stale value match again. */
  turnSequence: number;
  /** Turn work (captures, finalizes, session events) shutdown waits on. */
  activeOperations: Set<Promise<void>>;
  /** Background store gcs and retention sweeps: shutdown never waits on them
   *  (a repack can take minutes), but eviction defers to them too. */
  housekeepingOperations: Set<Promise<void>>;
  expirationPromises: Map<string, Promise<void>>;
  explicitActiveHashes: Set<string>;
  /** Keyed `${sessionId}\0${reason}`: session ids are UUIDs, so the separator
   *  cannot collide. Never pruned: a re-resumed session is not notified again. */
  notifiedSessionReasons: Set<string>;
  /** Sessions this copy captured for, i.e. whose index leases it owns. */
  leaseSessionIds: Set<string>;
  flags: {
    closing: boolean;
    /** OMP binds a separate copy of this extension to every in-process
     *  subagent session (`ctx.agent.kind === "sub"`); see `isMainSession`. */
    servesMainSession: boolean;
    servesSubagent: boolean;
    pendingNavigationSourceSessionId: string | null;
  };
  gitRunnerFor(repository: GitRepository): GitRunner;
};

export function createServices(deps: OmpUndoRedoDependencies): ExtensionServices {
  const retentionDays = readRetentionDays();
  const privateRepositories = new Map<string, PrivateRepoEntry>();
  const gitRunnerFactory = deps.gitRunnerFactory ?? defaultGitRunnerFactory;
  const captureDeadlineMs = deps.captureDeadlineMs ?? DEFAULT_CAPTURE_DEADLINE_MS;
  const toolCallDeadlineMs = deps.toolCallDeadlineMs ?? DEFAULT_TOOL_CALL_DEADLINE_MS;
  const finalizeDeadlineMs = deps.finalizeDeadlineMs ?? DEFAULT_FINALIZE_DEADLINE_MS;
  function gitRunnerFor(repository: GitRepository): GitRunner {
    const entry =
      privateRepositories.get(repository.worktree) ?? privateRepositories.get(repository.commonDir);
    if (entry && "git" in entry && entry.git && entry.repository?.gitDir === repository.gitDir) {
      return entry.git;
    }
    return gitRunnerFactory(repository.worktree, snapshotRunnerEnv(repository));
  }
  const ownerRegistry = new CheckpointOwnerRegistry({
    resolveHostIdentity: resolvePersistentHostId,
    resolveRuntimeScope,
  });
  const runtimeStore = new RuntimeActionStateStore();
  return {
    gitRunnerFactory,
    captureDeadlineMs,
    toolCallDeadlineMs,
    finalizeDeadlineMs,
    retentionDays,
    privateRepositories,
    ownerRegistry,
    runtimeStore,
    gcQueue: new GcQueue(gitRunnerFactory),
    leasePool: new IndexLeasePool(),
    bootEviction: null,
    privateRetentionSweep: null,
    sessions: new Map(),
    turnSequence: 0,
    activeOperations: new Set(),
    housekeepingOperations: new Set(),
    expirationPromises: new Map(),
    explicitActiveHashes: new Set(),
    notifiedSessionReasons: new Set(),
    leaseSessionIds: new Set(),
    flags: {
      closing: false,
      servesMainSession: false,
      servesSubagent: false,
      pendingNavigationSourceSessionId: null,
    },
    gitRunnerFor,
  };
}
