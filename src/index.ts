import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import {
  CheckpointOwnerRegistry,
  resolvePersistentHostId,
  resolveRuntimeScope,
} from "./core/checkpoint-owners.js";
import { createEnvGitRunner, createGitRunner } from "./core/git-runner.js";
import { canonicalCwd, ensurePrivateGitRepository } from "./core/private-repo.js";
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
  releaseAllPersistentSnapshotIndices,
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
  GitRunner,
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

export type FileBackend =
  | { kind: "git"; repository: GitRepository; git: ReturnType<typeof createGitRunner> }
  | { kind: "blob"; store: BlobStore; workspaceRoot: string }
  | { kind: "session"; reason: "git_unavailable" | "not_repository" | "repository_unresolvable" };

export type OmpUndoRedoDependencies = {
  /** Overrides how git runners are created, letting hosts and tests inject
   *  behavior (e.g. slowing captures to exercise the bounded handler path).
   *  Receives the canonical worktree and an optional fixed env (used for
   *  private per-workspace repositories). */
  gitRunnerFactory?: (cwd: string, env?: Record<string, string>) => GitRunner;
  /** How long the before_agent_start / agent_end / undo / redo handlers wait
   *  for an in-flight checkpoint capture before returning without it. The
   *  capture keeps running and the turn is finalized when it settles. */
  captureDeadlineMs?: number;
};

export const DEFAULT_CAPTURE_DEADLINE_MS = 3_000;

function defaultGitRunnerFactory(cwd: string, env?: Record<string, string>): GitRunner {
  return env ? createEnvGitRunner(cwd, env) : createGitRunner(cwd);
}

async function awaitWithDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ value: T | undefined; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true; value: undefined }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true, value: undefined }), Math.max(1, ms));
    timer.unref?.();
  });
  try {
    return await Promise.race([
      promise.then((value) => ({ timedOut: false as const, value })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Per-controller private-repo state: a ready entry carries the repository and
 *  the env runner (GIT_DIR fixed), with `ready` resolving true once init
 *  completes; a `failure` entry records a failed init so blob fallback is
 *  reused without retrying. Keyed by canonical cwd (private) or commonDir
 *  (git mode). */
export type PrivateRepoEntry =
  { repository?: GitRepository; git?: GitRunner; ready: Promise<boolean> } | { failure: true };

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

function startPrivateRepo(
  canonical: string,
  gitRunnerFactory: (
    cwd: string,
    env?: Record<string, string>,
  ) => GitRunner = defaultGitRunnerFactory,
): PrivateRepoEntry {
  const storeRoot = blobStoreRootDirectory();
  const entry: PrivateRepoEntry = {
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
  git: GitRunner,
  privateRepositories: Map<string, PrivateRepoEntry>,
  gitRunnerFactory: (
    cwd: string,
    env?: Record<string, string>,
  ) => GitRunner = defaultGitRunnerFactory,
): Promise<{ repository: GitRepository; git: GitRunner } | null> {
  const canonical = await canonicalCwd(cwd);
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
  if ("failure" in entry) return null;
  const ok = await entry.ready;
  if (!ok || !entry.repository || !entry.git) {
    privateRepositories.set(canonical, { failure: true });
    return null;
  }
  return { repository: entry.repository, git: entry.git };
}

export async function resolveBackend(
  cwd: string,
  blobStoreFor: (workspaceRoot: string) => BlobStore,
  privateGitEnabled: boolean,
  privateRepositories: Map<string, PrivateRepoEntry> = new Map(),
  gitRunnerFactory: (
    cwd: string,
    env?: Record<string, string>,
  ) => GitRunner = defaultGitRunnerFactory,
): Promise<FileBackend> {
  const git = gitRunnerFactory(cwd);
  const resolved = await resolveRepository(git);
  if ("repository" in resolved) {
    const repository = resolved.repository;
    const existing = privateRepositories.get(repository.commonDir);
    if (existing && "git" in existing && existing.git) {
      return { kind: "git", repository, git: existing.git };
    }
    privateRepositories.set(repository.commonDir, {
      repository,
      git,
      ready: Promise.resolve(true),
    });
    return { kind: "git", repository, git };
  }
  const marker = await hasGitMarkerInAncestors(cwd);
  if (resolved.reason !== "not_repository" && !(resolved.reason === "git_unavailable" && !marker)) {
    return { kind: "session", reason: resolved.reason };
  }
  if (resolved.reason === "not_repository" && privateGitEnabled) {
    const privateBackend = await resolvePrivateGit(cwd, git, privateRepositories, gitRunnerFactory);
    if (privateBackend) {
      return { kind: "git", repository: privateBackend.repository, git: privateBackend.git };
    }
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
  gitForRepository?: (repository: GitRepository) => GitRunner,
  gitRunnerFactory: (
    cwd: string,
    env?: Record<string, string>,
  ) => GitRunner = defaultGitRunnerFactory,
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
    backend?.kind === "git" ? backend.git : gitRunnerFactory(ctx.cwd),
    gitForRepository ?? ((repository) => gitRunnerFactory(repository.worktree)),
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

export default function ompUndoRedo(pi: ExtensionAPI, deps: OmpUndoRedoDependencies = {}): void {
  const retentionConfig = readRetentionConfig();
  const privateGitEnabled = process.env.OMP_UNDO_REDO_PRIVATE_GIT !== "0";
  const privateRepositories = new Map<string, PrivateRepoEntry>();
  const gitRunnerFactory = deps.gitRunnerFactory ?? defaultGitRunnerFactory;
  const captureDeadlineMs = deps.captureDeadlineMs ?? DEFAULT_CAPTURE_DEADLINE_MS;
  function gitRunnerFor(repository: GitRepository): GitRunner {
    const entry =
      privateRepositories.get(repository.commonDir) ?? privateRepositories.get(repository.worktree);
    if (entry && "git" in entry && entry.git) return entry.git;
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
  const blobStores = new Map<string, BlobStore>();
  const pending = new Map<string, PendingTurnCheckpoint>();
  type PendingCapture = {
    complete: Promise<void>;
    checkpoint: PendingTurnCheckpoint | null;
    failed: boolean;
  };
  /** Leaf the current turn started from, per session. Used to bind a
   *  checkpoint to the turn that captured it: a deferred finalize whose
   *  checkpoint predates the current turn is released, never recorded with
   *  the wrong leaf. */
  const turnStartLeafBySession = new Map<string, string | null>();

  /** True when `gitDir` belongs to one of our private per-workspace repos.
   *  Guards gc/prune triggers so they can never touch a user's own repo.
   *  The incoming gitDir is realpath-canonicalized before comparing so a
   *  checkpoint recorded with a long-form path still matches a repository
   *  whose gitDir was built from a short-form (8.3) store root or cwd —
   *  otherwise the string compare silently fails and the gc counter never
   *  increments (repo growth stays unbounded on such machines). */
  async function isPrivateRepository(gitDir: string): Promise<boolean> {
    const canonicalGitDir = await canonicalCwd(gitDir);
    for (const entry of privateRepositories.values()) {
      if ("failure" in entry) continue;
      if (!entry.repository?.gitDir) continue;
      const canonicalEntry = await canonicalCwd(entry.repository.gitDir);
      if (canonicalEntry === canonicalGitDir) return true;
    }
    return false;
  }

  // Private-repo housekeeping: captures between gc runs (per repo) and the
  // threshold that triggers a background `git gc`.
  const PRIVATE_GC_AFTER_CAPTURES = 20;
  const capturesSinceGcByGitDir = new Map<string, number>();

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
      await gitRunnerFactory(tmpdir(), { GIT_DIR: gitDir })(["gc", "--prune=now"]);
    } catch {
      // Best-effort: a failed gc leaves more work for the next trigger.
    }
  }

  /** One-time removal of legacy git-indexes directory from pre-v1.5.1 store layout */
  async function cleanLegacyGitIndexes(): Promise<void> {
    const legacy = join(await canonicalCwd(blobStoreRootDirectory()), "git-indexes");
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

  /** Removes private repos whose workspace no longer exists. Runs at boot and
   *  on shutdown so vanished workspaces cannot leave their snapshot repos
   *  (and the file contents inside them) behind forever. */
  async function evictStalePrivateRepos(): Promise<void> {
    const reposDir = join(await canonicalCwd(blobStoreRootDirectory()), "repos");
    let entries: string[];
    try {
      entries = await readdir(reposDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".git")) continue;
      const gitDir = join(reposDir, entry);
      try {
        const config = await readFile(join(gitDir, "config"), "utf8");
        const worktreeMatch = /^\s*worktree\s*=\s*(.+)$/m.exec(config);
        if (!worktreeMatch) continue;
        const worktree = worktreeMatch[1].trim();
        try {
          await stat(worktree);
        } catch {
          // Workspace vanished: drop the repo. A gc or other git child may
          // still hold the dir handle on Windows; retry briefly so a single
          // transient EBUSY does not strand the repo until the next sweep.
          for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
              await rm(gitDir, { recursive: true, force: true });
              break;
            } catch {
              if (attempt === 4) throw new Error(`could not evict ${gitDir}`);
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          }
        }
      } catch {
        // Unreadable repo: leave it for a later sweep.
      }
    }
  }

  const pendingCaptures = new Map<string, PendingCapture>();
  const pendingFinalizations = new Map<string, Promise<void>>();
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
      const backend = await resolveBackend(
        ctx.cwd,
        (workspaceRoot) => blobStoreFor(workspaceRoot),
        privateGitEnabled,
        privateRepositories,
        gitRunnerFactory,
      );
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
      await releasePendingCheckpoint(gitRunnerFor(pendingCheckpoint.repository), pendingCheckpoint);
      return;
    }
    if (pendingCheckpoint.kind === "blob") {
      const store =
        blobStores.get(blobStoreRootDirectory()) ?? new BlobStore(blobStoreRootDirectory());
      await releaseBlobPendingCheckpoint(store, pendingCheckpoint);
    }
  }

  function beginCapture(
    sessionId: string,
    task: () => Promise<PendingTurnCheckpoint>,
  ): PendingCapture {
    const capture: PendingCapture = {
      complete: Promise.resolve(),
      checkpoint: null,
      failed: false,
    };
    const { promise: complete, resolve } = promiseWithResolvers<void>();
    capture.complete = complete;
    void track(async () => {
      try {
        const checkpoint = await task();
        if (closing || pendingCaptures.get(sessionId) !== capture) {
          await releasePending(checkpoint);
          capture.failed = true;
        } else {
          capture.checkpoint = checkpoint;
          pending.set(sessionId, checkpoint);
          if (
            checkpoint.kind === "git" &&
            checkpoint.repository.gitDir &&
            (await isPrivateRepository(checkpoint.repository.gitDir))
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
        capture.failed = true;
      } finally {
        resolve();
        if (pendingCaptures.get(sessionId) === capture) pendingCaptures.delete(sessionId);
      }
    });
    pendingCaptures.set(sessionId, capture);
    return capture;
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

      // Record the leaf this turn starts from, then bound concurrent captures:
      // a turn that starts while the previous turn's capture is still in flight
      // gets no new capture (its undo boundary is session-only) instead of
      // stacking overlapping `git add` runs over the same workspace.
      turnStartLeafBySession.set(sessionId, typed.sessionManager.getLeafId());
      if (pendingCaptures.has(sessionId)) return;

      const backend =
        backends.get(sessionId) ??
        (await resolveBackend(
          typed.cwd,
          (workspaceRoot) => blobStoreFor(workspaceRoot),
          privateGitEnabled,
          privateRepositories,
          gitRunnerFactory,
        ));
      backends.set(sessionId, backend);
      const parentLeafId = typed.sessionManager.getLeafId();
      const capture = beginCapture(sessionId, async () => {
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
        const checkpoint: PendingTurnCheckpoint =
          prepared.status === "git"
            ? { ...prepared.checkpoint, parentLeafId }
            : prepared.status === "blob"
              ? { ...prepared.checkpoint, parentLeafId }
              : { kind: "session", reason: prepared.reason, parentLeafId };
        return checkpoint;
      });
      const outcome = await awaitWithDeadline(capture.complete, captureDeadlineMs);
      if (outcome.timedOut) return;

      const settled = pending.get(sessionId);
      if (!settled) return;
    }),
  );

  function beginFinalizeTurn(
    typed: AnyContext,
    capture: PendingCapture,
    leafId: string | null,
    turnStartLeaf: string | null,
  ): Promise<void> {
    const sessionId = typed.sessionManager.getSessionId();
    let handlerRelease!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      handlerRelease = resolve;
    });
    const work = (async () => {
      try {
        const outcome = await awaitWithDeadline(capture.complete, captureDeadlineMs);
        if (outcome.timedOut) {
          // The capture overran the handler deadline. Keep this turn's
          // finalize identity-bound — same capture, same leaf, same turn-start
          // leaf, same context — so when it settles it finalizes its own
          // checkpoint instead of a later turn's.
          handlerRelease();
          await capture.complete;
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
      pending.delete(sessionId);
      await releasePending(before);
      return;
    }
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
        leafId: leafId,
      };
    } else if (before.kind === "git") {
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
        await nav.recordTurnEnd(retained);
        return;
      }
      completed = {
        kind: "session",
        reason: result.reason,
        parentLeafId: before.parentLeafId,
        leafId: leafId,
      };
    } else {
      const backend = backends.get(sessionId);
      const store =
        backend?.kind === "blob" ? backend.store : new BlobStore(blobStoreRootDirectory());
      const result = await finishAfterTurnBlob(store, before, before.parentLeafId, leafId);
      if (result.status === "blob") {
        if (closing) {
          await releaseBlobCheckpoint(store, result.checkpoint);
          return;
        }
        const retained = await retainBlobCheckpointForResume(store, sessionId, result.checkpoint);
        if (retained) {
          const nav =
            (await ensureNavigation(typed)) ??
            createNavigation(
              typed,
              sessionId,
              undefined,
              runtimeStore,
              backend,
              gitRunnerFor,
              gitRunnerFactory,
            );
          navigations.set(sessionId, nav);
          await nav.recordTurnEnd(retained);
          return;
        }
        await releaseBlobCheckpoint(store, result.checkpoint);
        completed = {
          kind: "session",
          reason: "after_blob_failed",
          parentLeafId: before.parentLeafId,
          leafId: leafId,
        };
      } else {
        completed = {
          kind: "session",
          reason: result.reason,
          parentLeafId: before.parentLeafId,
          leafId: leafId,
        };
      }
    }
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
    await nav.recordTurnEnd(completed);
  }

  pi.on("agent_end", (_event, ctx) =>
    track(async () => {
      const typed = ctx as unknown as AnyContext;
      const sessionId = typed.sessionManager.getSessionId();
      const capture = pendingCaptures.get(sessionId);
      // A capture that already settled leaves no entry (its finally deletes
      // it), but its checkpoint stays in the pending map — finalize from that.
      const settled = capture ? null : (pending.get(sessionId) ?? null);
      if (!capture && !settled) return;
      await beginFinalizeTurn(
        typed,
        capture ?? { complete: Promise.resolve(), checkpoint: settled, failed: false },
        typed.sessionManager.getLeafId(),
        turnStartLeafBySession.get(sessionId) ?? null,
      );
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
      // Bounded: an overrunning capture must not delay shutdown indefinitely.
      // Any capture still running now self-releases on completion (closing is
      // set), and its temporary index is reclaimed by git or the OS.
      await awaitWithDeadline(Promise.allSettled([...activeOperations]), 5_000);
      await releaseAllPersistentSnapshotIndices();
      await drainState();
      await ownerRegistry.shutdown();
      // Private-repo housekeeping on the way out: gc repos that crossed the
      // capture threshold and evict repos whose workspaces vanished. Both run
      // fire-and-forget (the process may exit before they finish; the counter
      // trigger covers the in-process case).
      void Promise.allSettled(
        [...privateRepositories.values()].map(async (entry) => {
          if ("failure" in entry || !entry.repository || !entry.git) return;
          if (capturesSinceGcByGitDir.has(entry.repository.gitDir)) {
            capturesSinceGcByGitDir.delete(entry.repository.gitDir);
            await schedulePrivateGc(entry.repository.gitDir);
          }
        }),
      );
      void evictStalePrivateRepos().catch(() => undefined);
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
    const sessionId = typed.sessionManager.getSessionId();
    const capture = pendingCaptures.get(sessionId);
    if (capture) {
      const outcome = await awaitWithDeadline(capture.complete, captureDeadlineMs);
      if (outcome.timedOut) {
        ctx.ui.notify(
          "Cannot undo while the file checkpoint is still being captured; try again shortly.",
          "warning",
        );
        return;
      }
    }
    const pendingFinalize = pendingFinalizations.get(sessionId);
    if (pendingFinalize) {
      const outcome = await awaitWithDeadline(pendingFinalize, captureDeadlineMs);
      if (outcome.timedOut) {
        ctx.ui.notify(
          "Cannot undo while the last turn is still being finalized; try again shortly.",
          "warning",
        );
        return;
      }
    }
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
    const sessionId = typed.sessionManager.getSessionId();
    const capture = pendingCaptures.get(sessionId);
    if (capture) {
      const outcome = await awaitWithDeadline(capture.complete, captureDeadlineMs);
      if (outcome.timedOut) {
        ctx.ui.notify(
          "Cannot redo while the file checkpoint is still being captured; try again shortly.",
          "warning",
        );
        return;
      }
    }
    const pendingFinalize = pendingFinalizations.get(sessionId);
    if (pendingFinalize) {
      const outcome = await awaitWithDeadline(pendingFinalize, captureDeadlineMs);
      if (outcome.timedOut) {
        ctx.ui.notify(
          "Cannot redo while the last turn is still being finalized; try again shortly.",
          "warning",
        );
        return;
      }
    }
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

  // Boot-time housekeeping (all fire-and-forget, unref'd — 0ms handler latency)
  void evictStalePrivateRepos().catch(() => undefined);
  void cleanLegacyGitIndexes().catch(() => undefined);
  {
    const t = setTimeout(() => void sweepOrphanTempIndexes().catch(() => undefined), 2_000);
    t.unref?.();
  }
}
