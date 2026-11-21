import { mkdir, readFile, rm, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { writeJsonAtomic } from "../infra/fs.js";
import { invoke } from "../infra/git-runner.js";
import { storeEnv } from "../store/git-store.js";
import { touchSessionHeartbeat } from "./liveness.js";
import { readTombstone } from "./tombstones.js";
import type {
  GitRepository,
  GitRunner,
  HistoryLoadResult,
  NavigationState,
  SessionReader,
  RestoreIntent,
  TurnCheckpoint,
} from "../types.js";
import { checkpointNamespace } from "../infra/paths.js";
import { parseRefLines } from "../infra/git-parse.js";
import { historyRefPrefix } from "../store/refs.js";
import { historyDirectory, tombstonePath, restoreIntentPath, historyPath } from "./layout.js";
import {
  MAX_HISTORY_BYTES,
  parseHistory,
  unavailableCheckpoint,
  boundedHistory,
  HISTORY_SCHEMA_CURRENT,
  storedGitCheckpoint,
  sameRepository,
  isRestoreIntent,
  isUnavailableReason,
} from "./codec.js";
import type { StoredHistory, StoredCheckpoint } from "./codec.js";
import { entryExists, effectiveLeaf } from "./reconstruct.js";

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

export class SessionHistoryStore {
  /** Set when a load failed for a reason that may be transient (a git or I/O
   *  error, not corruption): the file on disk may still be good, so `save`
   *  refuses to overwrite it with the rebuilt history until a load succeeds. */
  private frozen = false;

  constructor(
    private readonly sessionId: string,
    private readonly repository: GitRepository,
    private readonly git: GitRunner,
  ) {}

  /** `predecessorId`: the session this one continues (`continuationOf`), whose
   *  stored history is adopted when this session has none. */
  async load(reader: SessionReader, predecessorId?: string): Promise<HistoryLoadResult> {
    this.frozen = false;
    const sessionHash = checkpointNamespace(this.sessionId);
    const dir = historyDirectory(this.repository);
    const tombstoneFile = tombstonePath(this.repository, this.sessionId);
    const tombstone = await readTombstone(tombstoneFile, sessionHash);
    if (tombstone) {
      return { status: "expired" };
    }

    const path = historyPath(this.repository, this.sessionId);
    let metadata: Stats;
    try {
      metadata = await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (predecessorId !== undefined && (await this.adoptStoredHistory(reader, predecessorId))) {
          return this.load(reader);
        }
        return { status: "unavailable", reason: "missing" };
      }
      this.frozen = true;
      return { status: "unavailable", reason: "unusable" };
    }
    await touchSessionHeartbeat(dir, sessionHash);
    try {
      if (!metadata.isFile() || metadata.size > MAX_HISTORY_BYTES) {
        return { status: "unavailable", reason: "unusable" };
      }
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const parsed = parseHistory(value, this.sessionId, this.repository);
      if (!parsed) return { status: "unavailable", reason: "unusable" };
      const refPrefix = historyRefPrefix(parsed.sessionHash);
      const refs = await existingRefs(this.git, this.repository, refPrefix);
      if (refs === null) {
        this.frozen = true;
        return { status: "unavailable", reason: "unusable" };
      }
      const checkpoints = parsed.checkpoints.map((checkpoint): TurnCheckpoint => {
        if (checkpoint.kind === "session") {
          const { reason } = checkpoint;
          return {
            ...checkpoint,
            reason: isUnavailableReason(reason) ? reason : "resumed_checkpoint_unavailable",
          };
        }
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
      // recoverable git coordinates, and a newer version's session reason
      // would be lost. The mapping is re-derived on every load.
      await this.refreshStoredTimestamp(parsed).catch(() => undefined);
      return { status: "loaded", state };
    } catch (error) {
      // A file deleted mid-load is missing, malformed JSON is corrupt; any
      // other failure (EMFILE, EBUSY, ...) may pass, so keep the file intact.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.frozen = true;
      }
      return { status: "unavailable", reason: "unusable" };
    }
  }

  /** Writes the history `fromSessionId` stored as this session's, up to its
   *  cursor and only while its turns are on this session's branch: the process
   *  that kept the old session may have undone or added turns since this
   *  session was copied from it. Redo rows are dropped, as on any session
   *  switch. False when nothing is adopted. */
  private async adoptStoredHistory(reader: SessionReader, fromSessionId: string): Promise<boolean> {
    try {
      const path = historyPath(this.repository, fromSessionId);
      const metadata = await stat(path);
      if (!metadata.isFile() || metadata.size > MAX_HISTORY_BYTES) return false;
      const value = JSON.parse(await readFile(path, "utf8")) as unknown;
      const parsed = parseHistory(value, fromSessionId, this.repository);
      if (!parsed) return false;
      const leaf = effectiveLeaf(reader);
      // `null` stands for the empty session, on every branch.
      const branch = new Set<string | null>([
        null,
        ...(leaf === null ? [] : reader.getBranch(leaf)).map((entry) => entry.id),
      ]);
      const rows = parsed.checkpoints.slice(0, parsed.currentIndex + 1);
      const cut = rows.findIndex((row) => !branch.has(row.parentLeafId) || !branch.has(row.leafId));
      const kept = cut < 0 ? rows : rows.slice(0, cut);
      if (kept.length === 0) return false;
      const ownPrefix = historyRefPrefix(checkpointNamespace(this.sessionId));
      const adopted = (await this.adoptCheckpoints(kept, fromSessionId)).map((row) =>
        row.kind === "git" && !row.beforeRef.startsWith(ownPrefix)
          ? unavailableCheckpoint(row)
          : row,
      );
      await this.write(adopted, adopted.length - 1);
      return true;
    } catch {
      return false;
    }
  }

  /** Points this session's history refs at the snapshots of `fromSessionId`'s
   *  checkpoints and returns the checkpoints renamed to them. Copies, never
   *  moves: the old session may still be live in another process. When the
   *  copy fails they come back unchanged, and `save` stores them unavailable. */
  async adoptCheckpoints<T extends StoredCheckpoint>(
    checkpoints: readonly T[],
    fromSessionId: string,
  ): Promise<T[]> {
    const from = historyRefPrefix(checkpointNamespace(fromSessionId));
    const to = historyRefPrefix(checkpointNamespace(this.sessionId));
    const updates: string[] = [];
    const adopted = checkpoints.map((checkpoint): T => {
      const row: StoredCheckpoint = checkpoint;
      if (row.kind !== "git" || !row.beforeRef.startsWith(from)) return checkpoint;
      const beforeRef = to + row.beforeRef.slice(from.length);
      const afterRef = to + row.afterRef.slice(from.length);
      updates.push(`update ${beforeRef} ${row.beforeHash}`, `update ${afterRef} ${row.afterHash}`);
      return { ...checkpoint, beforeRef, afterRef };
    });
    if (updates.length === 0) return adopted;
    const copied = await invoke(this.git, ["update-ref", "--stdin"], {
      env: storeEnv(this.repository),
      stdin: `${updates.join("\n")}\n`,
    });
    return copied.code === 0 ? adopted : [...checkpoints];
  }

  /** Rewrites the stored document with the checkpoints as parsed (not
   *  runtime-mapped; only legacy rows of another repository are already
   *  unavailable) and a fresh lastAccessedAt, preserving schema migration.
   *  Skips the write when a tombstone appeared mid-load so a completed
   *  expiration is never resurrected. */
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
    if (this.frozen) throw new Error("history load failed; refusing to overwrite stored history");
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

  async saveRestoreIntent(intent: RestoreIntent): Promise<void> {
    const path = restoreIntentPath(this.repository, checkpointNamespace(this.sessionId));
    await writeJsonAtomic(historyDirectory(this.repository), path, intent);
  }

  /** Null when there is none or it cannot be read now. A malformed one is
   *  deleted: no later load could settle it either. */
  async loadRestoreIntent(): Promise<RestoreIntent | null> {
    const path = restoreIntentPath(this.repository, checkpointNamespace(this.sessionId));
    const text = await readFile(path, "utf8").catch(() => null);
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as unknown;
      if (isRestoreIntent(value)) return value;
    } catch {
      // malformed: dropped below
    }
    await this.clearRestoreIntent().catch(() => undefined);
    return null;
  }

  async clearRestoreIntent(): Promise<void> {
    const path = restoreIntentPath(this.repository, checkpointNamespace(this.sessionId));
    await rm(path, { force: true });
  }
}
