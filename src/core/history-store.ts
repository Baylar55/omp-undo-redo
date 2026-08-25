import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkpointNamespace } from "./checkpoints.js";
import {
  pruneStaleHeartbeats,
  sessionHeartbeatIsFresh,
  touchSessionHeartbeat,
} from "./history-liveness.js";
import { pruneExpiredTombstones } from "./prune-tombstones.js";
import type {
  ExpirationTombstone,
  FileCheckpointUnavailableReason,
  GitCheckpoint,
  GitRepository,
  GitRunner,
  HistoryLoadResult,
  NavigationState,
  SessionReader,
  TurnCheckpoint,
} from "./types.js";
import { effectiveLeaf, entryExists, isSessionExitEntry } from "./session-tree-utils.js";
export { effectiveLeaf, entryExists, isSessionExitEntry } from "./session-tree-utils.js";

const HISTORY_SCHEMA_CURRENT = 2;
const ACCEPTED_SCHEMAS = new Set([1, 2]);
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const HASH = /^[0-9a-f]{64}$/;
const UNAVAILABLE_REASONS: Record<FileCheckpointUnavailableReason, true> = {
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
  repository: GitRepository;
  checkpoints: TurnCheckpoint[];
  currentIndex: number;
  lastAccessedAt?: string;
};

export function historyDirectory(repository: GitRepository): string {
  return join(repository.commonDir, "omp-undo-redo", "history");
}

export function historyPath(repository: GitRepository, sessionId: string): string {
  return join(historyDirectory(repository), `${checkpointNamespace(sessionId)}.json`);
}

export function tombstonePath(repository: GitRepository, sessionIdOrHash: string): string {
  const sessionHash = HASH.test(sessionIdOrHash)
    ? sessionIdOrHash
    : checkpointNamespace(sessionIdOrHash);
  return join(historyDirectory(repository), `${sessionHash}.expired.json`);
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

function isSessionCheckpoint(value: unknown): value is TurnCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "session" &&
    typeof candidate.reason === "string" &&
    candidate.reason in UNAVAILABLE_REASONS &&
    isNullableString(candidate.parentLeafId) &&
    isNullableString(candidate.leafId)
  );
}

function isGitCheckpoint(value: unknown, refPrefix: string): value is GitCheckpoint {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.kind === "git" &&
    isRepository(candidate.repository) &&
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

function sameRepository(left: GitRepository, right: GitRepository): boolean {
  return (
    left.worktree === right.worktree &&
    left.gitDir === right.gitDir &&
    left.commonDir === right.commonDir
  );
}

function parseHistory(
  value: unknown,
  sessionId: string,
  repository: GitRepository,
): StoredHistory | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const sessionHash = checkpointNamespace(sessionId);
  const refPrefix = `refs/omp-undo-redo/history/${sessionHash}/`;
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
  if (
    !candidate.checkpoints.every(
      (checkpoint) => isSessionCheckpoint(checkpoint) || isGitCheckpoint(checkpoint, refPrefix),
    )
  )
    return null;
  const checkpoints = candidate.checkpoints as TurnCheckpoint[];
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

async function existingRefs(git: GitRunner, prefix: string): Promise<Map<string, string> | null> {
  try {
    const result = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", prefix]);
    if (result.code !== 0 || result.error) return null;
    const refs = new Map<string, string>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const separator = line.indexOf("\0");
      if (separator < 0 || line.indexOf("\0", separator + 1) >= 0) return null;
      refs.set(line.slice(0, separator), line.slice(separator + 1));
    }
    return refs;
  } catch {
    return null;
  }
}

export function reconstructSessionHistory(reader: SessionReader): NavigationState {
  const branch = reader
    .getBranch(reader.getLeafId() ?? undefined)
    .filter((entry) => !isSessionExitEntry(entry));
  const checkpoints: TurnCheckpoint[] = [];
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    let leafIndex = index;
    while (
      leafIndex + 1 < branch.length &&
      !(branch[leafIndex + 1].type === "message" && branch[leafIndex + 1].message?.role === "user")
    ) {
      leafIndex++;
    }
    if (leafIndex === index) continue;
    checkpoints.push({
      kind: "session",
      reason: "resumed_checkpoint_unavailable",
      parentLeafId: entry.id,
      leafId: branch[leafIndex].id,
    });
    index = leafIndex;
  }
  return { checkpoints, currentIndex: checkpoints.length - 1 };
}

export async function expireGitSessionHistories(
  repository: GitRepository,
  git: GitRunner,
  retentionDays: number,
  activeSessionHashes: ReadonlySet<string> | (() => ReadonlySet<string>),
): Promise<void> {
  if (retentionDays <= 0) return;
  const dir = historyDirectory(repository);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const getActive = () =>
    typeof activeSessionHashes === "function" ? activeSessionHashes() : activeSessionHashes;
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".expired.json") || file.startsWith(".")) continue;
    const sessionHash = file.slice(0, -5);
    if (!HASH.test(sessionHash)) continue;
    const filePath = join(dir, file);

    // A tombstoned history JSON is residue from a concurrent load rewriting
    // the file mid-sweep (or a load racing the rm). The marker stays
    // authoritative until a live owner saves anew — which clears it — so the
    // JSON must go regardless of its timestamp. Re-checked immediately before
    // the rm to stay out of a save()'s clear-and-rewrite path.
    const existingTombstone = tombstonePath(repository, sessionHash);
    let tombstoned = false;
    try {
      await stat(existingTombstone);
      tombstoned = true;
    } catch {
      // No marker: normal candidate path.
    }
    if (tombstoned) {
      await rm(filePath, { force: true }).catch(() => undefined);
      continue;
    }

    if (getActive().has(sessionHash)) continue;
    // Cross-process liveness: another process may hold this session open
    // without this process knowing. A fresh heartbeat protects it here.
    if (await sessionHeartbeatIsFresh(dir, sessionHash)) continue;

    let lastAccessedAtMs: number;
    try {
      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const candidate = parsed as Record<string, unknown>;
      if (typeof candidate.lastAccessedAt === "string") {
        lastAccessedAtMs = Date.parse(candidate.lastAccessedAt);
        if (Number.isNaN(lastAccessedAtMs)) continue;
      } else {
        const metadata = await stat(filePath);
        lastAccessedAtMs = metadata.mtimeMs;
      }
    } catch {
      continue;
    }

    if (lastAccessedAtMs > cutoff) continue;

    // Re-check active set right before deletion to prevent racing concurrent session startup
    if (getActive().has(sessionHash)) continue;
    // And re-check the cross-process heartbeat, which a concurrent resume in
    // another process may have touched while the timestamp was being read.
    if (await sessionHeartbeatIsFresh(dir, sessionHash)) continue;

    const refPrefix = `refs/omp-undo-redo/history/${sessionHash}/`;
    const refsMap = await existingRefs(git, refPrefix);
    if (refsMap === null) continue;

    if (refsMap.size > 0) {
      const deleteCommands = Array.from(refsMap.entries())
        .map(([ref, hash]) => `delete ${ref} ${hash}`)
        .join("\n");
      try {
        const updateResult = await git(["update-ref", "--stdin"], {
          stdin: `${deleteCommands}\n`,
        });
        if (updateResult.code !== 0 || updateResult.error) continue;
      } catch {
        continue;
      }
    }

    // Write tombstone first, then delete history JSON
    const tombstoneFile = tombstonePath(repository, sessionHash);
    const tombstoneData: ExpirationTombstone = {
      expired: true,
      sessionHash,
      expiredAt: new Date().toISOString(),
      reason: "age",
    };
    const temporary = join(dir, `.${sessionHash}.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(tombstoneData), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, tombstoneFile);
    } catch {
      // tombstone write failure is non-fatal
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }

    await rm(filePath, { force: true }).catch(() => undefined);
  }

  await pruneExpiredTombstones(
    dir,
    retentionDays,
    getActive,
    (v) => HASH.test(v),
    (hash) => sessionHeartbeatIsFresh(dir, hash),
  );
  await pruneStaleHeartbeats(dir);
}

export class SessionHistoryStore {
  constructor(
    private readonly sessionId: string,
    private readonly repository: GitRepository,
    private readonly git: GitRunner,
  ) {}

  async load(reader: SessionReader): Promise<HistoryLoadResult> {
    const sessionHash = checkpointNamespace(this.sessionId);
    const dir = historyDirectory(this.repository);
    const tombstoneFile = tombstonePath(this.repository, this.sessionId);
    const tombstone = await readTombstone(tombstoneFile, sessionHash);
    if (tombstone) {
      return { status: "expired", reason: tombstone.reason };
    }

    const path = historyPath(this.repository, this.sessionId);
    const present = await stat(path)
      .then(() => true)
      .catch(() => false);
    if (!present) return { status: "unavailable", reason: "missing" };
    await touchSessionHeartbeat(dir, sessionHash);
    try {
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_HISTORY_BYTES) {
        return { status: "unavailable", reason: "unusable" };
      }
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const candidate = value as Record<string, unknown>;
      const parsed = parseHistory(value, this.sessionId, this.repository);
      if (!parsed) return { status: "unavailable", reason: "unusable" };
      const refPrefix = `refs/omp-undo-redo/history/${parsed.sessionHash}/`;
      const refs = await existingRefs(this.git, refPrefix);
      if (refs === null) return { status: "unavailable", reason: "unusable" };
      const checkpoints = parsed.checkpoints.map((checkpoint): TurnCheckpoint => {
        if (checkpoint.kind === "session") return checkpoint;
        if (checkpoint.kind !== "git")
          return {
            kind: "session",
            reason: "resumed_checkpoint_unavailable",
            parentLeafId: checkpoint.parentLeafId,
            leafId: checkpoint.leafId,
          };
        if (
          refs.get(checkpoint.beforeRef) === checkpoint.beforeHash &&
          refs.get(checkpoint.afterRef) === checkpoint.afterHash &&
          sameRepository(checkpoint.repository, this.repository)
        )
          return checkpoint;
        return {
          kind: "session",
          reason: "resumed_checkpoint_unavailable",
          parentLeafId: checkpoint.parentLeafId,
          leafId: checkpoint.leafId,
        };
      });
      const state = { checkpoints, currentIndex: parsed.currentIndex };
      if (
        checkpoints.some(
          (checkpoint) =>
            !entryExists(reader, checkpoint.parentLeafId) ||
            !entryExists(reader, checkpoint.leafId),
        )
      )
        return { status: "unavailable", reason: "unusable" };

      if (checkpoints.length === 0 && effectiveLeaf(reader) !== null) {
        return { status: "unavailable", reason: "unusable" };
      }

      // Refresh lastAccessedAt without persisting the runtime-mapped
      // checkpoints: a concurrent expiration that deleted refs mid-load would
      // otherwise be written back as permanent session-only rows, destroying
      // recoverable git coordinates. The mapping is re-derived on every load.
      await this.refreshStoredTimestamp(candidate).catch(() => undefined);
      return { status: "loaded", state };
    } catch {
      return { status: "unavailable", reason: "unusable" };
    }
  }

  /** Rewrites the stored document with the original (unmapped) checkpoints
   *  and a fresh lastAccessedAt, preserving schema migration. Skips the write
   *  when a tombstone appeared mid-load so a completed expiration is never
   *  resurrected. */
  private async refreshStoredTimestamp(candidate: Record<string, unknown>): Promise<void> {
    const tombstoneFile = tombstonePath(this.repository, this.sessionId);
    const claimed = await stat(tombstoneFile)
      .then(() => true)
      .catch(() => false);
    if (claimed) return;
    const directory = historyDirectory(this.repository);
    const stored: StoredHistory = {
      schemaVersion: HISTORY_SCHEMA_CURRENT,
      sessionHash: checkpointNamespace(this.sessionId),
      repository: this.repository,
      checkpoints: candidate.checkpoints as TurnCheckpoint[],
      currentIndex: candidate.currentIndex as number,
      lastAccessedAt: new Date().toISOString(),
    };
    const temporary = join(
      directory,
      `.${checkpointNamespace(this.sessionId)}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, historyPath(this.repository, this.sessionId));
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async save(state: NavigationState): Promise<void> {
    const directory = historyDirectory(this.repository);
    const path = historyPath(this.repository, this.sessionId);
    if (state.checkpoints.length === 0) {
      await rm(path, { force: true }).catch(() => undefined);
      return;
    }
    const sessionHash = checkpointNamespace(this.sessionId);
    const refPrefix = `refs/omp-undo-redo/history/${sessionHash}/`;
    const checkpoints = state.checkpoints.map((checkpoint): TurnCheckpoint => {
      if (
        checkpoint.kind === "session" ||
        (checkpoint.kind === "git" &&
          checkpoint.beforeRef.startsWith(refPrefix) &&
          sameRepository(checkpoint.repository, this.repository))
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
      sessionHash,
      repository: this.repository,
      checkpoints,
      currentIndex: state.currentIndex,
      lastAccessedAt: new Date().toISOString(),
    };
    const temporary = join(
      directory,
      `.${checkpointNamespace(this.sessionId)}.${randomUUID()}.tmp`,
    );
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    // A live owner saving new history supersedes any earlier expiration
    // marker, so clear it — otherwise every future resume would discard the
    // freshly saved checkpoints until the marker aged out of the tombstone
    // prune window.
    await rm(tombstonePath(this.repository, this.sessionId), { force: true }).catch(
      () => undefined,
    );
    await touchSessionHeartbeat(directory, sessionHash);
  }
}
