import { readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CwdGitRunnerFactory, GitRepository } from "../../types.js";
import { borrowsObjects, storeEnv } from "../git-store.js";
import { gcPendingPath } from "../refs.js";
import { pinStoreObjects } from "../pinning.js";

/** Repacking a large snapshot repo legitimately outruns the runner's
 *  default per-child deadline, so gc gets its own ceiling: long enough that
 *  a real gc always finishes, short enough that a wedged child cannot hold
 *  a tracked operation (and with it the eviction sweep) forever. */
const PRIVATE_GC_TIMEOUT_MS = 15 * 60 * 1000;

/** gc prune window, for every trigger (retention sweep, capture threshold,
 *  shutdown). A store is shared by every OMP process in the same workspace
 *  (Private-Git: keyed only by sha256(cwd); Git mode: by the repository), and
 *  another process may be mid-capture, writing objects no ref reaches yet.
 *  `--prune=now` would delete them; the in-process `pendingCaptures` check
 *  cannot see other processes. Expired objects are days old, so an hour
 *  loses nothing. */
const PRIVATE_SWEEP_PRUNE = "1.hour.ago";

/** Best-effort `git prune` + `git gc` over a snapshot store. Runs outside
 *  the handler deadline accounting (never awaited by a handler) so a slow
 *  gc can never hit the host's timeout. The prune drops unreferenced
 *  objects: expiring sessions would otherwise leave recoverable file
 *  content behind indefinitely. */
async function runPrivateGc(
  repository: GitRepository,
  gitRunnerFactory: CwdGitRunnerFactory,
): Promise<void> {
  // Claimed before gc reads the refs: a deletion during this gc marks the
  // store anew, and only a gc that finished drops the claim, so one cut
  // short by a failure, its ceiling or the process exit leaves it for the
  // next boot's sweep (`storeNeedsGc`). An existing claim (a killed gc, or
  // another process's gc still running) is never overwritten: that gc may
  // drop it after missing this mark's deletion, so the mark stays and costs
  // at most one extra gc.
  const mark = gcPendingPath(repository.storeDir);
  const claim = `${mark}.running`;
  try {
    if (!(await stat(claim).catch(() => null))) {
      await rename(mark, claim).catch(() => undefined);
    }
    // Run from a neutral cwd so a slow gc never holds a handle on either the
    // user's workspace or the snapshot repo itself (Windows keeps a child's
    // cwd handle until it exits, which would race teardown rms and the
    // eviction sweep). GIT_DIR is set, so the repo operations work anywhere;
    // a Git store also needs the objects it borrows to walk its snapshots.
    const git = gitRunnerFactory(tmpdir(), storeEnv(repository));
    // Git mode: the prune and gc below would drop the store's copies of
    // objects the user's repository also holds.
    await pinStoreObjects(git, repository, PRIVATE_GC_TIMEOUT_MS);
    // gc prunes only after its repack. A repack that outruns the ceiling
    // (or dies with the terminal) is hard-killed on Windows, so its prune
    // never runs: expired snapshots stay on disk and every attempt leaves a
    // multi-GB `tmp_pack_*` behind (#101). The same prune run alone needs
    // no repack, and also deletes `tmp_*` leftovers past the window.
    const pruned = await git(["prune", `--expire=${PRIVATE_SWEEP_PRUNE}`], {
      timeoutMs: PRIVATE_GC_TIMEOUT_MS,
    });
    // gc would rerun the same prune and fail the same way.
    if (pruned.error) return;
    const gc = await git(["gc", `--prune=${PRIVATE_SWEEP_PRUNE}`], {
      timeoutMs: PRIVATE_GC_TIMEOUT_MS,
    });
    if (gc.code === 0 && !gc.error) await rm(claim, { force: true });
  } catch {
    // Best-effort: a failed gc leaves more work for the next trigger.
  }
}

/** Maintenance for the capture-driven triggers (capture threshold,
 *  shutdown). A full gc rewrites the whole store, so running one per 20
 *  captures made its cost grow with the store. Captures only add objects;
 *  garbage from ref deletions is the `gc-pending` mark's, which the next
 *  boot sweep's full gc reclaims. So these triggers repack only once git's
 *  own `gc --auto` limits say so. A private store lets git decide: it packs
 *  just the loose objects, and rewrites every pack only past the pack
 *  limit. A Git-mode store cannot run `gc --auto`: any repack there may
 *  drop its copies of borrowed objects unless `pinStoreObjects` ran first,
 *  so it gets the full pinned gc, once it crosses the same limits. */
export async function runCaptureGc(
  repository: GitRepository,
  gitRunnerFactory: CwdGitRunnerFactory,
): Promise<void> {
  try {
    if (borrowsObjects(repository)) {
      if (await storeExceedsAutoGcLimits(repository.storeDir))
        await runPrivateGc(repository, gitRunnerFactory);
      return;
    }
    // Neutral cwd: see `runPrivateGc`. Not detached: a gc running past its
    // queue entry would escape the eviction guard and the serial queue.
    // Limits pinned: a user's global `gc.auto=0` would otherwise leave the
    // store's loose objects unpacked for good, and the Git-mode gate uses
    // the same numbers.
    await gitRunnerFactory(tmpdir(), storeEnv(repository))(
      [
        "-c",
        "gc.autoDetach=false",
        "-c",
        `gc.auto=${GC_AUTO_LOOSE_OBJECTS}`,
        "-c",
        `gc.autoPackLimit=${GC_AUTO_PACK_LIMIT}`,
        "gc",
        "--auto",
        "--quiet",
        `--prune=${PRIVATE_SWEEP_PRUNE}`,
      ],
      { timeoutMs: PRIVATE_GC_TIMEOUT_MS },
    );
  } catch {
    // Best-effort, like `runPrivateGc`.
  }
}

/** git's defaults for `gc --auto`: loose objects past which it packs them,
 *  and packs (without a `.keep`) at which it repacks them all. */
const GC_AUTO_LOOSE_OBJECTS = 6700;

const GC_AUTO_PACK_LIMIT = 50;

/** git's `gc --auto` test: more than GC_AUTO_LOOSE_OBJECTS loose objects,
 *  estimated as git does from fan-out `17` alone, or GC_AUTO_PACK_LIMIT
 *  packs without a `.keep`. */
async function storeExceedsAutoGcLimits(storeDir: string): Promise<boolean> {
  const objects = join(storeDir, "objects");
  const names = await readdir(join(objects, "pack")).catch(() => [] as string[]);
  const kept = new Set(names.filter((name) => name.endsWith(".keep")));
  const packs = names.filter(
    (name) => name.endsWith(".pack") && !kept.has(`${name.slice(0, -".pack".length)}.keep`),
  );
  if (packs.length >= GC_AUTO_PACK_LIMIT) return true;
  const loose = await readdir(join(objects, "17")).catch(() => [] as string[]);
  // SHA-1 or SHA-256 object names, minus their two-digit fan-out.
  const looseObjects = loose.filter((name) => /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(name));
  return looseObjects.length > Math.ceil(GC_AUTO_LOOSE_OBJECTS / 256);
}

/** Whether a store holds any ref, loose or packed. Errors other than ENOENT
 *  propagate, which the sweep reads as "keep". */
export async function storeHasRefs(gitDir: string): Promise<boolean> {
  try {
    const loose = await readdir(join(gitDir, "refs"), { recursive: true, withFileTypes: true });
    if (loose.some((entry) => entry.isFile())) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const packed = await readFile(join(gitDir, "packed-refs"), "utf8");
    return packed.split(/\r?\n/).some((line) => line !== "" && !line.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** Whether a store holds garbage only a gc reclaims. Packed objects a
 *  deleted ref orphaned outlive `git prune`, and every in-process trigger
 *  (capture threshold, shutdown, expiry) dies with the process, so the
 *  sweep checks durable evidence instead: a deletion's `gc-pending` mark,
 *  the claim of a gc that never finished, a cruft pack (`.mtimes`: objects
 *  an earlier gc kept inside its prune window), or objects no ref can reach
 *  at all (stores orphaned before the mark existed). */
export async function storeNeedsGc(storeDir: string): Promise<boolean> {
  const mark = gcPendingPath(storeDir);
  for (const path of [mark, `${mark}.running`]) {
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    )
      return true;
  }
  const objects = join(storeDir, "objects");
  const packs = await readdir(join(objects, "pack")).catch(() => [] as string[]);
  if (packs.some((name) => name.endsWith(".mtimes"))) return true;
  // Unreadable refs read as "has refs": never gc on a guess.
  if (await storeHasRefs(storeDir).catch(() => true)) return false;
  if (packs.some((name) => name.endsWith(".pack"))) return true;
  const fanouts = await readdir(objects).catch(() => [] as string[]);
  return fanouts.some((name) => /^[0-9a-f]{2}$/.test(name));
}

// Snapshot-store housekeeping: captures between maintenance checks (per
// store) and the threshold that triggers one (`runCaptureGc`). Every store
// is the extension's own (`storeDir` never names the user's `.git`), so gc
// can never touch a user repository.
const PRIVATE_GC_AFTER_CAPTURES = 20;

/** This extension copy's gc queue. Every trigger (retention sweep, capture
 *  threshold, shutdown) routes through `schedule`, so a copy runs at most
 *  one repack at a time: a boot sweep over many expired stores would
 *  otherwise start one full `git gc` per store at once. Not process-wide:
 *  OMP binds a copy per in-process session, but subagent copies never
 *  capture or expire (`servesMainSession`), so only main sessions' copies
 *  (one, or one per ACP session) feed a queue. Never rejects (`runPrivateGc`
 *  and `runCaptureGc` swallow every failure), so one bad store cannot stall
 *  the queue. */
export class GcQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly capturesSinceGc = new Map<string, number>();

  constructor(private readonly gitRunnerFactory: CwdGitRunnerFactory) {}

  /** Queues `run` (default: the full `runPrivateGc`) over `repository`
   *  behind every gc already scheduled; resolves once this one has run. */
  schedule(
    repository: GitRepository,
    run: (
      repository: GitRepository,
      gitRunnerFactory: CwdGitRunnerFactory,
    ) => Promise<void> = runPrivateGc,
  ): Promise<void> {
    this.tail = this.tail.then(() => run(repository, this.gitRunnerFactory));
    return this.tail;
  }

  /** Counts a capture into the store keyed `key`. True when the caller must
   *  schedule `runCaptureGc` now; `othersInFlight` is true while more than
   *  one capture is in flight. */
  countCapture(key: string, othersInFlight: boolean): boolean {
    const count = (this.capturesSinceGc.get(key) ?? 0) + 1;
    if (count >= PRIVATE_GC_AFTER_CAPTURES) {
      this.capturesSinceGc.delete(key);
      // The current capture's git work is done (this runs after its
      // snapshot); only defer when another session's capture is still
      // mid-flight, to avoid repacking under it. The counter reset
      // below prevents gc runs from stacking.
      if (!othersInFlight) return true;
      this.capturesSinceGc.set(key, PRIVATE_GC_AFTER_CAPTURES - 1);
      return false;
    }
    this.capturesSinceGc.set(key, count);
    return false;
  }

  /** For shutdown: true if `key` counted captures since its last gc; clears it. */
  takeCounted(key: string): boolean {
    if (!this.capturesSinceGc.has(key)) return false;
    this.capturesSinceGc.delete(key);
    return true;
  }
}
