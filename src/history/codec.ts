import type {
  GitCheckpoint,
  GitRepository,
  SessionOnlyCheckpoint,
  RestoreIntent,
  TurnCheckpoint,
} from "../types.js";
import { UNAVAILABLE_REASONS } from "../types.js";
import { checkpointNamespace } from "../infra/paths.js";
import { historyRefPrefix } from "../store/refs.js";

export const HISTORY_SCHEMA_CURRENT = 3;

const ACCEPTED_SCHEMAS = new Set([1, 2, 3]);

/** Schemas before this stored a full `repository` in every git checkpoint. */
const FIRST_SCHEMA_WITHOUT_CHECKPOINT_REPOSITORY = 3;

/** `load()` rejects larger files, so `save()` must never write one. */
export const MAX_HISTORY_BYTES = 4 * 1024 * 1024;

export const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;

export const HASH = /^[0-9a-f]{64}$/;

/** A git checkpoint as stored: the repository is the live one, never persisted per row. */
export type StoredGitCheckpoint = Omit<GitCheckpoint, "repository">;

export type StoredCheckpoint = SessionOnlyCheckpoint | StoredGitCheckpoint;

/** A git row as read from disk: schema 1 and 2 rows still carry their own repository. */
export type ReadGitCheckpoint = StoredGitCheckpoint & { repository?: GitRepository };

export type StoredHistory = {
  schemaVersion: number;
  sessionHash: string;
  repository: GitRepository;
  checkpoints: StoredCheckpoint[];
  currentIndex: number;
  lastAccessedAt?: string;
};

export function unavailableCheckpoint(checkpoint: StoredCheckpoint): SessionOnlyCheckpoint {
  return {
    kind: "session",
    reason: "resumed_checkpoint_unavailable",
    parentLeafId: checkpoint.parentLeafId,
    leafId: checkpoint.leafId,
  };
}

export function storedGitCheckpoint(checkpoint: StoredGitCheckpoint): StoredGitCheckpoint {
  return {
    kind: "git",
    beforeHash: checkpoint.beforeHash,
    afterHash: checkpoint.afterHash,
    beforeRef: checkpoint.beforeRef,
    afterRef: checkpoint.afterRef,
    parentLeafId: checkpoint.parentLeafId,
    leafId: checkpoint.leafId,
  };
}

/** Builds the document `load()` will accept. Over MAX_HISTORY_BYTES it drops
 *  the checkpoints older than the current one first, then the newest redo
 *  entries, and never the checkpoint at `currentIndex`, which the shifted
 *  index keeps naming. At least one checkpoint always stays, so a single row
 *  larger than the cap (megabyte-sized leaf ids) is still written and `load()`
 *  reports it unusable: failing closed beats leaving an older, stale file. */
export function boundedHistory(stored: StoredHistory): StoredHistory {
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
  const sizes = stored.checkpoints.map(bytes);
  // `[a,b]` = brackets (in the empty document) + elements + (n - 1) commas.
  let total =
    bytes({ ...stored, checkpoints: [] }) +
    sizes.reduce((sum, size) => sum + size, 0) +
    Math.max(sizes.length - 1, 0);
  let start = 0;
  let end = sizes.length;
  while (total > MAX_HISTORY_BYTES && end - start > 1) {
    if (start < stored.currentIndex) total -= sizes[start++] + 1;
    else total -= sizes[--end] + 1;
  }
  if (start === 0 && end === sizes.length) return stored;
  return {
    ...stored,
    checkpoints: stored.checkpoints.slice(start, end),
    currentIndex: stored.currentIndex - start,
  };
}

export function isRestoreIntent(value: unknown): value is RestoreIntent {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.direction === "undo" || candidate.direction === "redo") &&
    ["beforeRef", "beforeHash", "afterRef", "afterHash"].every(
      (key) => typeof candidate[key] === "string",
    )
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isRepository(value: unknown): value is GitRepository {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.worktree === "string" &&
    typeof candidate.gitDir === "string" &&
    typeof candidate.commonDir === "string"
  );
}

/** Any string `reason` is accepted: a newer version may record one this
 *  version does not know, which `parseHistory` maps to an unavailable one. */
function isSessionCheckpoint(value: unknown): value is TurnCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "session" &&
    typeof candidate.reason === "string" &&
    isNullableString(candidate.parentLeafId) &&
    isNullableString(candidate.leafId)
  );
}

function isGitCheckpoint(
  value: unknown,
  refPrefix: string,
  legacy: boolean,
): value is ReadGitCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "git" &&
    (!legacy || isRepository(candidate.repository)) &&
    typeof candidate.beforeHash === "string" &&
    GIT_OBJECT_ID.test(candidate.beforeHash) &&
    typeof candidate.afterHash === "string" &&
    GIT_OBJECT_ID.test(candidate.afterHash) &&
    typeof candidate.beforeRef === "string" &&
    candidate.beforeRef.startsWith(refPrefix) &&
    candidate.beforeRef.endsWith("/before") &&
    typeof candidate.afterRef === "string" &&
    candidate.afterRef === candidate.beforeRef.replace(/\/before$/, "/after") &&
    isNullableString(candidate.parentLeafId) &&
    isNullableString(candidate.leafId)
  );
}

export function sameRepository(left: GitRepository, right: GitRepository): boolean {
  return (
    left.worktree === right.worktree &&
    left.gitDir === right.gitDir &&
    left.commonDir === right.commonDir
  );
}

export function parseHistory(
  value: unknown,
  sessionId: string,
  repository: GitRepository,
): StoredHistory | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const sessionHash = checkpointNamespace(sessionId);
  const refPrefix = historyRefPrefix(sessionHash);
  if (
    typeof candidate.schemaVersion !== "number" ||
    !ACCEPTED_SCHEMAS.has(candidate.schemaVersion) ||
    candidate.sessionHash !== sessionHash ||
    !isRepository(candidate.repository) ||
    !sameRepository(candidate.repository, repository) ||
    !Array.isArray(candidate.checkpoints) ||
    !Number.isInteger(candidate.currentIndex)
  )
    return null;
  const legacy = candidate.schemaVersion < FIRST_SCHEMA_WITHOUT_CHECKPOINT_REPOSITORY;
  if (
    !candidate.checkpoints.every(
      (checkpoint) =>
        isSessionCheckpoint(checkpoint) || isGitCheckpoint(checkpoint, refPrefix, legacy),
    )
  )
    return null;
  // Legacy rows carried their own repository; one that is not the live
  // repository can never be restored from this store.
  const checkpoints = (candidate.checkpoints as (SessionOnlyCheckpoint | ReadGitCheckpoint)[]).map(
    (checkpoint): StoredCheckpoint => {
      if (checkpoint.kind === "session") {
        return (UNAVAILABLE_REASONS as readonly string[]).includes(checkpoint.reason)
          ? checkpoint
          : { ...checkpoint, reason: "resumed_checkpoint_unavailable" };
      }
      const stored = storedGitCheckpoint(checkpoint);
      return legacy && !(checkpoint.repository && sameRepository(checkpoint.repository, repository))
        ? unavailableCheckpoint(stored)
        : stored;
    },
  );
  const currentIndex = candidate.currentIndex as number;
  if (currentIndex < -1 || currentIndex >= checkpoints.length) return null;
  const lastAccessedAt =
    typeof candidate.lastAccessedAt === "string" ? candidate.lastAccessedAt : undefined;
  return {
    schemaVersion: candidate.schemaVersion,
    sessionHash,
    repository,
    checkpoints,
    currentIndex,
    lastAccessedAt,
  };
}
