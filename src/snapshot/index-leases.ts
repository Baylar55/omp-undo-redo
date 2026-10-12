import { rm } from "node:fs/promises";
import type { GitRepository, SnapshotIndexLease } from "../types.js";
import { checkpointNamespace } from "../infra/paths.js";

/** Every pool alive in this module instance, for the test-only
 *  `releaseAllPersistentSnapshotIndices`. */
const livePools = new Set<IndexLeasePool>();

export function persistentIndexKey(repository: GitRepository, sessionId: string): string {
  return `${repository.worktree}\u0000${checkpointNamespace(sessionId)}`;
}

// Alternate index reused across turns so each turn is not a full `git add -A`
// re-hash of the whole worktree. The first turn seeds it (with the user's own
// index stat data where `seedFromUserIndex` allows, else a full `add -A`
// re-hash) and every later turn's before/after snapshot reuses it, so
// unchanged files are skipped via git's stat-dance instead of being
// re-read. Keyed by repository + session so concurrent sessions/repos stay
// isolated. The lease is dropped (and reseeded) whenever its baseline tree
// changes, and evicted whenever its directory is released. With an unborn HEAD
// there is no baseline commit, so the seeding snapshot's own tree is the
// baseline and the lease goes stale once HEAD becomes born.
//
// The map holds only IDLE leases. A run takes its lease out for the whole
// before→after span (`leasesInUse`) and hands it back when the after-snapshot
// succeeds, so two overlapping turns never share one GIT_INDEX_FILE: a turn that
// starts while the previous after-snapshot still runs seeds its own index.
//
// One pool per extension copy: OMP binds a separate copy of the extension to
// every in-process subagent session, and module state can be shared between
// copies, so a copy's leases live in its own pool.
export class IndexLeasePool {
  private readonly persistentSnapshotIndices = new Map<string, SnapshotIndexLease>();
  private readonly leasesInUse = new Map<SnapshotIndexLease, string>();

  constructor() {
    livePools.add(this);
  }

  /** Drops this pool from `livePools` once its extension copy shut down and
   *  released its leases, so long-lived processes do not keep one pool per
   *  finished subagent copy. */
  dispose(): void {
    livePools.delete(this);
  }

  /** Releases the leases, idle or checked out, of `sessionIds` only.
   *  `inUse: false` keeps the checked-out ones, which a running git may still
   *  be writing. */
  async releasePersistentSnapshotIndices(
    sessionIds: Iterable<string>,
    { inUse = true }: { inUse?: boolean } = {},
  ): Promise<void> {
    const suffixes = [...sessionIds].map((sessionId) => `\u0000${checkpointNamespace(sessionId)}`);
    const owned = (key: string): boolean => suffixes.some((suffix) => key.endsWith(suffix));
    const leases = [
      ...[...this.persistentSnapshotIndices]
        .filter(([key]) => owned(key))
        .map(([, lease]) => lease),
      ...(inUse
        ? [...this.leasesInUse].filter(([, key]) => owned(key)).map(([lease]) => lease)
        : []),
    ];
    await Promise.all(leases.map((lease) => this.releaseSnapshotIndexLease(lease)));
  }

  /** Releases every lease of this pool, idle or checked out. */
  async releaseAll(): Promise<void> {
    const leases = [...this.persistentSnapshotIndices.values(), ...this.leasesInUse.keys()];
    await Promise.all(leases.map((lease) => this.releaseSnapshotIndexLease(lease)));
  }

  async releaseSnapshotIndexLease(lease: SnapshotIndexLease | undefined): Promise<boolean> {
    if (!lease) return true;
    this.leasesInUse.delete(lease);
    for (const [key, value] of this.persistentSnapshotIndices) {
      if (value === lease) this.persistentSnapshotIndices.delete(key);
    }
    try {
      await rm(lease.directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Hands a finished run's lease back to the idle pool. No-op when the lease
   *  was released meanwhile (shutdown, stale baseline); when another run
   *  already pooled a lease for this key, the surplus one is deleted. */
  async returnLeaseToPool(lease: SnapshotIndexLease | undefined): Promise<void> {
    const key = lease && this.leasesInUse.get(lease);
    if (!lease || key === undefined) return;
    this.leasesInUse.delete(lease);
    if (this.persistentSnapshotIndices.has(key)) await this.releaseSnapshotIndexLease(lease);
    else this.persistentSnapshotIndices.set(key, lease);
  }

  /** Takes the idle lease for `key` out of the pool and checks it out. */
  checkOutIdleLease(key: string): SnapshotIndexLease | undefined {
    const lease = this.persistentSnapshotIndices.get(key);
    if (lease) {
      this.persistentSnapshotIndices.delete(key);
      this.leasesInUse.set(lease, key);
    }
    return lease;
  }

  markLeaseInUse(lease: SnapshotIndexLease, key: string): void {
    this.leasesInUse.set(lease, key);
  }

  /** The pool key of a checked-out lease; undefined once it was released. */
  leaseKeyInUse(lease: SnapshotIndexLease): string | undefined {
    return this.leasesInUse.get(lease);
  }
}

/** The pool of callers that pass none: test call sites only. Every call in
 *  `src/` passes its extension copy's pool. */
export const defaultPool = new IndexLeasePool();

/** `defaultPool.releasePersistentSnapshotIndices`, for tests that capture
 *  without an extension copy. */
export function releasePersistentSnapshotIndices(
  sessionIds: Iterable<string>,
  options?: { inUse?: boolean },
): Promise<void> {
  return defaultPool.releasePersistentSnapshotIndices(sessionIds, options);
}

/** Releases every lease of every pool in this process, idle or checked out.
 *  Only for a process that hosts no other live copy of the extension: test
 *  workers, whose sessions never shut down. */
export async function releaseAllPersistentSnapshotIndices(): Promise<void> {
  await Promise.all([...livePools].map((pool) => pool.releaseAll()));
}
