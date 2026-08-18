import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { blobStoreRootDirectory } from "./blob-store/index.js";
import type { BlobStore } from "./blob-store/index.js";
import { checkpointNamespace } from "./checkpoints.js";
import { effectiveLeaf, entryExists } from "./session-tree-utils.js";
import type {
  BlobCheckpoint,
  ExpirationTombstone,
  FileCheckpointUnavailableReason,
  HistoryLoadResult,
  NavigationState,
  SessionReader,
  TurnCheckpoint,
} from "./types.js";

const HISTORY_SCHEMA_CURRENT = 2;
const ACCEPTED_SCHEMAS = new Set([1, 2]);
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/;
const REASONS: Record<FileCheckpointUnavailableReason, true> = {
  git_unavailable: true,
  not_repository: true,
  repository_unresolvable: true,
  invalid_head: true,
  before_snapshot_failed: true,
  before_ref_failed: true,
  after_snapshot_failed: true,
  after_ref_failed: true,
  file_history_gap: true,
  resumed_checkpoint_unavailable: true,
  workspace_unresolvable: true,
  before_blob_failed: true,
  after_blob_failed: true,
  blob_apply_failed: true,
  history_expired: true,
};

type StoredHistory = {
  schemaVersion: number;
  sessionHash: string;
  workspaceRoot: string;
  checkpoints: TurnCheckpoint[];
  currentIndex: number;
  lastAccessedAt?: string;
};

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSession(value: unknown): value is Extract<TurnCheckpoint, { kind: "session" }> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "session" &&
    typeof candidate.reason === "string" &&
    candidate.reason in REASONS &&
    isNullableString(candidate.parentLeafId) &&
    isNullableString(candidate.leafId)
  );
}

function isBlob(value: unknown): value is BlobCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "blob" &&
    typeof candidate.workspaceRoot === "string" &&
    HASH.test(candidate.sessionHash as string) &&
    typeof candidate.checkpointId === "string" &&
    candidate.checkpointId.length > 0 &&
    HASH.test(candidate.beforeTreeId as string) &&
    HASH.test(candidate.afterTreeId as string) &&
    isNullableString(candidate.parentLeafId) &&
    isNullableString(candidate.leafId)
  );
}

export function blobHistoryPath(sessionId: string, root = blobStoreRootDirectory()): string {
  return join(root, "history", `${checkpointNamespace(sessionId)}.json`);
}

export function blobTombstonePath(
  sessionIdOrHash: string,
  root = blobStoreRootDirectory(),
): string {
  const sessionHash = HASH.test(sessionIdOrHash)
    ? sessionIdOrHash
    : checkpointNamespace(sessionIdOrHash);
  return join(root, "history", `${sessionHash}.expired.json`);
}

async function readTombstone(
  tombstoneFilePath: string,
  sessionHash: string,
): Promise<ExpirationTombstone | null> {
  try {
    const content = await readFile(tombstoneFilePath, "utf8");
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      candidate.expired === true &&
      candidate.sessionHash === sessionHash &&
      typeof candidate.expiredAt === "string" &&
      (candidate.reason === "age" || candidate.reason === "storage_cap")
    ) {
      return {
        expired: true,
        sessionHash,
        expiredAt: candidate.expiredAt,
        reason: candidate.reason,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export class BlobHistoryStore {
  readonly sessionHash: string;
  private readonly path: string;
  private readonly workspaceRoot: string;

  constructor(
    private readonly sessionId: string,
    workspaceRoot: string,
    private readonly store: BlobStore,
  ) {
    this.sessionHash = checkpointNamespace(sessionId);
    this.workspaceRoot = workspaceRoot;
    this.path = blobHistoryPath(sessionId, store.rootDirectory);
  }

  private async canonicalWorkspace(): Promise<string | null> {
    try {
      return await realpath(this.workspaceRoot);
    } catch {
      return null;
    }
  }

  async load(reader: SessionReader): Promise<HistoryLoadResult> {
    const tombstoneFile = blobTombstonePath(this.sessionId, this.store.rootDirectory);
    const tombstone = await readTombstone(tombstoneFile, this.sessionHash);
    if (tombstone) {
      return { status: "expired", reason: tombstone.reason };
    }

    const workspace = await this.canonicalWorkspace();
    if (!workspace) return { status: "unavailable" };
    try {
      const metadata = await stat(this.path);
      if (!metadata.isFile() || metadata.size > MAX_HISTORY_BYTES) return { status: "unavailable" };
      const value = JSON.parse(await readFile(this.path, "utf8")) as unknown;
      if (!value || typeof value !== "object") return { status: "unavailable" };
      const candidate = value as Record<string, unknown>;
      if (
        typeof candidate.schemaVersion !== "number" ||
        !ACCEPTED_SCHEMAS.has(candidate.schemaVersion) ||
        candidate.sessionHash !== this.sessionHash ||
        candidate.workspaceRoot !== workspace ||
        !Array.isArray(candidate.checkpoints) ||
        !Number.isInteger(candidate.currentIndex)
      )
        return { status: "unavailable" };
      if (
        !candidate.checkpoints.every((checkpoint) => isSession(checkpoint) || isBlob(checkpoint))
      ) {
        return { status: "unavailable" };
      }
      const checkpoints: TurnCheckpoint[] = [];
      const usableTrees = new Map<string, boolean>();
      const treeUsable = async (treeId: string): Promise<boolean> => {
        const cached = usableTrees.get(treeId);
        if (cached !== undefined) return cached;
        const usable = await this.store.treeUsable(treeId);
        usableTrees.set(treeId, usable);
        return usable;
      };
      for (const checkpoint of candidate.checkpoints as TurnCheckpoint[]) {
        if (checkpoint.kind === "session") {
          checkpoints.push(checkpoint);
          continue;
        }
        if (checkpoint.kind !== "blob") {
          checkpoints.push({
            kind: "session",
            reason: "resumed_checkpoint_unavailable",
            parentLeafId: checkpoint.parentLeafId,
            leafId: checkpoint.leafId,
          });
          continue;
        }
        const valid =
          checkpoint.workspaceRoot === workspace &&
          checkpoint.sessionHash === this.sessionHash &&
          (await this.store.refMatches(
            this.sessionHash,
            checkpoint.checkpointId,
            "before",
            checkpoint.beforeTreeId,
          )) &&
          (await this.store.refMatches(
            this.sessionHash,
            checkpoint.checkpointId,
            "after",
            checkpoint.afterTreeId,
          )) &&
          (await treeUsable(checkpoint.beforeTreeId)) &&
          (await treeUsable(checkpoint.afterTreeId));
        checkpoints.push(
          valid
            ? checkpoint
            : {
                kind: "session",
                reason: "resumed_checkpoint_unavailable",
                parentLeafId: checkpoint.parentLeafId,
                leafId: checkpoint.leafId,
              },
        );
      }
      const currentIndex = candidate.currentIndex as number;
      if (currentIndex < -1 || currentIndex >= checkpoints.length) return { status: "unavailable" };
      const state = { checkpoints, currentIndex };
      if (
        checkpoints.some(
          (checkpoint) =>
            !entryExists(reader, checkpoint.parentLeafId) ||
            !entryExists(reader, checkpoint.leafId),
        )
      )
        return { status: "unavailable" };

      if (checkpoints.length === 0 && effectiveLeaf(reader) !== null) {
        return { status: "unavailable" };
      }

      await this.save(state).catch(() => undefined);
      return { status: "loaded", state };
    } catch {
      return { status: "unavailable" };
    }
  }

  async save(state: NavigationState): Promise<void> {
    const directory = dirname(this.path);
    if (state.checkpoints.length === 0) {
      await rm(this.path, { force: true }).catch(() => undefined);
      return;
    }
    const workspace = await this.canonicalWorkspace();
    if (!workspace) return;
    const checkpoints = state.checkpoints.map((checkpoint): TurnCheckpoint => {
      if (checkpoint.kind === "session") return checkpoint;
      if (
        checkpoint.kind === "blob" &&
        checkpoint.workspaceRoot === workspace &&
        checkpoint.sessionHash === this.sessionHash
      )
        return checkpoint;
      return {
        kind: "session",
        reason: "resumed_checkpoint_unavailable",
        parentLeafId: checkpoint.parentLeafId,
        leafId: checkpoint.leafId,
      };
    });
    const stored: StoredHistory = {
      schemaVersion: HISTORY_SCHEMA_CURRENT,
      sessionHash: this.sessionHash,
      workspaceRoot: workspace,
      checkpoints,
      currentIndex: state.currentIndex,
      lastAccessedAt: new Date().toISOString(),
    };
    const temporary = join(directory, `.${this.sessionHash}.${randomUUID()}.tmp`);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}
