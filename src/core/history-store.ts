import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { checkpointNamespace, HISTORY_REF_ROOT, historyRefPrefix } from "./checkpoints.js";
import { parseRefLines } from "./git-refs.js";
import {
  pruneStaleHeartbeats,
  sessionHeartbeatIsFresh,
  touchSessionHeartbeat,
} from "./history-liveness.js";
import { pruneExpiredTombstones } from "./prune-tombstones.js";
import type {
  ExpirationTombstone,
  GitCheckpoint,
  GitRepository,
  GitRunner,
  HistoryLoadResult,
  NavigationState,
  SessionEntryLike,
  SessionReader,
  SessionOnlyCheckpoint,
  TurnCheckpoint,
} from "./types.js";
import { UNAVAILABLE_REASONS } from "./types.js";

function entryExists(reader: SessionReader, id: string | null): boolean {
  return id === null || reader.getEntry(id) !== undefined;
}

function isSessionExitEntry(entry: SessionEntryLike | undefined): boolean {
  return entry?.type === "custom" && entry.customType === "session_exit";
}

function effectiveLeaf(reader: SessionReader): string | null {
  let leafId = reader.getLeafId();
  const visited = new Set<string>();
  while (leafId && !visited.has(leafId)) {
    visited.add(leafId);
    const entry = reader.getEntry(leafId);
    if (!isSessionExitEntry(entry)) return leafId;
    leafId = entry?.parentId ?? null;
  }
  return leafId;
}

const HISTORY_SCHEMA_CURRENT = 3;
const ACCEPTED_SCHEMAS = new Set([1, 2, 3]);
/** Schemas before this stored a full `repository` in every git checkpoint. */
const FIRST_SCHEMA_WITHOUT_CHECKPOINT_REPOSITORY = 3;
/** `load()` rejects larger files, so `save()` must never write one. */
const MAX_HISTORY_BYTES = 4 * 1024 * 1024;
const GIT_OBJECT_ID = /^[0-9a-f]{40,64}$/;
const HASH = /^[0-9a-f]{64}$/;

/** Write JSON so readers never see a partial document. */
async function writeJsonAtomic(directory: string, path: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    path,
    join(directory, `.${basename(path)}.${randomUUID()}.tmp`),
    JSON.stringify(value),
  );
}

/** A git checkpoint as stored: the repository is the live one, never persisted per row. */
type StoredGitCheckpoint = Omit<GitCheckpoint, "repository">;
type StoredCheckpoint = SessionOnlyCheckpoint | StoredGitCheckpoint;
/** A git row as read from disk: schema 1 and 2 rows still carry their own repository. */
type ReadGitCheckpoint = StoredGitCheckpoint & { repository?: GitRepository };

type StoredHistory = {
  schemaVersion: number;
  sessionHash: string;
  repository: GitRepository;
  checkpoints: StoredCheckpoint[];
  currentIndex: number;
  lastAccessedAt?: string;
};

function unavailableCheckpoint(checkpoint: StoredCheckpoint): SessionOnlyCheckpoint {
  return {
    kind: "session",
    reason: "resumed_checkpoint_unavailable",
    parentLeafId: checkpoint.parentLeafId,
    leafId: checkpoint.leafId,
  };
}

function storedGitCheckpoint(checkpoint: StoredGitCheckpoint): StoredGitCheckpoint {
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
function boundedHistory(stored: StoredHistory): StoredHistory {
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

export function historyDirectory(repository: GitRepository): string {
  return join(repository.storeDir, "omp-undo-redo", "history");
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
      candidate.reason === "age"
    ) {
      return {
        expired: true,
        sessionHash,
        expiredAt: candidate.expiredAt,
        reason: "age",
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
    (UNAVAILABLE_REASONS as readonly string[]).includes(candidate.reason) &&
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
      if (checkpoint.kind === "session") return checkpoint;
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

async function existingRefs(
  git: GitRunner,
  repository: GitRepository,
  prefix: string,
): Promise<Map<string, string> | null> {
  try {
    const result = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", prefix], {
      env: { GIT_DIR: repository.storeDir },
    });
    if (result.code !== 0 || result.error) return null;
    const refs = parseRefLines(result.stdout);
    return refs && new Map(refs.map(({ ref, expectedHash }) => [ref, expectedHash]));
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

type HistoryRef = { ref: string; expectedHash: string; committedAtMs: number | null };

/** One listing of every session's history refs, grouped by session hash.
 *  `committedAtMs` is the snapshot commit's date (null when unknown, which
 *  callers treat as "recent"; `creatordate:raw` is empty for a missing or
 *  non-commit object, so such a session is kept, never swept). Null result:
 *  the listing is unusable, so the caller must touch nothing — a malformed
 *  listing is never "no refs", and an object id that is not a full hex id
 *  must never reach `update-ref`, where an omitted old value deletes
 *  unconditionally. */
async function listHistoryRefs(
  git: GitRunner,
  repository: GitRepository,
): Promise<Map<string, HistoryRef[]> | null> {
  try {
    const result = await git(
      [
        "for-each-ref",
        "--format=%(refname)%00%(objectname)%00%(creatordate:raw)",
        HISTORY_REF_ROOT,
      ],
      { env: { GIT_DIR: repository.storeDir } },
    );
    if (result.code !== 0 || result.error) return null;
    const bySession = new Map<string, HistoryRef[]>();
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line) continue;
      const fields = line.split("\0");
      if (fields.length < 2 || fields.length > 3) return null;
      const [ref, expectedHash, date = ""] = fields;
      if (!GIT_OBJECT_ID.test(expectedHash)) return null;
      if (!ref.startsWith(HISTORY_REF_ROOT)) continue;
      const sessionHash = ref.slice(HISTORY_REF_ROOT.length).split("/", 1)[0];
      if (!HASH.test(sessionHash)) continue;
      const seconds = Number.parseInt(date, 10);
      const entry = {
        ref,
        expectedHash,
        committedAtMs: Number.isNaN(seconds) ? null : seconds * 1000,
      };
      const list = bySession.get(sessionHash);
      if (list) list.push(entry);
      else bySession.set(sessionHash, [entry]);
    }
    return bySession;
  } catch {
    return null;
  }
}

async function deleteHistoryRefs(
  git: GitRunner,
  repository: GitRepository,
  refs: readonly HistoryRef[],
): Promise<boolean> {
  try {
    const commands = refs.map(({ ref, expectedHash }) => `delete ${ref} ${expectedHash}`);
    const result = await git(["update-ref", "--stdin"], {
      env: { GIT_DIR: repository.storeDir },
      stdin: `${commands.join("\n")}\n`,
    });
    return result.code === 0 && !result.error;
  } catch {
    return false;
  }
}

/** Expires dormant session histories. Returns how many sessions had refs
 *  deleted, so callers can reclaim the now-unreachable objects. */
export async function expireGitSessionHistories(
  repository: GitRepository,
  git: GitRunner,
  retentionDays: number,
  activeSessionHashes: ReadonlySet<string> | (() => ReadonlySet<string>),
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const dir = historyDirectory(repository);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    // No history directory: refs may still exist with no JSON (crash residue).
    files = [];
  }
  const refsBySession = await listHistoryRefs(git, repository);
  const jsonHashes = new Set<string>();
  let refsRemoved = 0;
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const getActive = () =>
    typeof activeSessionHashes === "function" ? activeSessionHashes() : activeSessionHashes;
  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".expired.json") || file.startsWith(".")) continue;
    const sessionHash = file.slice(0, -5);
    if (!HASH.test(sessionHash)) continue;
    jsonHashes.add(sessionHash);
    const filePath = join(dir, file);

    // A tombstoned history JSON is residue from a concurrent load rewriting
    // the file mid-sweep (or a load racing the rm). The marker stays
    // authoritative until a live owner saves anew — which clears it — so the
    // JSON must go regardless of its timestamp, unless a live owner exists:
    // save() beats the heartbeat, then clears the tombstone, then rewrites
    // the JSON, so a fresh heartbeat or the tombstone vanishing means the
    // JSON is new live state and must survive.
    const existingTombstone = tombstonePath(repository, sessionHash);
    const tombstoned = await stat(existingTombstone)
      .then(() => true)
      .catch(() => false);
    if (tombstoned) {
      if (getActive().has(sessionHash)) continue;
      if (await sessionHeartbeatIsFresh(dir, sessionHash)) continue;
      const stillTombstoned = await stat(existingTombstone)
        .then(() => true)
        .catch(() => false);
      if (stillTombstoned) await rm(filePath, { force: true }).catch(() => undefined);
      continue;
    }

    if (getActive().has(sessionHash)) continue;
    // Cross-process liveness: another process may hold this session open
    // without this process knowing. A fresh heartbeat protects it here.
    if (await sessionHeartbeatIsFresh(dir, sessionHash)) continue;

    // Unparseable, non-object, or undated metadata ages by file mtime so a
    // corrupt file cannot pin its refs forever. A stat failure keeps the session.
    let lastAccessedAtMs = Number.NaN;
    try {
      const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
      const accessedAt =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>).lastAccessedAt
          : undefined;
      if (typeof accessedAt === "string") lastAccessedAtMs = Date.parse(accessedAt);
    } catch {
      // fall through to mtime
    }
    if (Number.isNaN(lastAccessedAtMs)) {
      try {
        lastAccessedAtMs = (await stat(filePath)).mtimeMs;
      } catch {
        continue;
      }
    }

    if (lastAccessedAtMs > cutoff) continue;

    // Re-check active set right before deletion to prevent racing concurrent session startup
    if (getActive().has(sessionHash)) continue;
    // And re-check the cross-process heartbeat, which a concurrent resume in
    // another process may have touched while the timestamp was being read.
    if (await sessionHeartbeatIsFresh(dir, sessionHash)) continue;

    // Unusable listing: leave the session for a later sweep.
    if (refsBySession === null) continue;
    const sessionRefs = refsBySession.get(sessionHash) ?? [];
    if (sessionRefs.length > 0) {
      if (!(await deleteHistoryRefs(git, repository, sessionRefs))) continue;
      refsRemoved += 1;
    }

    // Write tombstone first, then delete history JSON
    const tombstoneFile = tombstonePath(repository, sessionHash);
    const tombstoneData: ExpirationTombstone = {
      expired: true,
      sessionHash,
      expiredAt: new Date().toISOString(),
      reason: "age",
    };
    // tombstone write failure is non-fatal
    await writeJsonAtomic(dir, tombstoneFile, tombstoneData).catch(() => undefined);

    await rm(filePath, { force: true }).catch(() => undefined);
  }

  // Refs with no history JSON at all (crash, failed save): the loop above
  // never sees them. They go once every one is older than the retention
  // window — a fresh set may belong to a first save still in flight — and no
  // live owner holds the session. Expected hashes make a concurrent ref
  // update fail the batch instead of losing the new ref.
  if (refsBySession) {
    for (const [sessionHash, refs] of refsBySession) {
      if (jsonHashes.has(sessionHash) || getActive().has(sessionHash)) continue;
      if (refs.some(({ committedAtMs }) => committedAtMs === null || committedAtMs > cutoff))
        continue;
      if (await sessionHeartbeatIsFresh(dir, sessionHash)) continue;
      const jsonAppeared = await stat(join(dir, `${sessionHash}.json`))
        .then(() => true)
        .catch(() => false);
      if (jsonAppeared || getActive().has(sessionHash)) continue;
      if (await deleteHistoryRefs(git, repository, refs)) refsRemoved += 1;
    }
  }

  await pruneExpiredTombstones(
    dir,
    retentionDays,
    getActive,
    (v) => HASH.test(v),
    (hash) => sessionHeartbeatIsFresh(dir, hash),
  );
  await pruneStaleHeartbeats(dir);
  return refsRemoved;
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
      return { status: "expired" };
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
      const parsed = parseHistory(value, this.sessionId, this.repository);
      if (!parsed) return { status: "unavailable", reason: "unusable" };
      const refPrefix = historyRefPrefix(parsed.sessionHash);
      const refs = await existingRefs(this.git, this.repository, refPrefix);
      if (refs === null) return { status: "unavailable", reason: "unusable" };
      const checkpoints = parsed.checkpoints.map((checkpoint): TurnCheckpoint => {
        if (checkpoint.kind === "session") return checkpoint;
        if (
          refs.get(checkpoint.beforeRef) === checkpoint.beforeHash &&
          refs.get(checkpoint.afterRef) === checkpoint.afterHash
        )
          return { ...checkpoint, repository: this.repository };
        return unavailableCheckpoint(checkpoint);
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
      await this.refreshStoredTimestamp(parsed).catch(() => undefined);
      return { status: "loaded", state };
    } catch {
      return { status: "unavailable", reason: "unusable" };
    }
  }

  /** Rewrites the stored document with the original (unmapped) checkpoints
   *  and a fresh lastAccessedAt, preserving schema migration. Skips the write
   *  when a tombstone appeared mid-load so a completed expiration is never
   *  resurrected. */
  private async refreshStoredTimestamp(parsed: StoredHistory): Promise<void> {
    const tombstoneFile = tombstonePath(this.repository, this.sessionId);
    const claimed = await stat(tombstoneFile)
      .then(() => true)
      .catch(() => false);
    if (claimed) return;
    await this.write(parsed.checkpoints, parsed.currentIndex);
  }

  private async write(checkpoints: StoredCheckpoint[], currentIndex: number): Promise<void> {
    const stored = boundedHistory({
      schemaVersion: HISTORY_SCHEMA_CURRENT,
      sessionHash: checkpointNamespace(this.sessionId),
      repository: this.repository,
      checkpoints,
      currentIndex,
      lastAccessedAt: new Date().toISOString(),
    });
    await writeJsonAtomic(
      historyDirectory(this.repository),
      historyPath(this.repository, this.sessionId),
      stored,
    );
  }

  async save(state: NavigationState): Promise<void> {
    const directory = historyDirectory(this.repository);
    const path = historyPath(this.repository, this.sessionId);
    if (state.checkpoints.length === 0) {
      await rm(path, { force: true }).catch(() => undefined);
      return;
    }
    const sessionHash = checkpointNamespace(this.sessionId);
    const refPrefix = historyRefPrefix(sessionHash);
    const checkpoints = state.checkpoints.map((checkpoint): StoredCheckpoint => {
      if (checkpoint.kind === "session") return checkpoint;
      const stored = storedGitCheckpoint(checkpoint);
      return checkpoint.beforeRef.startsWith(refPrefix) &&
        sameRepository(checkpoint.repository, this.repository)
        ? stored
        : unavailableCheckpoint(stored);
    });
    // A live owner saving new history supersedes any earlier expiration
    // marker. Order matters against a concurrent sweep: beat the heartbeat
    // first (sweeps skip fresh sessions), clear the tombstone next, and write
    // the JSON last — so a sweep that saw the tombstone can never delete JSON
    // written after this point, and a cleared marker never precedes a write
    // the sweep could still undo.
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await touchSessionHeartbeat(directory, sessionHash);
    await rm(tombstonePath(this.repository, this.sessionId), { force: true }).catch(
      () => undefined,
    );
    await this.write(checkpoints, state.currentIndex);
  }
}
