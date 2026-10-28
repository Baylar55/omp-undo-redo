import { readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnyContext } from "../host-contract.js";
import { expireGitSessionHistories } from "../history/retention.js";
import { track } from "../infra/async.js";
import { canonicalCwd, checkpointNamespace, storeRootDirectory } from "../infra/paths.js";
import { evictStalePrivateRepos, storeSource } from "../store/maintenance/eviction.js";
import { removeStalePackedRefsLock, runCaptureGc, storeNeedsGc } from "../store/maintenance/gc.js";
import { sweepOrphanTempIndexes } from "../store/maintenance/temp-sweep.js";
import type { GitRepository, GitRunner } from "../types.js";
import type { ExtensionServices } from "./services.js";

/** Counter key: realpath-canonical, so a store spelled in long form on a
 *  checkpoint and in 8.3 short form on its backend still count as one.
 *  Memoized per repository object: every turn asks, `realpathSync` blocks. */
export function gcKey(repository: GitRepository): string {
  let key = gcKeys.get(repository);
  if (key === undefined) {
    key = canonicalCwd(repository.storeDir);
    gcKeys.set(repository, key);
  }
  return key;
}

const gcKeys = new WeakMap<GitRepository, string>();

/** OMP binds a separate copy of this extension to every in-process subagent
 *  session (`ctx.agent.kind === "sub"`). Nobody can `/undo` a subagent, so
 *  its copy captures nothing, keeps no history, waits on no tool call,
 *  refuses `/undo`/`/redo` (a subagent prompt starting with one runs it),
 *  and leaves boot and shutdown housekeeping to the main session's copy.
 *  Hosts without `ctx.agent` (Pi; OMP before 18.3.2) read as main. */
export function isMainSession(services: ExtensionServices, ctx: AnyContext): boolean {
  if (ctx.agent?.kind === "sub") {
    services.flags.servesSubagent = true;
    return false;
  }
  services.flags.servesMainSession = true;
  void startBootHousekeeping(services);
  return true;
}

/** Work touching snapshot stores is in flight: eviction defers to it. */
function storeWorkInFlight(services: ExtensionServices): boolean {
  const sessions = [...services.sessions.values()];
  return (
    sessions.some((s) => s.capture !== undefined) ||
    sessions.some((s) => s.finalize !== undefined) ||
    services.activeOperations.size > 0 ||
    services.housekeepingOperations.size > 0
  );
}

/** Boot housekeeping (eviction, orphaned temp indexes)
 *  starts with the copy's first main-session event instead of at load, so
 *  a subagent's copy skips it: the main session's copy already ran it.
 *  ponytail: a copy that sees no session event within
 *  BOOT_HOUSEKEEPING_FALLBACK_MS runs it anyway; a subagent whose first
 *  event arrives later than that sweeps once more, which is harmless (a
 *  sweep racing another one finds the store already renamed and skips it). */
export const BOOT_HOUSEKEEPING_FALLBACK_MS = 2_000;
export function startBootHousekeeping(services: ExtensionServices): Promise<void> {
  if (services.bootEviction) return services.bootEviction;
  services.bootEviction = evictStalePrivateRepos(services.gitRunnerFactory, () =>
    storeWorkInFlight(services),
  ).catch(() => undefined);
  const t = setTimeout(() => {
    void sweepOrphanTempIndexes().catch(() => undefined);
  }, 2_000);
  t.unref?.();
  return services.bootEviction;
}

export function activeSessionHashes(services: ExtensionServices): ReadonlySet<string> {
  const hashes = new Set<string>(services.explicitActiveHashes);
  for (const [sessionId, state] of services.sessions) {
    if (state.navigation || state.pending || state.initialization) {
      hashes.add(checkpointNamespace(sessionId));
    }
  }
  return hashes;
}

/** Expires dormant histories in `repository`, once per process. Deleting
 *  refs alone leaves the snapshots' plaintext file contents on disk, so the
 *  store then gets a background gc; so does a store `storeNeedsGc` finds
 *  garbage in, else a gc an earlier process never ran or finished would
 *  never be retried. */
export function expireRepository(
  services: ExtensionServices,
  repository: GitRepository,
  git: GitRunner,
): Promise<void> {
  const key = `git:${repository.storeDir}`;
  const existing = services.expirationPromises.get(key);
  if (existing) return existing;
  const expiration = (async () => {
    // Before expiry: a stale lock would fail its deletions and the gc below.
    await removeStalePackedRefsLock(repository.storeDir);
    const refsRemoved = await expireGitSessionHistories(
      repository,
      git,
      services.retentionDays,
      () => activeSessionHashes(services),
    );
    if (services.flags.closing) return;
    if (refsRemoved === 0 && !(await storeNeedsGc(repository.storeDir))) return;
    // Detached from the expiration promise and from shutdown's wait: neither
    // may wait out a gc.
    void track(() => services.gcQueue.schedule(repository), services.housekeepingOperations);
  })().catch(() => undefined);
  services.expirationPromises.set(key, expiration);
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
export async function sweepPrivateRepoRetention(services: ExtensionServices): Promise<void> {
  const reposDir = join(canonicalCwd(storeRootDirectory()), "repos");
  const entries = await readdir(reposDir).catch(() => [] as string[]);
  for (const entry of entries) {
    if (services.flags.closing) return;
    if (!entry.endsWith(".git")) continue;
    const gitDir = join(reposDir, entry);
    const source = await storeSource(reposDir, gitDir, services.gitRunnerFactory).catch(() => null);
    if (!source) continue;
    const { path } = source;
    await expireRepository(
      services,
      source.gitStore
        ? { worktree: path, gitDir: path, commonDir: path, storeDir: gitDir }
        : { worktree: path, gitDir, commonDir: gitDir, storeDir: gitDir },
      services.gitRunnerFactory(tmpdir(), { GIT_DIR: gitDir }),
    );
  }
}

/** Store housekeeping on the way out, detached so a slow expiry, sweep or
 *  gc never holds the shutdown handler. Turn work, sweeps and gcs (eviction
 *  defers to all of them) and in-flight expiries finish first: a sweep can
 *  start an expiry, and an expiry past its `closing` check can still queue
 *  a gc, hence the second housekeeping drain. Then sessions stop being
 *  protected. Then evict stores whose workspaces vanished, then gc stores
 *  that crossed the capture threshold: a gc racing the sweep would both
 *  hold handles through the rename and bump mtimes past the idle cutoff,
 *  so every gc waits for eviction to finish first and skips repos it
 *  renamed away. Whatever is unfinished when the process exits is covered
 *  by the next boot sweep. A subagent's copy leaves eviction and gc to the
 *  main session's copy. */
export async function runShutdownHousekeeping(
  services: ExtensionServices,
  teardown: Promise<void>,
): Promise<void> {
  await teardown.catch(() => undefined);
  await Promise.allSettled([
    ...services.activeOperations,
    ...[...services.sessions.values()].flatMap((s) =>
      s.finalize === undefined ? [] : [s.finalize],
    ),
    ...services.housekeepingOperations,
  ]);
  await Promise.allSettled([...services.expirationPromises.values()]);
  await Promise.allSettled([...services.housekeepingOperations]);
  services.explicitActiveHashes.clear();
  if (!services.flags.servesMainSession) return;
  await evictStalePrivateRepos(services.gitRunnerFactory, () => storeWorkInFlight(services)).catch(
    () => undefined,
  );
  await Promise.allSettled(
    [...services.privateRepositories.values()].map(async (entry) => {
      if (!entry.repository || !entry.git) return;
      const { repository } = entry;
      if (!services.gcQueue.takeCounted(gcKey(repository))) return;
      try {
        await stat(repository.storeDir);
      } catch {
        return;
      }
      await services.gcQueue.schedule(repository, runCaptureGc);
    }),
  );
}
