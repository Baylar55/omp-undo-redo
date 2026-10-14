import { stat } from "node:fs/promises";
import type { CheckpointOwnerRegistry } from "../store/owners.js";
import type {
  FileCheckpointUnavailableReason,
  GitCheckpoint,
  GitRepository,
  GitRunner,
  PendingGitCheckpoint,
  SnapshotIndexLease,
} from "../types.js";
import { run } from "../infra/git-runner.js";
import { storeEnv, boundStore } from "../store/git-store.js";
import { resolveRepository, canonicalPath } from "../store/discovery.js";
import { pinBorrowedObjects } from "../store/pinning.js";
import { persistentIndexKey } from "./index-leases.js";
import type { IndexLeasePool } from "./index-leases.js";
import { createSnapshotCommitFromLease, createSnapshotCommit } from "./tree.js";
import type { SnapshotResult } from "./tree.js";
import { newCheckpointId, checkpointRefs, releasePendingCheckpoint } from "./checkpoint-refs.js";

export type PrepareBeforeTurnResult =
  | { status: "git"; checkpoint: PendingGitCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

export type FinishAfterTurnResult =
  | { status: "git"; checkpoint: GitCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

/** `known`: the store-bound repository `git` was created for. Callers holding
 *  the backend pass it, which spares a `rev-parse` per turn and lets a host
 *  runner factory that wraps runners without re-exposing `runner.env` still
 *  capture. Without it the repository is resolved from `git`. */
export async function prepareBeforeTurn(
  git: GitRunner,
  sessionId: string,
  pool: IndexLeasePool,
  ownerRegistry?: CheckpointOwnerRegistry,
  known?: GitRepository,
): Promise<PrepareBeforeTurnResult> {
  let repository: GitRepository;
  if (known) {
    // A git dir removed mid-session must not let discovery fall through to an
    // enclosing repository; a stat keeps the turn spawn-free.
    if (!(await stat(known.gitDir).catch(() => null))) {
      return { status: "session_only", reason: "not_repository" };
    }
    repository = known;
  } else {
    const resolved = await resolveRepository(git);
    if ("reason" in resolved) return { status: "session_only", reason: resolved.reason };
    // Fail closed: without a store, snapshot objects and refs would land in
    // the user's repository, where all-refs operations export them.
    const store = boundStore(git);
    if (!store) return { status: "session_only", reason: "repository_unresolvable" };
    repository = {
      ...resolved.repository,
      storeDir: await canonicalPath(store, resolved.repository.worktree),
    };
  }

  const ownership = ownerRegistry
    ? await ownerRegistry.ensureInitialized(repository, git)
    : "legacy";
  const checkpointId = newCheckpointId();
  const indexKey = persistentIndexKey(repository, sessionId);
  const priorLease = pool.checkOutIdleLease(indexKey);
  let snapshot: SnapshotResult;
  let lease: SnapshotIndexLease | undefined;
  if (priorLease) {
    const reused = await createSnapshotCommitFromLease(
      git,
      priorLease,
      "omp-undo-redo: before turn",
    );
    if ("hash" in reused) {
      snapshot = reused;
      lease = priorLease;
    } else {
      await pool.releaseSnapshotIndexLease(priorLease);
      snapshot = await createSnapshotCommit(
        git,
        "omp-undo-redo: before turn",
        true,
        repository.gitDir,
      );
      if ("hash" in snapshot) lease = snapshot.snapshotIndexLease;
    }
  } else {
    snapshot = await createSnapshotCommit(
      git,
      "omp-undo-redo: before turn",
      true,
      repository.gitDir,
    );
    if ("hash" in snapshot) lease = snapshot.snapshotIndexLease;
  }
  if (lease) pool.markLeaseInUse(lease, indexKey);
  if (!("hash" in snapshot)) {
    return {
      status: "session_only",
      reason: snapshot.reason === "invalid_head" ? "invalid_head" : "before_snapshot_failed",
    };
  }
  if (!(await pinBorrowedObjects(git, repository, snapshot.tree))) {
    await pool.releaseSnapshotIndexLease(lease);
    return { status: "session_only", reason: "before_snapshot_failed" };
  }
  const { beforeRef } = checkpointRefs(sessionId, checkpointId, ownership, ownerRegistry?.ownerId);
  if (
    !(await run(
      git,
      ["update-ref", "-m", "omp-undo-redo: retain before checkpoint", beforeRef, snapshot.hash],
      { env: storeEnv(repository) },
    ))
  ) {
    await pool.releaseSnapshotIndexLease(lease);
    return {
      status: "session_only",
      reason: "before_ref_failed",
    };
  }
  // The lease stays checked out (`leasesInUse`) until finishAfterTurn returns it.
  return {
    status: "git",
    checkpoint: {
      kind: "git",
      repository,
      beforeHash: snapshot.hash,
      beforeRef,
      checkpointId,
      ...(lease ? { snapshotIndexLease: lease } : {}),
      parentLeafId: null,
    },
  };
}

export async function finishAfterTurn(
  git: GitRunner,
  before: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "snapshotIndexLease"
  >,
  parentLeafId: string | null,
  leafId: string | null,
  pool: IndexLeasePool,
): Promise<FinishAfterTurnResult> {
  let snapshot: SnapshotResult;
  let lease = before.snapshotIndexLease;
  if (lease) {
    snapshot = await createSnapshotCommitFromLease(git, lease, "omp-undo-redo: after turn");
    if (!("hash" in snapshot)) {
      // HEAD moved (or another failure occurred) since the turn began: the
      // retained alternate index is stale, so drop it and fall back to a fresh
      // snapshot whose index replaces it in the pool, sparing the next turn a
      // second full re-hash. No pool key means the lease was released meanwhile
      // (shutdown): nothing to retain then.
      const key = pool.leaseKeyInUse(lease);
      await pool.releaseSnapshotIndexLease(lease);
      snapshot = await createSnapshotCommit(
        git,
        "omp-undo-redo: after turn",
        key !== undefined,
        before.repository.gitDir,
      );
      lease = "hash" in snapshot ? snapshot.snapshotIndexLease : undefined;
      if (lease && key !== undefined) pool.markLeaseInUse(lease, key);
    }
    // On success the lease index now reflects the after-state and stays in the
    // persistent cache for the next turn's before snapshot.
  } else {
    snapshot = await createSnapshotCommit(
      git,
      "omp-undo-redo: after turn",
      false,
      before.repository.gitDir,
    );
  }
  const pending = { ...before, snapshotIndexLease: lease };
  if (!("hash" in snapshot)) {
    await releasePendingCheckpoint(git, pending, pool);
    return {
      status: "session_only",
      reason: snapshot.reason === "invalid_head" ? "invalid_head" : "after_snapshot_failed",
    };
  }
  if (!(await pinBorrowedObjects(git, before.repository, snapshot.tree))) {
    await releasePendingCheckpoint(git, pending, pool);
    return { status: "session_only", reason: "after_snapshot_failed" };
  }
  const afterRef = before.beforeRef.replace(/\/before$/, "/after");
  if (
    !(await run(
      git,
      ["update-ref", "-m", "omp-undo-redo: retain after checkpoint", afterRef, snapshot.hash],
      { env: storeEnv(before.repository) },
    ))
  ) {
    await releasePendingCheckpoint(git, pending, pool);
    return { status: "session_only", reason: "after_ref_failed" };
  }
  await pool.returnLeaseToPool(lease);
  return {
    status: "git",
    checkpoint: {
      kind: "git",
      repository: before.repository,
      beforeHash: before.beforeHash,
      beforeRef: before.beforeRef,
      afterHash: snapshot.hash,
      afterRef,
      parentLeafId,
      leafId,
    },
  };
}
