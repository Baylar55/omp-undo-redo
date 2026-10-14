import { randomBytes } from "node:crypto";
import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  OwnershipMode,
  PendingGitCheckpoint,
} from "../types.js";
import { checkpointNamespace } from "../infra/paths.js";
import { invoke } from "../infra/git-runner.js";
import { storeEnv } from "../store/git-store.js";
import {
  deleteRefsBatched,
  markGcPending,
  REF_ROOT,
  releaseRefs,
  releaseLooseRef,
  historyRefPrefix,
} from "../store/refs.js";
import type { IndexLeasePool } from "./index-leases.js";

/** 16-hex checkpoint ids (64 random bits) and no session hash in v2 refs
 *  keep ref paths short: they are loose files under the store's `refs/`. */
export function newCheckpointId(): string {
  return randomBytes(8).toString("hex");
}

export function checkpointRefs(
  sessionId: string,
  checkpointId: string,
  ownership: OwnershipMode,
  ownerId?: string,
): { beforeRef: string; afterRef: string } {
  const prefix =
    ownership === "v2" && ownerId
      ? `${REF_ROOT}/v2/${ownerId}/${checkpointId}`
      : `${REF_ROOT}/${checkpointNamespace(sessionId)}/${checkpointId}`;
  return { beforeRef: `${prefix}/before`, afterRef: `${prefix}/after` };
}

export async function releaseCheckpoints(
  gitForRepository: (repository: GitRepository) => GitRunner,
  checkpoints: readonly GitCheckpoint[],
): Promise<boolean> {
  return releaseRefs(
    gitForRepository,
    checkpoints.flatMap((checkpoint) => [
      {
        repository: checkpoint.repository,
        ref: checkpoint.beforeRef,
        expectedHash: checkpoint.beforeHash,
      },
      {
        repository: checkpoint.repository,
        ref: checkpoint.afterRef,
        expectedHash: checkpoint.afterHash,
      },
    ]),
  );
}

export function releaseCheckpoint(git: GitRunner, checkpoint: GitCheckpoint): Promise<boolean> {
  return releaseCheckpoints(() => git, [checkpoint]);
}

/** `keepIndex`: hand the run's index lease back to the idle pool instead of
 *  deleting it. Only for a run that finished with the lease consistent (its
 *  index matches a real worktree read), e.g. a before-snapshot discarded for
 *  timing reasons; the next reuse re-reads the worktree and checks the baseline. */
export async function releasePendingCheckpoint(
  git: GitRunner,
  pending: Pick<
    PendingGitCheckpoint,
    "repository" | "beforeHash" | "beforeRef" | "snapshotIndexLease"
  >,
  pool: IndexLeasePool,
  keepIndex = false,
): Promise<boolean> {
  await markGcPending(pending.repository.storeDir);
  const [releasedRef, releasedLease] = await Promise.all([
    deleteRefsBatched(git, [{ ref: pending.beforeRef, expectedHash: pending.beforeHash }], {
      env: storeEnv(pending.repository),
      onSingleFailure: ({ ref, expectedHash }) =>
        releaseLooseRef(pending.repository, ref, expectedHash),
    }),
    keepIndex
      ? pool.returnLeaseToPool(pending.snapshotIndexLease).then(() => true)
      : pool.releaseSnapshotIndexLease(pending.snapshotIndexLease),
  ]);
  return releasedRef === "ok" && releasedLease;
}

export async function retainCheckpointForResume(
  git: GitRunner,
  sessionId: string,
  checkpoint: GitCheckpoint,
): Promise<GitCheckpoint> {
  const checkpointId = newCheckpointId();
  const prefix = `${historyRefPrefix(checkpointNamespace(sessionId))}${checkpointId}`;
  const beforeRef = `${prefix}/before`;
  const afterRef = `${prefix}/after`;
  const input = [
    `create ${beforeRef} ${checkpoint.beforeHash}`,
    `create ${afterRef} ${checkpoint.afterHash}`,
    `delete ${checkpoint.beforeRef} ${checkpoint.beforeHash}`,
    `delete ${checkpoint.afterRef} ${checkpoint.afterHash}`,
  ].join("\n");
  const retained = await invoke(git, ["update-ref", "--stdin"], {
    env: storeEnv(checkpoint.repository),
    stdin: `${input}\n`,
  });
  if (retained.code !== 0) return checkpoint;
  return { ...checkpoint, beforeRef, afterRef };
}
