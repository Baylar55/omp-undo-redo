import "./core/compat.js";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  ensurePrivateGitRepository,
  storeRootDirectory,
} from "./core/private-repo.js";
import { SessionNavigation } from "./core/session-navigation.js";
import { checkpointNamespace } from "./core/checkpoints.js";
import {
  finishAfterTurn,
  prepareBeforeTurn,
  releaseAllPersistentSnapshotIndices,
  releaseCheckpoint,
  releasePendingCheckpoint,
  resolveRepository,
  retainCheckpointForResume,
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
};

function readRetentionDays(): number {
  const days = parseInt(process.env.OMP_UNDO_REDO_RETENTION_DAYS ?? "", 10);
  return Number.isFinite(days) && days >= 0 ? days : 2;
}

export type SessionOnlyReason =
  "git_unavailable" | "repository_unresolvable" | "private_repository_unavailable";

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
};

export const DEFAULT_CAPTURE_DEADLINE_MS = 3_000;

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

/** Per-controller private-repo state: a ready entry carries the repository and
 *  the env runner (GIT_DIR fixed), with `ready` resolving true once init
 *  completes; a `failure` entry records a failed init so session fallback is
 *  reused without retrying. Keyed by canonical cwd (private) or worktree
 *  (git mode). */
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

export async function resolveBackend(
  cwd: string,
  privateRepositories: Map<string, PrivateRepoEntry> = new Map(),
  gitRunnerFactory: CwdGitRunnerFactory = defaultGitRunnerFactory,
): Promise<FileBackend> {
  const git = gitRunnerFactory(cwd);
  const resolved = await resolveRepository(git);
  if ("repository" in resolved) {
    const repository = resolved.repository;
    const existing = privateRepositories.get(repository.worktree);
    if (
      existing &&
      "git" in existing &&
      existing.git &&
      existing.repository?.gitDir === repository.gitDir
    ) {
      return { kind: "git", repository, git: existing.git };
    }
    // Rooted at the worktree, not at `cwd`: `git apply` silently ignores
    // patched paths outside its working directory, so a session started in a
    // subdirectory would restore only that subtree and still report success.
    // (`diff.relative=true` truncates the patch the same way.) Keyed by
    // `repository.worktree`, not `repository.commonDir`: linked worktrees of
    // the same repository share commonDir, so keying by commonDir would make
    // the second worktree reuse the first's runner and run git operations in
    // the wrong directory.
    const worktreeGit = gitRunnerFactory(repository.worktree);
    privateRepositories.set(repository.worktree, {
      repository,
      git: worktreeGit,
      ready: Promise.resolve(true),
    });
    return { kind: "git", repository, git: worktreeGit };
  }
  if (resolved.reason !== "not_repository") return { kind: "session", reason: resolved.reason };
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
  function gitRunnerFor(repository: GitRepository): GitRunner {
    const entry =
      privateRepositories.get(repository.worktree) ?? privateRepositories.get(repository.commonDir);
    if (entry && "git" in entry && entry.git && entry.repository?.gitDir === repository.gitDir) {
      return entry.git;
    }
    return gitRunnerFactory(repository.worktree);
  }
  const ownerRegistry = new CheckpointOwnerRegistry({
    resolveHostIdentity: resolvePersistentHostId,
    resolveRuntimeScope,
  });
  const runtimeStore = new RuntimeActionStateStore();
  const runtimeReady = runtimeStore.initialize();
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

  /** True when `gitDir` belongs to one of our private per-workspace repos.
   *  Guards gc/prune triggers so they can never touch a user's own repo:
   *  `privateRepositories` also caches the user's repository in Git mode
   *  (resolveBackend), so only the `private` flag stamped by
   *  ensurePrivateGitRepository proves ownership — never map membership.
   *  The incoming gitDir is realpath-canonicalized before comparing so a
   *  checkpoint recorded with a long-form path still matches a repository
   *  whose gitDir was built from a short-form (8.3) store root or cwd —
   *  otherwise the string compare silently fails and the gc counter never
   *  increments (repo growth stays unbounded on such machines). */
  function isPrivateRepository(gitDir: string): boolean {
    const canonicalGitDir = canonicalCwd(gitDir);
    for (const entry of privateRepositories.values()) {
      if ("failure" in entry) continue;
      if (entry.repository?.private !== true || !entry.repository.gitDir) continue;
      const canonicalEntry = canonicalCwd(entry.repository.gitDir);
      if (canonicalEntry === canonicalGitDir) return true;
    }
    return false;
  }

  // Private-repo housekeeping: captures between gc runs (per repo) and the
  // threshold that triggers a background `git gc`.
  const PRIVATE_GC_AFTER_CAPTURES = 20;
  const capturesSinceGcByGitDir = new Map<string, number>();

  /** Repacking a large snapshot repo legitimately outruns the runner's
   *  default per-child deadline, so gc gets its own ceiling: long enough that
   *  a real gc always finishes, short enough that a wedged child cannot hold
   *  a tracked operation (and with it the eviction sweep) forever. */
  const PRIVATE_GC_TIMEOUT_MS = 15 * 60 * 1000;

  /** Best-effort `git gc` over a private repo. Runs outside the handler
   *  deadline accounting (never awaited by a handler) so a slow gc can never
   *  hit the host's timeout. `--prune=now` drops unreferenced objects
   *  immediately: expiring sessions would otherwise leave recoverable file
   *  content behind indefinitely. */
  async function schedulePrivateGc(gitDir: string): Promise<void> {
    try {
      // Run from a neutral cwd so a slow gc never holds a handle on either the
      // user's workspace or the snapshot repo itself (Windows keeps a child's
      // cwd handle until it exits, which would race teardown rms and the
      // eviction sweep). GIT_DIR is set, so the repo operations work anywhere.
      await gitRunnerFactory(tmpdir(), { GIT_DIR: gitDir })(["gc", "--prune=now"], {
        timeoutMs: PRIVATE_GC_TIMEOUT_MS,
      });
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

  /** Removes private repos whose workspace no longer exists. Runs at boot and
   *  on shutdown so vanished workspaces cannot leave their snapshot repos
   *  (and the file contents inside them) behind forever.
   *
   *  Deliberately conservative: eviction requires the workspace stat to fail
   *  with ENOENT/ENOTDIR twice (re-checked after a delay, so a single mount
   *  or AV hiccup cannot trigger it), the repo to be idle past
   *  EVICTION_IDLE_CUTOFF_MS, nothing touching snapshot repos to be in
   *  flight, and even then the repo is only renamed aside as `.evicted-<ts>`
   *  trash for EVICTION_TRASH_RETENTION_MS instead of being deleted outright. */
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
        const config = await readFile(join(path, "config"), "utf8");
        const worktreeMatch = /^\s*worktree\s*=\s*(.+)$/m.exec(config);
        if (!worktreeMatch) continue;
        const worktree = worktreeMatch[1].trim();
        const vanished = async (): Promise<boolean> => {
          try {
            await stat(worktree);
            return false;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            // Anything else (EACCES, EBUSY, EIO, EMFILE...) means "cannot
            // tell", which must never be read as "gone".
            return code === "ENOENT" || code === "ENOTDIR";
          }
        };
        if (!(await vanished())) continue;
        await new Promise((resolve) => setTimeout(resolve, EVICTION_RETRY_DELAY_MS));
        if (!(await vanished())) continue;
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
  const explicitActiveHashes = new Set<string>();

  function activeSessionHashes(): ReadonlySet<string> {
    const hashes = new Set<string>(explicitActiveHashes);
    for (const sessionId of [...navigations.keys(), ...pending.keys(), ...initializations.keys()]) {
      hashes.add(checkpointNamespace(sessionId));
    }
    return hashes;
  }

  // Cross-process liveness beats: load/save touch .active markers, but a
  // session left open and idle would otherwise go stale past the heartbeat
  // TTL while its owner process is still running. A slow unref'd interval
  // re-asserts liveness for exactly the locally active sessions (the same
  // set the sweeps already treat as protected), so foreign sweepers never
  // see a live session as expired. Deliberately not `backends`: that map
  // retains every session ever initialized here, and beating abandoned ones
  // would shield them from retention for the process's lifetime.
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
      const backend = await resolveBackend(ctx.cwd, privateRepositories, gitRunnerFactory);
      backends.set(sessionId, backend);
      if (backend.kind === "session") {
        notifySessionOnly(ctx, sessionId, backend.reason);
      }

      if (
        backend.kind === "git" &&
        !expirationPromises.has(`git:${backend.repository.commonDir}`)
      ) {
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

  async function releasePending(pendingCheckpoint: PendingTurnCheckpoint): Promise<void> {
    if (pendingCheckpoint.kind === "git") {
      await releasePendingCheckpoint(gitRunnerFor(pendingCheckpoint.repository), pendingCheckpoint);
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
          if (
            checkpoint.kind === "git" &&
            checkpoint.repository.gitDir &&
            isPrivateRepository(checkpoint.repository.gitDir)
          ) {
            const gitDir = checkpoint.repository.gitDir;
            const count = (capturesSinceGcByGitDir.get(gitDir) ?? 0) + 1;
            if (count >= PRIVATE_GC_AFTER_CAPTURES) {
              capturesSinceGcByGitDir.delete(gitDir);
              // The current capture's git work is done (this runs after its
              // snapshot); only defer when another session's capture is still
              // mid-flight — a concurrent `git gc --prune=now` could prune an
              // unreferenced-but-pending object it just wrote. The counter
              // reset below prevents gc runs from stacking.
              if (pendingCaptures.size <= 1) {
                void track(() => schedulePrivateGc(gitDir));
              } else {
                capturesSinceGcByGitDir.set(gitDir, PRIVATE_GC_AFTER_CAPTURES - 1);
              }
            } else {
              capturesSinceGcByGitDir.set(gitDir, count);
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

  pi.on("session_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const previousPending = pending.get(sessionId);
      pending.delete(sessionId);
      if (previousPending) await releasePending(previousPending);
      turnStartLeafBySession.delete(sessionId);
      // An in-flight capture for this session no longer belongs to a live turn:
      // it self-releases on completion via the identity check in beginCapture.
      pendingCaptures.delete(sessionId);
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
  // which is a safe superset.
  const rememberNavigationSource = (_event: unknown, ctx: unknown) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as AnyContext;
      pendingNavigationSourceSessionId = typed.sessionManager.getSessionId();
    });

  const invalidateNavigationSourceRedo = () =>
    track(async () => {
      if (closing) return;
      const sourceSessionId = pendingNavigationSourceSessionId;
      pendingNavigationSourceSessionId = null;
      if (sourceSessionId) {
        await navigations.get(sourceSessionId)?.invalidateRedo();
      } else {
        await invalidateAllRedo();
      }
    });

  pi.on("session_before_switch", rememberNavigationSource);
  pi.on("session_switch", invalidateNavigationSourceRedo);
  pi.on("session_before_branch", rememberNavigationSource);
  pi.on("session_branch", invalidateNavigationSourceRedo);

  pi.on("before_agent_start", (_event, ctx) =>
    track(async () => {
      if (closing) return;
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const oldPending = pending.get(sessionId);
      pending.delete(sessionId);
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
      const capture = beginCapture(sessionId, async () => {
        const prepared =
          backend.kind === "git"
            ? await prepareBeforeTurn(backend.git, sessionId, ownerRegistry)
            : { status: "session_only" as const, reason: backend.reason };
        // Bound to the leaf recorded above, never a fresh getLeafId(): the
        // finalize identity check and the pending-slot check both compare
        // against that value.
        const checkpoint: PendingTurnCheckpoint =
          prepared.status === "git"
            ? { ...prepared.checkpoint, parentLeafId: turnStartLeaf }
            : { kind: "session", reason: prepared.reason, parentLeafId: turnStartLeaf };
        return checkpoint;
      });
      await timedOutAfter(capture.complete, captureDeadlineMs);
    }),
  );

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
          await finalizeTurn(typed, capture, leafId, turnStartLeaf);
          return;
        }
        await finalizeTurn(typed, capture, leafId, turnStartLeaf);
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
    void tracked.then(() => {
      if (pendingFinalizations.get(sessionId) === tracked) pendingFinalizations.delete(sessionId);
    });
    return handlerDone;
  }

  /** The live navigation for `sessionId`, creating and publishing one when the
   *  session has none (a turn can finalize before any navigation was built). */
  async function resolveNavigation(
    typed: AnyContext,
    sessionId: string,
  ): Promise<SessionNavigation> {
    const nav =
      (await ensureNavigation(typed)) ??
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
    capture: PendingCapture,
    leafId: string | null,
    turnStartLeaf: string | null,
  ): Promise<void> {
    const sessionId = typed.sessionManager.getSessionId();
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
        const retained = await retainCheckpointForResume(
          gitRunnerFor(result.checkpoint.repository),
          sessionId,
          result.checkpoint,
        );
        const nav = await resolveNavigation(typed, sessionId);
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
    const nav = await resolveNavigation(typed, sessionId);
    await nav.recordTurnEnd(completed);
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
      await releaseAllPersistentSnapshotIndices();
      await drainState();
      await ownerRegistry.shutdown();
      // Private-repo housekeeping on the way out: evict repos whose
      // workspaces vanished, then gc repos that crossed the capture
      // threshold. Runs detached so an overrunning sweep cannot delay
      // shutdown, but internally sequenced: a gc racing the sweep would
      // both hold handles through the rename and bump mtimes past the idle
      // cutoff, so every gc waits for eviction to finish first and skips
      // repos it renamed away. Whatever is unfinished when the process
      // exits is covered by the next boot sweep.
      void evictStalePrivateRepos()
        .catch(() => undefined)
        .then(() =>
          Promise.allSettled(
            [...privateRepositories.values()].map(async (entry) => {
              if ("failure" in entry || entry.repository?.private !== true || !entry.git) return;
              const gitDir = entry.repository.gitDir;
              if (!capturesSinceGcByGitDir.has(gitDir)) return;
              capturesSinceGcByGitDir.delete(gitDir);
              try {
                await stat(gitDir);
              } catch {
                return;
              }
              await schedulePrivateGc(gitDir);
            }),
          ),
        );
      await runtimeStore.shutdown();
    })();
    return shutdownPromise;
  });

  const makeHandler = (id: ActionId) => async (_args: string, ctx: ExtensionCommandContext) => {
    const token = randomUUID();
    const typed = ctx as unknown as AnyContext;
    const sessionId = typed.sessionManager.getSessionId();
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

  // Boot-time housekeeping (all fire-and-forget, unref'd — 0ms handler latency)
  void evictStalePrivateRepos().catch(() => undefined);
  void cleanLegacyGitIndexes().catch(() => undefined);
  {
    const t = setTimeout(() => {
      void sweepOrphanTempIndexes().catch(() => undefined);
      void purgeLegacyBlobStore().catch(() => undefined);
    }, 2_000);
    t.unref?.();
  }
}
