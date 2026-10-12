import { readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../infra/fs.js";
import { pruneStaleHeartbeats, sessionHeartbeatIsFresh } from "./liveness.js";
import { pruneExpiredTombstones } from "./tombstones.js";
import type { ExpirationTombstone, GitRepository, GitRunner } from "../types.js";
import { markGcPending, HISTORY_REF_ROOT } from "../store/refs.js";
import { historyDirectory, tombstonePath, restoreIntentPath } from "./layout.js";
import { GIT_OBJECT_ID, HASH } from "./codec.js";

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
    await markGcPending(repository.storeDir);
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
    await rm(restoreIntentPath(repository, sessionHash), { force: true }).catch(() => undefined);
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

/** Strict: `Number`, not `parseInt`, which read "0.5" as 0 (retention off,
 *  history kept forever) and "7days" as 7. Fractions are honored ("0.5" is 12
 *  hours); anything that is not a non-negative number falls back to 2. */
export function readRetentionDays(value = process.env.OMP_UNDO_REDO_RETENTION_DAYS): number {
  const days = value?.trim() ? Number(value) : NaN;
  return Number.isFinite(days) && days >= 0 ? days : 2;
}
