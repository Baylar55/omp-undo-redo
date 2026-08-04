import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { BlobApplyResult, BlobStore } from "./blob-store.js";
import type {
  BlobCheckpoint,
  FileCheckpointUnavailableReason,
  PendingBlobCheckpoint,
} from "./types.js";

export type PrepareBlobResult =
  | { status: "blob"; checkpoint: PendingBlobCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

export type FinishBlobResult =
  | { status: "blob"; checkpoint: BlobCheckpoint }
  | { status: "session_only"; reason: FileCheckpointUnavailableReason };

export async function prepareBeforeTurnBlob(
  store: BlobStore,
  workspaceRoot: string,
  sessionHash: string,
): Promise<PrepareBlobResult> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(workspaceRoot);
  } catch {
    return { status: "session_only", reason: "workspace_unresolvable" };
  }
  const checkpointId = randomUUID();
  const snapshot = await store.captureSnapshot(canonicalRoot, sessionHash, checkpointId, "before");
  if ("reason" in snapshot) {
    return {
      status: "session_only",
      reason:
        snapshot.reason === "workspace_unresolvable"
          ? "workspace_unresolvable"
          : "before_blob_failed",
    };
  }
  return {
    status: "blob",
    checkpoint: {
      kind: "blob",
      workspaceRoot: canonicalRoot,
      sessionHash,
      checkpointId,
      beforeTreeId: snapshot.treeId,
      parentLeafId: null,
    },
  };
}

export async function finishAfterTurnBlob(
  store: BlobStore,
  before: PendingBlobCheckpoint,
  parentLeafId: string | null,
  leafId: string | null,
): Promise<FinishBlobResult> {
  const snapshot = await store.captureSnapshot(
    before.workspaceRoot,
    before.sessionHash,
    before.checkpointId,
    "after",
  );
  if ("reason" in snapshot) {
    await releaseBlobPendingCheckpoint(store, before);
    return {
      status: "session_only",
      reason:
        snapshot.reason === "workspace_unresolvable"
          ? "workspace_unresolvable"
          : "after_blob_failed",
    };
  }
  return {
    status: "blob",
    checkpoint: {
      kind: "blob",
      workspaceRoot: before.workspaceRoot,
      sessionHash: before.sessionHash,
      checkpointId: before.checkpointId,
      beforeTreeId: before.beforeTreeId,
      afterTreeId: snapshot.treeId,
      parentLeafId,
      leafId,
    },
  };
}

export async function applyBlobCheckpoint(
  store: BlobStore,
  workspaceRoot: string,
  sessionHash: string,
  sourceTreeId: string,
  targetTreeId: string,
): Promise<BlobApplyResult> {
  return store.applySnapshot(workspaceRoot, sessionHash, sourceTreeId, targetTreeId);
}

export async function releaseBlobCheckpoint(
  store: BlobStore,
  checkpoint: Pick<BlobCheckpoint, "sessionHash" | "checkpointId">,
): Promise<boolean> {
  return store.releaseCheckpointRefs(checkpoint.sessionHash, [checkpoint.checkpointId]);
}

export async function releaseBlobPendingCheckpoint(
  store: BlobStore,
  checkpoint: Pick<PendingBlobCheckpoint, "sessionHash" | "checkpointId">,
): Promise<boolean> {
  return store.releaseCheckpointRefs(checkpoint.sessionHash, [checkpoint.checkpointId]);
}

export async function retainBlobCheckpointForResume(
  store: BlobStore,
  _sessionId: string,
  checkpoint: BlobCheckpoint,
): Promise<BlobCheckpoint | null> {
  return (await store.retainCheckpointForResume(checkpoint.sessionHash, checkpoint.checkpointId))
    ? checkpoint
    : null;
}
