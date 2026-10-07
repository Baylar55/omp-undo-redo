import "./core/compat.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs";
import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SessionEntryLike } from "./core/types.js";
import { runNavigation } from "./commands/navigate.js";
import {
  CheckpointOwnerRegistry,
  resolvePersistentHostId,
  resolveRuntimeScope,
} from "./core/checkpoint-owners.js";
import { createGitRunner } from "./core/git-runner.js";
import {
  canonicalCwd,
  ensureGitSnapshotStore,
  ensurePrivateGitRepository,
  GIT_STORE_SOURCE_KEY,
  refusedPrivateWorkspace,
  setupFinished,
  storeRootDirectory,
} from "./core/private-repo.js";
import { gcPendingPath } from "./core/git-refs.js";
import { migrateLegacySnapshots } from "./core/legacy-snapshot-migration.js";
import { SessionNavigation } from "./core/session-navigation.js";
import {
  checkpointNamespace,
  finishAfterTurn,
  pinStoreObjects,
  prepareBeforeTurn,
  releasePersistentSnapshotIndices,
  releaseCheckpoint,
  releasePendingCheckpoint,
  resolveRepository,
  retainCheckpointForResume,
  snapshotRunnerEnv,
  storeEnv,
} from "./core/checkpoints.js";
import {
  expireGitSessionHistories,
  historyDirectory,
  reconstructSessionHistory,
  SessionHistoryStore,
} from "./core/history-store.js";
import { touchSessionHeartbeat } from "./core/history-liveness.js";
import type {
  ActionId,
  CwdGitRunnerFactory,
  DiscoveredRepository,
  GitRepository,
  GitRunner,
  NavigationState,
  PendingTurnCheckpoint,
  SessionOnlyCheckpoint,
} from "./core/types.js";
import { RuntimeActionStateStore } from "./core/runtime-action-state-store.js";

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
  /** Absent on hosts older than OMP's agent identity: read as the main agent. */
  agent?: { kind: "main" | "sub" };
};

function readRetentionDays(): number {
  const days = parseInt(process.env.OMP_UNDO_REDO_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(days) && days >= 0 ? days : 2;
}

export type SessionOnlyReason =
  | "git_unavailable"
  | "repository_unresolvable"
  | "private_repository_unavailable"
  | "unsafe_workspace";

export type FileBackend =
  | { kind: "git"; repository: GitRepository; git: GitRunner }
  | { kind: "session"; reason: SessionOnlyReason };

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

export const DEFAULT_CAPTURE_DEADLINE_MS = 3_000;
export const DEFAULT_TOOL_CALL_DEADLINE_MS = 25_000;
export const DEFAULT_FINALIZE_DEADLINE_MS = 25_000;

function defaultGitRunnerFactory(cwd: string, env?: Record<string, string>): GitRunner {
  return createGitRunner(cwd, { env });
}

/** True when `ms` elapsed before `promise` settled. The promise keeps running;
 *  callers use this only to stop waiting, never to abandon the work. */
async function timedOutAfter(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), Math.max(1, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([promise.then(() => false), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per-controller snapshot-store state: a ready entry carries the repository
 *  and the store-bound runner, with `ready` resolving true once init
 *  completes; a `failure` entry records a failed Private-Git init so session
 *  fallback is reused without retrying. Keyed by canonical cwd (private) or
 *  worktree (git mode). */
type ActivePrivateRepoEntry = {
  repository?: GitRepository;
  git?: GitRunner;
  ready: Promise<boolean>;
};
export type PrivateRepoEntry = ActivePrivateRepoEntry | { failure: true };

type HistoryWriter = { save(state: NavigationState): Promise<void> };

function startPrivateRepo(
  canonical: string,
  gitRunnerFactory: CwdGitRunnerFactory,
): ActivePrivateRepoEntry {
  const storeRoot = storeRootDirectory();
  const entry: ActivePrivateRepoEntry = {
    repository: undefined,
    git: undefined,
    ready: Promise.resolve(false),
  };
  entry.ready = (async (): Promise<boolean> => {
    try {
      const repository = await ensurePrivateGitRepository(gitRunnerFactory, canonical, storeRoot);
      if (!repository) return false;
      entry.repository = repository;
      entry.git = gitRunnerFactory(canonical, { GIT_DIR: repository.gitDir });
      return true;
    } catch {
      return false;
    }
  })();
  return entry;
}

async function resolvePrivateGit(
  cwd: string,
  privateRepositories: Map<string, PrivateRepoEntry>,
  gitRunnerFactory: CwdGitRunnerFactory,
): Promise<{ repository: GitRepository; git: GitRunner } | null> {
  const canonical = canonicalCwd(cwd);
  const existing = privateRepositories.get(canonical);
  if (existing) {
    if ("failure" in existing) return null;
    const ok = await existing.ready;
    return ok && existing.repository && existing.git
      ? { repository: existing.repository, git: existing.git }
      : null;
  }
  const entry = startPrivateRepo(canonical, gitRunnerFactory);
  privateRepositories.set(canonical, entry);
  const ok = await entry.ready;
  if (!ok || !entry.repository || !entry.git) {
    privateRepositories.set(canonical, { failure: true });
    return null;
  }
  return { repository: entry.repository, git: entry.git };
}

/** Git mode: binds the worktree to its snapshot store, moving any snapshots an
 *  earlier version left in the user's `.git` into it first. */
function startGitStore(
  found: DiscoveredRepository,
  gitRunnerFactory: CwdGitRunnerFactory,
): ActivePrivateRepoEntry {
  const entry: ActivePrivateRepoEntry = { ready: Promise.resolve(false) };
  entry.ready = (async (): Promise<boolean> => {
    try {
      const storeDir = await ensureGitSnapshotStore(gitRunnerFactory, found, storeRootDirectory());
      if (!storeDir) return false;
      const repository: GitRepository = { ...found, storeDir };
      await migrateLegacySnapshots(gitRunnerFactory(found.worktree), repository).catch(
        () => undefined,
      );
      entry.repository = repository;
      // Rooted at the worktree, not at `cwd`: `git apply` silently ignores
      // patched paths outside its working directory, so a session started in
      // a subdirectory would restore only that subtree and still report
      // success. (`diff.relative=true` truncates the patch the same way.)
      entry.git = gitRunnerFactory(found.worktree, snapshotRunnerEnv(repository));
      return true;
    } catch {
      return false;
    }
  })();
  return entry;
}

export async function resolveBackend(
  cwd: string,
  privateRepositories: Map<string, PrivateRepoEntry> = new Map(),
  gitRunnerFactory: CwdGitRunnerFactory = defaultGitRunnerFactory,
): Promise<FileBackend> {
  const git = gitRunnerFactory(cwd);
  const resolved = await resolveRepository(git);
  if ("repository" in resolved) {
    const found = resolved.repository;
    // Keyed by `repository.worktree`, not `repository.commonDir`: linked
    // worktrees of the same repository share commonDir (and its store), so
    // keying by commonDir would make the second worktree reuse the first's
    // runner and run git operations in the wrong directory.
    let entry = privateRepositories.get(found.worktree);
    if (
      !entry ||
      "failure" in entry ||
      !(await entry.ready) ||
      entry.repository?.gitDir !== found.gitDir
    ) {
      entry = startGitStore(found, gitRunnerFactory);
      privateRepositories.set(found.worktree, entry);
    }
    if ((await entry.ready) && entry.repository && entry.git) {
      return { kind: "git", repository: entry.repository, git: entry.git };
    }
    if (privateRepositories.get(found.worktree) === entry)
      privateRepositories.delete(found.worktree);
    return { kind: "session", reason: "private_repository_unavailable" };
  }
  if (resolved.reason !== "not_repository") return { kind: "session", reason: resolved.reason };
  // Checked before any store exists: a refused workspace never gets one.
  if (refusedPrivateWorkspace(canonicalCwd(cwd)))
    return { kind: "session", reason: "unsafe_workspace" };
  const priv = await resolvePrivateGit(cwd, privateRepositories, gitRunnerFactory);
  return priv
    ? { kind: "git", repository: priv.repository, git: priv.git }
    : { kind: "session", reason: "private_repository_unavailable" };
}

function createNavigation(
  ctx: AnyContext,
  sessionId: string,
  store: HistoryWriter | undefined,
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
      await Promise.allSettled([
        ...(store ? [store.save(state)] : []),
        runtimeStore.publishNavigation(sessionId, state, activeSessionLeaf),
      ]);
    },
  );
}

const LEGACY_BLOB_DIRS = [
  "blobs",
  "trees",
  "refs",
  "locks",
  "leases",
  "journals",
  "history",
] as const;

const LEGACY_BLOB_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

/** Delay riding out short flaps: between the two workspace stats,
 *  between retries when removing legacy blob dirs or evicted repos, and
 *  between retries when a git child still holds a directory handle on
 *  Windows. */
const EVICTION_RETRY_DELAY_MS = 200;

/** `fs/promises` has no `realpath.native`; only native expands 8.3 short names. */
const nativeRealpath = promisify(realpath.native);

async function removeDirWithRetry(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === 4) return false;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, EVICTION_RETRY_DELAY_MS);
      await promise;
    }
  }
  return false;
}

/** One-shot removal of the pre-v1.5.1 store layout, whose dirs hold user file
 *  content and are never reclaimed by anything else. Kept while the pre-1.5.1
 *  tail (v1.5.1 shipped 2026-08-21) can still upgrade straight to 1.6.x.
 *  ponytail: delete this, LEGACY_BLOB_DIRS, LEGACY_BLOB_QUIET_MS,
 *  cleanLegacyGitIndexes, their boot wiring, and test/legacy-blob-purge.test.ts
 *  at v1.7.0. removeDirWithRetry/EVICTION_RETRY_DELAY_MS stay: eviction uses them. */
export async function purgeLegacyBlobStore(): Promise<void> {
  const root = canonicalCwd(storeRootDirectory());
  const isDir = async (name: string): Promise<boolean> =>
    stat(join(root, name))
      .then((s) => s.isDirectory())
      .catch(() => false);
  if (!(await isDir("blobs"))) return;
  if (!(await isDir("trees")) && !(await isDir("journals"))) return;

  let newest = 0;
  for (const name of LEGACY_BLOB_DIRS) {
    const dir = join(root, name);
    const metadata = await stat(dir).catch(() => undefined);
    if (!metadata) continue;
    newest = Math.max(newest, metadata.mtimeMs);
    // Liveness lives in these three only; blobs/ and trees/ are never walked.
    if (name !== "locks" && name !== "leases" && name !== "history") continue;
    for (const entry of await readdir(dir).catch(() => [])) {
      const child = await stat(join(dir, entry)).catch(() => undefined);
      if (child) newest = Math.max(newest, child.mtimeMs);
    }
  }
  if (Date.now() - newest < LEGACY_BLOB_QUIET_MS) return;

  for (const name of LEGACY_BLOB_DIRS) await removeDirWithRetry(join(root, name));
}

export default function ompUndoRedo(pi: ExtensionAPI, deps: OmpUndoRedoDependencies = {}): void {
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
  /** Joined on the first navigation, not at load: a subagent's copy never
   *  builds one, so it never holds the process's runtime directory. */
  const runtimeStore = new RuntimeActionStateStore();
  const navigations = new Map<string, SessionNavigation>();
  const backends = new Map<string, FileBackend>();
  /** Checkpoints of the CURRENT turn that no finalize owns yet. Anything left
   *  here when the next turn starts is released: ownership is what keeps a
   *  deferred finalize's checkpoint alive (see `PendingCapture.owned`). */
  const pending = new Map<string, PendingTurnCheckpoint>();
  type PendingCapture = {
    complete: Promise<void>;
    checkpoint: PendingTurnCheckpoint | null;
    /** Set when a finalize claims this capture. An owned capture's checkpoint
     *  belongs to that finalize alone: it is never published into `pending`
     *  (where the next turn would release it mid-finalize), and it is never
     *  released by the capture itself. An unowned capture whose turn is gone
     *  has no finalize coming, so it releases its own checkpoint. */
    owned?: boolean;
  };
  /** Leaf the current turn started from, per session. Used to bind a
   *  checkpoint to the turn that captured it: a deferred finalize whose
   *  checkpoint predates the current turn is released, never recorded with
   *  the wrong leaf. */
  const turnStartLeafBySession = new Map<string, string | null>();
  /** Monotonic turn counter per session. A turn whose after-snapshot finishes
   *  only after the next turn already started snapshotted that turn's edits
   *  too, which is what makes such a checkpoint unrestorable. */
  const turnSequenceBySession = new Map<string, number>();
  /** The current turn's in-flight before-snapshot, per session. `before_agent_start`
   *  stops waiting at the handler deadline, so the agent's tools can run while
   *  git is still reading the workspace. Tool calls wait on `complete`; one
   *  that gives up sets `late`, and the capture then discards its snapshot
   *  (it may hold the turn's own edits) instead of recording a wrong baseline. */
  const beforeSnapshotGates = new Map<string, { complete: Promise<void>; late: boolean }>();

  // Snapshot-store housekeeping: captures between gc runs (per store) and the
  // threshold that triggers a background `git gc`. Every store is the
  // extension's own (`storeDir` never names the user's `.git`), so gc can
  // never touch a user repository.
  const PRIVATE_GC_AFTER_CAPTURES = 20;
  const capturesSinceGcByStore = new Map<string, number>();

  /** Counter key: realpath-canonical, so a store spelled in long form on a
   *  checkpoint and in 8.3 short form on its backend still count as one. */
  function gcKey(repository: GitRepository): string {
    return canonicalCwd(repository.storeDir);
  }

  /** Repacking a large snapshot repo legitimately outruns the runner's
   *  default per-child deadline, so gc gets its own ceiling: long enough that
   *  a real gc always finishes, short enough that a wedged child cannot hold
   *  a tracked operation (and with it the eviction sweep) forever. */
  const PRIVATE_GC_TIMEOUT_MS = 15 * 60 * 1000;

  /** gc prune window, for every trigger (retention sweep, capture threshold,
   *  shutdown). A store is shared by every OMP process in the same workspace
   *  (Private-Git: keyed only by sha256(cwd); Git mode: by the repository), and
   *  another process may be mid-capture, writing objects no ref reaches yet.
   *  `--prune=now` would delete them; the in-process `pendingCaptures` check
   *  cannot see other processes. Expired objects are days old, so an hour
   *  loses nothing. */
  const PRIVATE_SWEEP_PRUNE = "1.hour.ago";

  /** Tail of this extension copy's gc queue. Every trigger (retention sweep,
   *  capture threshold, shutdown) routes through `schedulePrivateGc`, so a
   *  copy runs at most one repack at a time: a boot sweep over many expired
   *  stores would otherwise start one full `git gc` per store at once. Not
   *  process-wide: OMP binds a copy per in-process session, but subagent
   *  copies never capture or expire (`servesMainSession`), so only main
   *  sessions' copies (one, or one per ACP session) feed a queue. Never
   *  rejects (`runPrivateGc` swallows every failure), so one bad store
   *  cannot stall the queue. */
  let privateGcQueue: Promise<void> = Promise.resolve();

  /** Queues a gc of `repository` behind every gc already scheduled; resolves
   *  once this one has run. */
  function schedulePrivateGc(repository: GitRepository): Promise<void> {
    privateGcQueue = privateGcQueue.then(() => runPrivateGc(repository));
    return privateGcQueue;
  }

  /** Best-effort `git prune` + `git gc` over a snapshot store. Runs outside
   *  the handler deadline accounting (never awaited by a handler) so a slow
   *  gc can never hit the host's timeout. The prune drops unreferenced
   *  objects: expiring sessions would otherwise leave recoverable file
   *  content behind indefinitely. */
  async function runPrivateGc(repository: GitRepository): Promise<void> {
    // Claimed before gc reads the refs: a deletion during this gc marks the
    // store anew, and only a gc that finished drops the claim, so one cut
    // short by a failure, its ceiling or the process exit leaves it for the
    // next boot's sweep (`storeNeedsGc`). An existing claim (a killed gc, or
    // another process's gc still running) is never overwritten: that gc may
    // drop it after missing this mark's deletion, so the mark stays and costs
    // at most one extra gc.
    const mark = gcPendingPath(repository.storeDir);
    const claim = `${mark}.running`;
    try {
      if (!(await stat(claim).catch(() => null))) {
        await rename(mark, claim).catch(() => undefined);
      }
      // Run from a neutral cwd so a slow gc never holds a handle on either the
      // user's workspace or the snapshot repo itself (Windows keeps a child's
      // cwd handle until it exits, which would race teardown rms and the
      // eviction sweep). GIT_DIR is set, so the repo operations work anywhere;
      // a Git store also needs the objects it borrows to walk its snapshots.
      const git = gitRunnerFactory(tmpdir(), storeEnv(repository));
      // Git mode: the prune and gc below would drop the store's copies of
      // objects the user's repository also holds.
      await pinStoreObjects(git, repository, PRIVATE_GC_TIMEOUT_MS);
      // gc prunes only after its repack. A repack that outruns the ceiling
      // (or dies with the terminal) is hard-killed on Windows, so its prune
      // never runs: expired snapshots stay on disk and every attempt leaves a
      // multi-GB `tmp_pack_*` behind (#101). The same prune run alone needs
      // no repack, and also deletes `tmp_*` leftovers past the window.
      const pruned = await git(["prune", `--expire=${PRIVATE_SWEEP_PRUNE}`], {
        timeoutMs: PRIVATE_GC_TIMEOUT_MS,
      });
      // gc would rerun the same prune and fail the same way.
      if (pruned.error) return;
      const gc = await git(["gc", `--prune=${PRIVATE_SWEEP_PRUNE}`], {
        timeoutMs: PRIVATE_GC_TIMEOUT_MS,
      });
      if (gc.code === 0 && !gc.error) await rm(claim, { force: true });
    } catch {
      // Best-effort: a failed gc leaves more work for the next trigger.
    }
  }

  /** One-time removal of legacy git-indexes directory from pre-v1.5.1 store layout */
  async function cleanLegacyGitIndexes(): Promise<void> {
    const legacy = join(canonicalCwd(storeRootDirectory()), "git-indexes");
    await rm(legacy, { recursive: true, force: true }).catch(() => undefined);
  }

  /** Removes orphaned %TEMP%/omp-undo-redo-index-* dirs older than 24h.
   *  Persistent alternates (SnapshotIndexLease) keep mtime fresh while in use;
   *  only abandoned crash orphans age >24h. */
  async function sweepOrphanTempIndexes(): Promise<void> {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let entries: string[];
    try {
      entries = await readdir(tmpdir());
    } catch {
      return;
    }
    const candidates = entries.filter(
      (e) => e.startsWith("omp-undo-redo-index-") || e.startsWith("omp-undo-redo-patch-"),
    );
    await Promise.all(
      candidates.map(async (name) => {
        const path = join(tmpdir(), name);
        try {
          const st = await stat(path);
          if (!st.isDirectory() || st.mtimeMs >= cutoff) return;
          await rm(path, { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }),
    );
  }

  // Core turn-state, declared ahead of the eviction helpers below that read
  // them (evictStalePrivateRepos' in-flight guard).
  const pendingCaptures = new Map<string, PendingCapture>();
  const pendingFinalizations = new Map<string, Promise<void>>();
  const activeOperations = new Set<Promise<void>>();
  /** Sessions this copy captured for, i.e. whose index leases it owns. */
  const leaseSessionIds = new Set<string>();
  /** OMP binds a separate copy of this extension to every in-process subagent
   *  session (`ctx.agent.kind === "sub"`). Nobody can `/undo` a subagent, so
   *  its copy captures nothing, keeps no history, waits on no tool call,
   *  refuses `/undo`/`/redo` (a subagent prompt starting with one runs it),
   *  and leaves boot and shutdown housekeeping to the main session's copy.
   *  Hosts without `ctx.agent` read as main. */
  let servesMainSession = false;
  let servesSubagent = false;
  function isMainSession(ctx: AnyContext): boolean {
    if (ctx.agent?.kind === "sub") {
      servesSubagent = true;
      return false;
    }
    servesMainSession = true;
    void startBootHousekeeping();
    return true;
  }

  /** Boot housekeeping (eviction, legacy cleanup, orphaned temp indexes)
   *  starts with the copy's first main-session event instead of at load, so
   *  a subagent's copy skips it: the main session's copy already ran it.
   *  ponytail: a copy that sees no session event within
   *  BOOT_HOUSEKEEPING_FALLBACK_MS runs it anyway; a subagent whose first
   *  event arrives later than that sweeps once more, which is harmless (a
   *  sweep racing another one finds the store already renamed and skips it). */
  const BOOT_HOUSEKEEPING_FALLBACK_MS = 2_000;
  let bootEviction: Promise<void> | null = null;
  function startBootHousekeeping(): Promise<void> {
    if (bootEviction) return bootEviction;
    bootEviction = evictStalePrivateRepos().catch(() => undefined);
    void cleanLegacyGitIndexes().catch(() => undefined);
    const t = setTimeout(() => {
      void sweepOrphanTempIndexes().catch(() => undefined);
      void purgeLegacyBlobStore().catch(() => undefined);
    }, 2_000);
    t.unref?.();
    return bootEviction;
  }

  /** How long a snapshot repo must sit untouched before its workspace's
   *  disappearance counts as abandonment rather than a transient mount or
   *  lock hiccup (offline SMB/NFS volume, AV scan, temporarily renamed dir). */
  const EVICTION_IDLE_CUTOFF_MS = 24 * 60 * 60 * 1000;
  /** Evicted repos are renamed aside as recoverable trash and kept this long
   *  before any bytes are removed. */
  const EVICTION_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

  /** Newest mtime across `dir` and its direct children. Git writes land in
   *  descendants (logs, packs, COMMIT_EDITMSG), not necessarily the root, so
   *  the root mtime alone under-reports recent activity. Returns null when
   *  freshness cannot be determined; callers must then not evict. */
  async function lastActivityMs(dir: string): Promise<number | null> {
    let newest: number | null = null;
    const consider = (ms: number): void => {
      if (newest === null || ms > newest) newest = ms;
    };
    try {
      consider((await stat(dir)).mtimeMs);
    } catch {
      return null;
    }
    let children: string[];
    try {
      children = await readdir(dir);
    } catch {
      return newest;
    }
    await Promise.all(
      children.map(async (name) => {
        try {
          consider((await stat(join(dir, name))).mtimeMs);
        } catch {
          // Ignore
        }
      }),
    );
    return newest;
  }

  /** Path whose disappearance means a store is abandoned: a private repo's
   *  `core.worktree` (its workspace) or a Git store's source `commonDir`; null
   *  when neither is readable. Git decodes the value: it quotes values
   *  containing `#`/`;` and escapes `\`/`"`, so a raw regex over the file
   *  yields a path that never stats (e.g. "C:\\…\\C# Projects") and evicts
   *  live history. */
  async function storeSource(
    reposDir: string,
    gitDir: string,
  ): Promise<{ path: string; gitStore: boolean } | null> {
    // One spawn for both keys; `-z` keeps decoded values intact. Last value
    // wins, as with `--get`; `core.worktree` wins over the source key.
    const result = await gitRunnerFactory(reposDir)([
      "config",
      "--file",
      join(gitDir, "config"),
      "-z",
      "--get-regexp",
      `^(core\\.worktree|${GIT_STORE_SOURCE_KEY.replaceAll(".", "\\.")})$`,
    ]);
    if (result.code !== 0) return null;
    const values = new Map<string, string>();
    for (const entry of result.stdout.split("\0")) {
      const newline = entry.indexOf("\n");
      if (newline > 0) values.set(entry.slice(0, newline), entry.slice(newline + 1));
    }
    const worktree = values.get("core.worktree");
    if (worktree) return { path: worktree, gitStore: false };
    const source = values.get(GIT_STORE_SOURCE_KEY);
    return source ? { path: source, gitStore: true } : null;
  }

  /** Whether a store holds any ref, loose or packed. Errors other than ENOENT
   *  propagate, which the sweep reads as "keep". */
  async function storeHasRefs(gitDir: string): Promise<boolean> {
    try {
      const loose = await readdir(join(gitDir, "refs"), { recursive: true, withFileTypes: true });
      if (loose.some((entry) => entry.isFile())) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const packed = await readFile(join(gitDir, "packed-refs"), "utf8");
      return packed.split(/\r?\n/).some((line) => line !== "" && !line.startsWith("#"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  }

  /** Whether a store holds garbage only a gc reclaims. Packed objects a
   *  deleted ref orphaned outlive `git prune`, and every in-process trigger
   *  (capture threshold, shutdown, expiry) dies with the process, so the
   *  sweep checks durable evidence instead: a deletion's `gc-pending` mark,
   *  the claim of a gc that never finished, a cruft pack (`.mtimes`: objects
   *  an earlier gc kept inside its prune window), or objects no ref can reach
   *  at all (stores orphaned before the mark existed). */
  async function storeNeedsGc(storeDir: string): Promise<boolean> {
    const mark = gcPendingPath(storeDir);
    for (const path of [mark, `${mark}.running`]) {
      if (
        await stat(path).then(
          () => true,
          () => false,
        )
      )
        return true;
    }
    const objects = join(storeDir, "objects");
    const packs = await readdir(join(objects, "pack")).catch(() => [] as string[]);
    if (packs.some((name) => name.endsWith(".mtimes"))) return true;
    // Unreadable refs read as "has refs": never gc on a guess.
    if (await storeHasRefs(storeDir).catch(() => true)) return false;
    if (packs.some((name) => name.endsWith(".pack"))) return true;
    const fanouts = await readdir(objects).catch(() => [] as string[]);
    return fanouts.some((name) => /^[0-9a-f]{2}$/.test(name));
  }

  /** Removes snapshot stores whose workspace (Private-Git) or repository (Git
   *  mode) no longer exists. Runs at boot and on shutdown so vanished
   *  workspaces cannot leave their snapshots (and the file contents inside
   *  them) behind forever.
   *
   *  Deliberately conservative: eviction requires the workspace stat to fail
   *  with ENOENT/ENOTDIR twice (re-checked after a delay, so a single mount
   *  or AV hiccup cannot trigger it), the repo to be idle past
   *  EVICTION_IDLE_CUTOFF_MS, nothing touching snapshot repos to be in
   *  flight, and even then the repo is only renamed aside as `.evicted-<ts>`
   *  trash for EVICTION_TRASH_RETENTION_MS instead of being deleted outright.
   *  A store whose setup never finished names no source; it is evicted on
   *  idleness alone, and only while it holds no refs. A private store of a
   *  workspace `refusedPrivateWorkspace` rejects is evicted on idleness alone. */
  async function evictStalePrivateRepos(): Promise<void> {
    const reposDir = join(canonicalCwd(storeRootDirectory()), "repos");
    let entries: string[];
    try {
      entries = await readdir(reposDir);
    } catch {
      return;
    }

    // Defer when work touching snapshot repos is in flight (captures,
    // finalizes, undo/redo): git children may still be writing into them.
    // Whatever is left behind is revisited by the next boot or shutdown
    // sweep. Registered-but-idle sessions are deliberately NOT a guard:
    // the shutdown sweep exists to evict exactly those once drained.
    if (pendingCaptures.size > 0 || pendingFinalizations.size > 0 || activeOperations.size > 0) {
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      const path = join(reposDir, entry);
      const trashMatch = /\.evicted-(\d+)$/.exec(entry);
      if (trashMatch) {
        // Trash from an earlier sweep. Retention is stamped in the name
        // because rename preserves mtime.
        if (now - Number(trashMatch[1]) >= EVICTION_TRASH_RETENTION_MS) {
          await removeDirWithRetry(path);
        }
        continue;
      }
      if (!entry.endsWith(".git")) continue;
      try {
        // A running `git gc` (ours or external) is actively rewriting this
        // repo; touching it now would race the child. gc removes the pid
        // file when it exits, so a lingering one means the child was killed
        // hard — but only a RECENT pidfile is trusted as "live": one older
        // than the idle cutoff is crash debris and must not block eviction
        // forever. A real gc on these repos finishes well inside that
        // window; a genuinely long child just fails the rename below and is
        // retried by a later sweep.
        try {
          const gcPidStat = await stat(join(path, "gc.pid"));
          if (now - gcPidStat.mtimeMs < EVICTION_IDLE_CUTOFF_MS) continue;
        } catch {
          // No pidfile.
        }
        const found = await storeSource(reposDir, path);
        if (found) {
          const source = found.path;
          const vanished = async (): Promise<boolean> => {
            try {
              await stat(source);
              return false;
            } catch (err) {
              const code = (err as NodeJS.ErrnoException | undefined)?.code;
              // Anything else (EACCES, EBUSY, EIO, EMFILE...) means "cannot
              // tell", which must never be read as "gone".
              return code === "ENOENT" || code === "ENOTDIR";
            }
          };
          // A private store of a refused workspace (left by an earlier
          // version) is never used again, so it counts as abandoned. v1.5.0
          // and v1.5.1 wrote `core.worktree` through non-native realpath,
          // which keeps Windows 8.3 short names, so it is resolved again
          // here. Async: a dead network mount then stalls a threadpool
          // thread, as `vanished` would, never the event loop.
          const refused =
            !found.gitStore &&
            refusedPrivateWorkspace(await nativeRealpath(source).catch(() => source));
          if (!refused) {
            if (!(await vanished())) continue;
            await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_DELAY_MS));
            if (!(await vanished())) continue;
          }
        } else if ((await setupFinished(path)) !== false || (await storeHasRefs(path))) {
          // No source to stat. Only a setup that never wrote its marker (a
          // crash or stale config.lock after `git init`) and holds no
          // snapshots is evicted: nothing else would ever name it again if
          // its workspace never relaunches.
          // ponytail: an unfinished Git-mode store that already has refs is
          // kept until its repository relaunches; its source is unknowable.
          continue;
        }
        const lastActivity = await lastActivityMs(path);
        if (lastActivity === null || now - lastActivity < EVICTION_IDLE_CUTOFF_MS) continue;
        const trashPath = `${path}.evicted-${now}`;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await rename(path, trashPath);
            break;
          } catch {
            if (attempt === 4) break; // Stranded until a later sweep.
            await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_DELAY_MS));
          }
        }
      } catch {
        // Unreadable repo: leave it for a later sweep.
      }
    }
  }

  const initializations = new Map<string, Promise<SessionNavigation>>();
  let closing = false;
  let shutdownPromise: Promise<void> | null = null;
  let pendingNavigationSourceSessionId: string | null = null;
  const expirationPromises = new Map<string, Promise<void>>();
  let privateRetentionSweep: Promise<void> | null = null;
  const explicitActiveHashes = new Set<string>();

  function activeSessionHashes(): ReadonlySet<string> {
    const hashes = new Set<string>(explicitActiveHashes);
    for (const sessionId of [...navigations.keys(), ...pending.keys(), ...initializations.keys()]) {
      hashes.add(checkpointNamespace(sessionId));
    }
    return hashes;
  }

  /** Expires dormant histories in `repository`, once per process. Deleting
   *  refs alone leaves the snapshots' plaintext file contents on disk, so the
   *  store then gets a background gc; so does a store `storeNeedsGc` finds
   *  garbage in, else a gc an earlier process never ran or finished would
   *  never be retried. */
  function expireRepository(repository: GitRepository, git: GitRunner): Promise<void> {
    const key = `git:${repository.storeDir}`;
    const existing = expirationPromises.get(key);
    if (existing) return existing;
    const expiration = (async () => {
      const refsRemoved = await expireGitSessionHistories(repository, git, retentionDays, () =>
        activeSessionHashes(),
      );
      if (closing) return;
      if (refsRemoved === 0 && !(await storeNeedsGc(repository.storeDir))) return;
      // Detached from the expiration promise: shutdown awaits expirations,
      // and must not wait out a gc.
      void track(() => schedulePrivateGc(repository));
    })().catch(() => undefined);
    expirationPromises.set(key, expiration);
    return expiration;
  }

  /** Retention for every store, not only those a session opens here: a
   *  workspace that is never reopened would otherwise keep its snapshots
   *  (`.env`, keys) forever. Started by the first session initialization,
   *  once that session is registered active, so the session being resumed
   *  is protected exactly as in the per-repo path. Expiry needs only the
   *  store; a Git store's `commonDir` supplies the objects its gc reads.
   *  Runs with retention off too: expiry then deletes nothing, but pending
   *  gcs are still retried. */
  async function sweepPrivateRepoRetention(): Promise<void> {
    const reposDir = join(canonicalCwd(storeRootDirectory()), "repos");
    const entries = await readdir(reposDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (closing) return;
      if (!entry.endsWith(".git")) continue;
      const gitDir = join(reposDir, entry);
      const source = await storeSource(reposDir, gitDir).catch(() => null);
      if (!source) continue;
      const { path } = source;
      await expireRepository(
        source.gitStore
          ? { worktree: path, gitDir: path, commonDir: path, storeDir: gitDir }
          : { worktree: path, gitDir, commonDir: gitDir, storeDir: gitDir },
        gitRunnerFactory(tmpdir(), { GIT_DIR: gitDir }),
      );
    }
  }

  // Cross-process liveness beats: load/save touch .active markers, but a
  // session left open and idle would otherwise go stale past the heartbeat
  // TTL while its owner process is still running. A slow unref'd interval
  // re-asserts liveness for exactly the locally active sessions (the same
  // set the sweeps already treat as protected), so foreign sweepers never
  // see a live session as expired. Sessions left via a switch drop out of
  // that set (releaseLeftSession). Deliberately not `backends`: membership
  // there is a cache entry, not liveness.
  const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
  const heartbeatTimer = setInterval(() => {
    const tracked = new Set<string>([
      ...navigations.keys(),
      ...initializations.keys(),
      ...pending.keys(),
    ]);
    for (const sessionId of tracked) {
      const backend = backends.get(sessionId);
      if (!backend || backend.kind === "session") continue;
      const sessionHash = checkpointNamespace(sessionId);
      void touchSessionHeartbeat(historyDirectory(backend.repository), sessionHash);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  const NOTIFICATION_MESSAGES: Record<SessionOnlyReason, string> = {
    git_unavailable:
      "Git is not available.\nSession navigation still works, but file changes cannot be restored.",
    private_repository_unavailable:
      "The private snapshot repository could not be initialized.\nSession navigation still works, but file changes cannot be restored.",
    unsafe_workspace:
      "File snapshots are disabled in a home directory, drive root, or temp directory: they would copy its private files.\nSession navigation still works, but file changes cannot be restored. Start OMP in a project folder to enable them.",
    repository_unresolvable:
      "The Git repository could not be resolved.\nSession navigation still works, but file changes cannot be restored.",
  };

  // Keyed `${sessionId}\0${reason}`: session ids are UUIDs, so the separator
  // cannot collide. Never pruned, same as the map it replaced.
  const notifiedSessionReasons = new Set<string>();
  function notifySessionOnly(ctx: AnyContext, sessionId: string, reason: SessionOnlyReason): void {
    if (!ctx.ui?.notify) return;
    const key = `${sessionId}\0${reason}`;
    if (notifiedSessionReasons.has(key)) return;
    notifiedSessionReasons.add(key);
    ctx.ui.notify(NOTIFICATION_MESSAGES[reason], "warning");
  }

  /** `historyLeafId` bounds the history rebuilt when no stored one loads: a
   *  finalize passes its turn-start leaf, or the turn it is about to record
   *  would be rebuilt from the branch and then recorded a second time. */
  async function initializeNavigation(
    ctx: AnyContext,
    replaceExisting: boolean,
    historyLeafId: string | null = ctx.sessionManager.getLeafId(),
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
      await runtimeStore.initialize();
      const previous = navigations.get(sessionId);
      navigations.delete(sessionId);
      if (previous) await previous.suspend();
      const backend = await resolveBackend(ctx.cwd, privateRepositories, gitRunnerFactory);
      backends.set(sessionId, backend);
      if (backend.kind === "session") {
        notifySessionOnly(ctx, sessionId, backend.reason);
      }

      if (backend.kind === "git") void expireRepository(backend.repository, backend.git);
      // After boot eviction, which it would otherwise race (a gc holds
      // handles through eviction's rename and refreshes the idle mtimes).
      privateRetentionSweep ??= startBootHousekeeping()
        .then(() => (closing ? undefined : track(sweepPrivateRepoRetention)))
        .catch(() => undefined);

      const store =
        backend.kind === "git"
          ? new SessionHistoryStore(sessionId, backend.repository, backend.git)
          : undefined;
      const navigation = createNavigation(
        ctx,
        sessionId,
        store,
        runtimeStore,
        backend,
        gitRunnerFor,
      );
      const loadResult = store ? await store.load(ctx.sessionManager) : null;
      let restored: NavigationState | null = null;
      if (loadResult?.status === "loaded") {
        restored = loadResult.state;
      } else if (loadResult?.status === "expired") {
        restored = null;
        if (ctx.ui?.notify) {
          ctx.ui.notify(
            "Undo/redo file history for this session expired due to inactivity.\nSession navigation still works, but file changes cannot be restored.",
            "warning",
          );
        }
      } else if (loadResult?.status === "unavailable" && loadResult.reason === "unusable") {
        restored = null;
        if (ctx.ui?.notify) {
          ctx.ui.notify(
            "Undo/redo file history for this session could not be loaded.\nSession navigation still works, but earlier file changes cannot be restored.",
            "warning",
          );
        }
      } else {
        restored = null;
      }
      navigation.restoreState(
        restored ?? reconstructSessionHistory(ctx.sessionManager, historyLeafId),
      );
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

  async function ensureNavigation(
    ctx: AnyContext,
    historyLeafId?: string | null,
  ): Promise<SessionNavigation | null> {
    if (closing) return null;
    return initializeNavigation(ctx, false, historyLeafId);
  }

  function track(operation: () => Promise<void>): Promise<void> {
    const { promise: tracked, resolve, reject } = Promise.withResolvers<void>();
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

  async function releasePending(
    pendingCheckpoint: PendingTurnCheckpoint,
    keepIndex = false,
  ): Promise<void> {
    if (pendingCheckpoint.kind === "git") {
      await releasePendingCheckpoint(
        gitRunnerFor(pendingCheckpoint.repository),
        pendingCheckpoint,
        keepIndex,
      );
    }
  }

  function beginCapture(
    sessionId: string,
    task: () => Promise<PendingTurnCheckpoint>,
  ): PendingCapture {
    const { promise: complete, resolve } = Promise.withResolvers<void>();
    const capture: PendingCapture = { complete, checkpoint: null };
    void track(async () => {
      try {
        const checkpoint = await task();
        // The capture's own turn is over once turnStartLeaf moved on. Its
        // checkpoint then belongs to the finalize that claimed this capture —
        // and to nobody at all if no `agent_end` ever claimed it (two
        // `before_agent_start` events without one in between), in which case
        // this is the only place left that can release it.
        const ownTurn = turnStartLeafBySession.get(sessionId) === checkpoint.parentLeafId;
        if (closing || pendingCaptures.get(sessionId) !== capture || !(ownTurn || capture.owned)) {
          await releasePending(checkpoint);
        } else {
          capture.checkpoint = checkpoint;
          // `pending` holds only unowned checkpoints: publishing an owned one
          // would let the next turn's `before_agent_start` release it while
          // its finalize is still deferred.
          if (ownTurn && !capture.owned) pending.set(sessionId, checkpoint);
          if (checkpoint.kind === "git") {
            const { repository } = checkpoint;
            const key = gcKey(repository);
            const count = (capturesSinceGcByStore.get(key) ?? 0) + 1;
            if (count >= PRIVATE_GC_AFTER_CAPTURES) {
              capturesSinceGcByStore.delete(key);
              // The current capture's git work is done (this runs after its
              // snapshot); only defer when another session's capture is still
              // mid-flight, to avoid repacking under it. The counter reset
              // below prevents gc runs from stacking.
              if (pendingCaptures.size <= 1) {
                void track(() => schedulePrivateGc(repository));
              } else {
                capturesSinceGcByStore.set(key, PRIVATE_GC_AFTER_CAPTURES - 1);
              }
            } else {
              capturesSinceGcByStore.set(key, count);
            }
          }
        }
      } catch {
        // Nothing to unwind: the finally below unblocks waiters and the turn
        // falls back to session-only.
      } finally {
        resolve();
        if (pendingCaptures.get(sessionId) === capture) pendingCaptures.delete(sessionId);
      }
    });
    pendingCaptures.set(sessionId, capture);
    return capture;
  }

  async function suspendDetached(
    detachedNavigations: readonly SessionNavigation[],
    detachedPending: readonly PendingTurnCheckpoint[],
  ): Promise<void> {
    await Promise.allSettled([
      ...detachedNavigations.map((navigation) => navigation.suspend()),
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
    await suspendDetached(detachedNavigations, detachedPending);
  }

  /** `/new`, `/resume`, fork and handoff leave `sessionId`. Keeping it in the
   *  local active set would beat its heartbeat and shield it from retention
   *  for the process's lifetime; a later resume reloads it from its persisted
   *  history, as after a restart. Its in-flight work settles first so the
   *  last turn still lands in that history. */
  async function releaseLeftSession(typed: AnyContext, sessionId: string): Promise<void> {
    for (;;) {
      const busy =
        pendingFinalizations.get(sessionId) ??
        initializations.get(sessionId) ??
        pendingCaptures.get(sessionId)?.complete;
      if (!busy) break;
      await Promise.allSettled([busy]);
    }
    // Resumed (or reloaded) again meanwhile: it is live.
    if (closing || typed.sessionManager.getSessionId() === sessionId) return;
    const navigation = navigations.get(sessionId);
    const left = pending.get(sessionId);
    navigations.delete(sessionId);
    pending.delete(sessionId);
    backends.delete(sessionId);
    turnStartLeafBySession.delete(sessionId);
    turnSequenceBySession.delete(sessionId);
    explicitActiveHashes.delete(checkpointNamespace(sessionId));
    await suspendDetached(navigation ? [navigation] : [], left ? [left] : []);
  }

  pi.on("session_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      if (!isMainSession(typed)) return;
      const sessionId = typed.sessionManager.getSessionId();
      const previousPending = pending.get(sessionId);
      pending.delete(sessionId);
      if (previousPending) await releasePending(previousPending);
      turnStartLeafBySession.delete(sessionId);
      turnSequenceBySession.delete(sessionId);
      // An in-flight capture for this session no longer belongs to a live turn:
      // it self-releases on completion via the identity check in beginCapture.
      pendingCaptures.delete(sessionId);
      beforeSnapshotGates.delete(sessionId);
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

  // Switch and branch share one slot; if it is empty (never set, or clobbered by
  // an interleaved navigation) the post-event invalidates every session's redo,
  // which is a safe superset, and releases no session (unknown source).
  const rememberNavigationSource = (_event: unknown, ctx: unknown) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as AnyContext;
      pendingNavigationSourceSessionId = typed.sessionManager.getSessionId();
    });

  // The host emits no `session_start` for the session it switched to, so its
  // navigation is built here, before any turn: built lazily by that turn's
  // finalize, it would rebuild a branch that already holds the turn.
  const adoptSwitchedSession = (_event: unknown, ctx: unknown) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as AnyContext;
      if (!isMainSession(typed)) return;
      const sourceSessionId = pendingNavigationSourceSessionId;
      pendingNavigationSourceSessionId = null;
      if (sourceSessionId) {
        await navigations.get(sourceSessionId)?.invalidateRedo();
        // Detached: the switch must not wait out the source's deferred finalize.
        void track(() => releaseLeftSession(typed, sourceSessionId));
      } else {
        await invalidateAllRedo();
      }
      // Keeps a live navigation (same-id reload, or a resume racing the
      // release above); otherwise loads the stored history.
      await ensureNavigation(typed);
    });

  pi.on("session_before_switch", rememberNavigationSource);
  pi.on("session_switch", adoptSwitchedSession);
  pi.on("session_before_branch", rememberNavigationSource);
  pi.on("session_branch", adoptSwitchedSession);

  pi.on("before_agent_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      if (!isMainSession(typed)) return;
      const sessionId = typed.sessionManager.getSessionId();
      const oldPending = pending.get(sessionId);
      pending.delete(sessionId);
      beforeSnapshotGates.delete(sessionId);
      if (oldPending) await releasePending(oldPending);

      // Record the leaf this turn starts from, then bound concurrent captures:
      // a turn that starts while the previous turn's capture is still in flight
      // gets no new capture instead of stacking overlapping `git add` runs over
      // the same workspace. Its boundary is recorded as session-only right
      // here — leaving `pending` empty would drop the turn from the history
      // entirely, because agent_end would then finalize the earlier turn's
      // in-flight capture and this turn would produce no checkpoint at all.
      const turnStartLeaf = typed.sessionManager.getLeafId();
      turnStartLeafBySession.set(sessionId, turnStartLeaf);
      turnSequenceBySession.set(sessionId, (turnSequenceBySession.get(sessionId) ?? 0) + 1);
      if (pendingCaptures.has(sessionId)) {
        pending.set(sessionId, {
          kind: "session",
          reason: "before_snapshot_failed",
          parentLeafId: turnStartLeaf,
        });
        return;
      }

      const backend =
        backends.get(sessionId) ??
        (await resolveBackend(typed.cwd, privateRepositories, gitRunnerFactory));
      backends.set(sessionId, backend);
      if (backend.kind === "session") {
        notifySessionOnly(typed, sessionId, backend.reason);
      }
      if (backend.kind === "git") leaseSessionIds.add(sessionId);
      const gate = { complete: Promise.resolve(), late: false };
      const capture = beginCapture(sessionId, async () => {
        const prepared =
          backend.kind === "git"
            ? await prepareBeforeTurn(backend.git, sessionId, ownerRegistry, backend.repository)
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
          await releasePending(checkpoint, true).catch(() => undefined);
          return { kind: "session", reason: "before_snapshot_failed", parentLeafId: turnStartLeaf };
        }
        return checkpoint;
      });
      gate.complete = capture.complete;
      beforeSnapshotGates.set(sessionId, gate);
      void capture.complete.then(() => {
        if (beforeSnapshotGates.get(sessionId) === gate) beforeSnapshotGates.delete(sessionId);
      });
      await timedOutAfter(capture.complete, captureDeadlineMs);
    }),
  );

  // Every tool (built-in, custom, MCP, subagent) passes through the host's
  // `tool_call` gate before executing. Returning undefined never blocks it.
  pi.on("tool_call", async (_event, ctx) => {
    const gate = beforeSnapshotGates.get(
      (ctx as unknown as AnyContext).sessionManager.getSessionId(),
    );
    if (!gate || gate.late || closing) return;
    if (await timedOutAfter(gate.complete, toolCallDeadlineMs)) gate.late = true;
  });

  function beginFinalizeTurn(
    typed: AnyContext,
    capture: PendingCapture,
    leafId: string | null,
    turnStartLeaf: string | null,
  ): Promise<void> {
    const sessionId = typed.sessionManager.getSessionId();
    // Claim the capture: from here its checkpoint is this finalize's alone.
    // Taking the slot matters because the gate below can defer this finalize
    // past the next `before_agent_start`, which releases whatever `pending`
    // still holds.
    capture.owned = true;
    if (capture.checkpoint && pending.get(sessionId) === capture.checkpoint) {
      pending.delete(sessionId);
    }
    // Read here, not inside the finalize: a deferred finalize runs after the
    // next turn already bumped the counter, and the comparison below is
    // exactly what detects that.
    const turnSequence = turnSequenceBySession.get(sessionId);
    // An earlier turn whose capture overran its deadline may still be
    // finalizing. Its checkpoint must land in the history before this turn's,
    // or the recorded order would not match the turn order (and a session-only
    // boundary would convert file checkpoints that are not yet recorded).
    const previousFinalize = pendingFinalizations.get(sessionId);
    const ready = previousFinalize
      ? previousFinalize.then(() => capture.complete)
      : capture.complete;
    let handlerRelease!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      handlerRelease = resolve;
    });
    const work = (async () => {
      try {
        if (await timedOutAfter(ready, captureDeadlineMs)) {
          // The capture (or the previous turn's finalize) overran the handler
          // deadline. Keep this turn's finalize identity-bound — same capture,
          // same leaf, same turn-start leaf, same context — so when it settles
          // it finalizes its own checkpoint instead of a later turn's.
          handlerRelease();
          await ready;
          await finalizeTurn(typed, sessionId, capture, leafId, turnStartLeaf, turnSequence);
          return;
        }
        await finalizeTurn(typed, sessionId, capture, leafId, turnStartLeaf, turnSequence);
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
      // eslint-disable-next-line no-console
      (error) => console.error("[omp-undo-redo] finalize failed", error),
    );
    pendingFinalizations.set(sessionId, tracked);
    // A slow after-snapshot must not hold the handler past the host cap. The
    // early return is the same state as the deferred path above: the work
    // stays in `pendingFinalizations`, and overlapping turns are safe (index
    // leases are checked out per run; `turnSequence` flags the gap).
    void timedOutAfter(tracked, finalizeDeadlineMs).then(() => handlerRelease());
    void tracked.then(() => {
      if (pendingFinalizations.get(sessionId) === tracked) pendingFinalizations.delete(sessionId);
    });
    return handlerDone;
  }

  /** The navigation for `sessionId`, creating and publishing one when the
   *  session has none (a turn can finalize before any navigation was built).
   *  `typed.sessionManager` is live: a deferred finalize can outlive a `/new` or
   *  `/resume`, and then a navigation built from it would belong to the wrong
   *  session. Null means the session cannot be resolved safely. */
  async function resolveNavigation(
    typed: AnyContext,
    sessionId: string,
    turnStartLeaf: string | null,
  ): Promise<SessionNavigation | null> {
    const known = navigations.get(sessionId) ?? (await initializations.get(sessionId));
    if (known) return known;
    if (typed.sessionManager.getSessionId() !== sessionId) return null;
    const nav =
      (await ensureNavigation(typed, turnStartLeaf)) ??
      createNavigation(
        typed,
        sessionId,
        undefined,
        runtimeStore,
        undefined,
        gitRunnerFor,
        gitRunnerFactory,
      );
    navigations.set(sessionId, nav);
    return nav;
  }

  async function finalizeTurn(
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
      await releasePending(before);
      return;
    }
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
        leafId: leafId,
      };
    } else {
      const result = await finishAfterTurn(
        gitRunnerFor(before.repository),
        before,
        before.parentLeafId,
        leafId,
      );
      if (result.status === "git") {
        if (closing) {
          await releaseCheckpoint(gitRunnerFor(result.checkpoint.repository), result.checkpoint);
          return;
        }
        // The next turn started before this after-snapshot finished, so the
        // snapshot also contains that turn's edits: restoring from it would
        // revert two turns of file changes while moving one session boundary.
        // Only this turn loses its file checkpoint — every earlier turn's
        // stays restorable, and `applyCheckpoint` patches rather than checks
        // out, so it reports a conflict instead of clobbering unrecorded
        // edits when an older restore crosses this gap.
        if (turnSequenceBySession.get(sessionId) !== turnSequence) {
          await releaseCheckpoint(gitRunnerFor(result.checkpoint.repository), result.checkpoint);
          const gapped = await resolveNavigation(typed, sessionId, before.parentLeafId);
          await gapped?.recordTurnEnd({
            kind: "session",
            reason: "file_history_gap",
            parentLeafId: before.parentLeafId,
            leafId,
          });
          return;
        }
        const nav = await resolveNavigation(typed, sessionId, before.parentLeafId);
        if (!nav) {
          await releaseCheckpoint(gitRunnerFor(result.checkpoint.repository), result.checkpoint);
          return;
        }
        const retained = await retainCheckpointForResume(
          gitRunnerFor(result.checkpoint.repository),
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
    const nav = await resolveNavigation(typed, sessionId, before.parentLeafId);
    await nav?.recordTurnEnd(completed);
  }

  pi.on("agent_end", (_event, ctx) =>
    track(async () => {
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const turnStartLeaf = turnStartLeafBySession.get(sessionId) ?? null;
      const own = pending.get(sessionId) ?? null;
      // Prefer this turn's own boundary. An in-flight capture belonging to an
      // earlier turn (the guard in before_agent_start skipped this turn's
      // capture) must not be finalized here: it is this turn's leaf that would
      // be attached to it, and the earlier turn's own deferred finalize is
      // already waiting to record it correctly.
      const capture =
        own?.parentLeafId === turnStartLeaf ? undefined : pendingCaptures.get(sessionId);
      // A capture that already settled leaves no entry (its finally deletes
      // it), but its checkpoint stays in the pending map — finalize from that.
      const settled = capture ? null : own;
      if (!capture && !settled) return;
      await beginFinalizeTurn(
        typed,
        capture ?? { complete: Promise.resolve(), checkpoint: settled },
        typed.sessionManager.getLeafId(),
        turnStartLeaf,
      );
    }),
  );

  pi.on("session_shutdown", () => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    pendingNavigationSourceSessionId = null;
    const detachedNavigations = [...navigations.values()];
    const detachedPending = [...pending.values()];
    navigations.clear();
    initializations.clear();
    pending.clear();
    shutdownPromise = (async () => {
      // Let an in-flight expiry finish (it holds the store lock) and cancel one
      // that never started, then stop protecting sessions so shutdown GC can
      // reclaim their data.
      clearInterval(heartbeatTimer);
      await Promise.allSettled([...expirationPromises.values()]);
      explicitActiveHashes.clear();
      await suspendDetached(detachedNavigations, detachedPending);
      // Bounded: an overrunning capture must not delay shutdown indefinitely.
      // Any capture still running now self-releases on completion (closing is
      // set), and its temporary index is reclaimed by git or the OS.
      await timedOutAfter(Promise.allSettled([...activeOperations]), 5_000);
      await releasePersistentSnapshotIndices(leaseSessionIds);
      await drainState();
      await ownerRegistry.shutdown();
      await runtimeStore.shutdown();
      // Store housekeeping on the way out: evict stores whose workspaces
      // vanished, then gc stores that crossed the capture
      // threshold. Runs detached so an overrunning sweep cannot delay
      // shutdown, but internally sequenced: a gc racing the sweep would
      // both hold handles through the rename and bump mtimes past the idle
      // cutoff, so every gc waits for eviction to finish first and skips
      // repos it renamed away. Whatever is unfinished when the process
      // exits is covered by the next boot sweep. A subagent's copy leaves
      // it to the main session's copy.
      if (!servesMainSession) return;
      void evictStalePrivateRepos()
        .catch(() => undefined)
        .then(() =>
          Promise.allSettled(
            [...privateRepositories.values()].map(async (entry) => {
              if ("failure" in entry || !entry.repository || !entry.git) return;
              const { repository } = entry;
              const key = gcKey(repository);
              if (!capturesSinceGcByStore.has(key)) return;
              capturesSinceGcByStore.delete(key);
              try {
                await stat(repository.storeDir);
              } catch {
                return;
              }
              await schedulePrivateGc(repository);
            }),
          ),
        );
    })();
    return shutdownPromise;
  });

  const makeHandler = (id: ActionId) => async (_args: string, ctx: ExtensionCommandContext) => {
    const token = randomUUID();
    const typed = ctx as unknown as AnyContext;
    if (!isMainSession(typed)) {
      ctx.ui.notify(`/${id} is unavailable in a subagent session.`, "warning");
      return;
    }
    const sessionId = typed.sessionManager.getSessionId();
    // Commands run even mid-stream: the turn's finalize only registers at
    // agent_end, so the guards below must be read after the idle wait.
    await ctx.waitForIdle();
    const guards: [Promise<unknown> | undefined, string][] = [
      [pendingCaptures.get(sessionId)?.complete, "the file checkpoint is still being captured"],
      [pendingFinalizations.get(sessionId), "the last turn is still being finalized"],
    ];
    for (const [work, reason] of guards) {
      if (!work) continue;
      if (await timedOutAfter(work, captureDeadlineMs)) {
        ctx.ui.notify(`Cannot ${id} while ${reason}; try again shortly.`, "warning");
        return;
      }
    }
    const nav = await ensureNavigation(typed);
    if (!nav) {
      const label = id === "undo" ? "Undo" : "Redo";
      ctx.ui.notify(`${label} is unavailable while the session is closing.`, "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    const outcome = await runNavigation(nav, ctx, id);
    await publishActionResult(
      typed.sessionManager.getSessionId(),
      nav,
      typed,
      id,
      token,
      outcome.status === "moved",
    );
  };

  pi.registerCommand("undo", {
    description: "Revert file changes and session context for the last turn",
    handler: makeHandler("undo"),
  });
  pi.registerCommand("redo", {
    description: "Restore the most recently undone turn",
    handler: makeHandler("redo"),
  });

  const bootFallback = setTimeout(() => {
    if (!servesSubagent && !closing) void startBootHousekeeping();
  }, BOOT_HOUSEKEEPING_FALLBACK_MS);
  bootFallback.unref?.();
}
