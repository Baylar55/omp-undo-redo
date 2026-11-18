import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { GitRepository, GitRunner } from "../../types.js";
import { renameWithRetry } from "../../infra/fs.js";
import { DEFAULT_TIMEOUT_MS, invoke } from "../../infra/git-runner.js";
import { parseRefLines } from "../../infra/git-parse.js";
import { snapshotRunnerEnv, storeEnv } from "../git-store.js";
import { deleteRefsBatched } from "../refs.js";

const LEGACY_REF_ROOT = "refs/omp-undo-redo/";

/** Moves snapshots that earlier versions kept inside the user's repository
 *  (refs under `refs/omp-undo-redo/`, history files and owner leases under
 *  `<commonDir>/omp-undo-redo/`) into `repository.storeDir`, then deletes the
 *  user-side refs so `push --mirror`, `clone --mirror`, `bundle --all` and
 *  `log --all` stop exposing them. Objects that only those refs reached are
 *  packed into the store first; objects the user's own refs reach stay
 *  borrowed, like every new snapshot's. Nothing leaves the user's repository
 *  before the store holds it, and files move only once no legacy ref is left,
 *  so an interrupted run is finished by the next and a failed one changes
 *  nothing. Re-run on every backend start: an older version still running
 *  against the same repository keeps writing the legacy layout. */
export async function migrateLegacySnapshots(
  git: GitRunner,
  repository: GitRepository,
): Promise<void> {
  const userEnv = { GIT_DIR: repository.commonDir };
  const listed = await git(
    ["for-each-ref", "--format=%(refname)%00%(objectname)", LEGACY_REF_ROOT],
    { env: userEnv },
  );
  if (listed.code !== 0 || listed.error) return;
  const refs = parseRefLines(listed.stdout);
  if (!refs) return;
  if (refs.length > 0) {
    // The object list grows with the legacy snapshots' content, so rev-list's
    // output is piped into pack-objects, never held whole (as in
    // `pinStoreObjects`). pack-objects' clock also runs while rev-list walks:
    // two steps' budget. `invoke`, not `git`: a throw must not leave
    // pack-objects waiting on an input nobody ends.
    const input = new PassThrough();
    const packing = invoke(
      git,
      ["pack-objects", "-q", join(repository.storeDir, "objects", "pack", "pack")],
      {
        env: { ...userEnv, ...snapshotRunnerEnv(repository) },
        input,
        timeoutMs: 2 * DEFAULT_TIMEOUT_MS,
      },
    );
    let count = 0;
    let partial = "";
    const feed = (chunk: string) => {
      const lines = (partial + chunk).split("\n");
      partial = lines.pop()!;
      // Edges ("-<id>") are the user's tips; `--objects-edge-aggressive` also
      // leaves out every object their trees hold.
      const owned = lines.filter((line) => line && !line.startsWith("-"));
      count += owned.length;
      if (owned.length > 0) input.write(`${owned.join("\n")}\n`);
    };
    const objects = await invoke(
      git,
      [
        "rev-list",
        "--objects",
        "--objects-edge-aggressive",
        "--stdin",
        "--not",
        `--exclude=${LEGACY_REF_ROOT}*`,
        "--all",
      ],
      {
        env: userEnv,
        stdin: `${refs.map(({ expectedHash }) => expectedHash).join("\n")}\n`,
        onStdout: feed,
      },
    );
    // A runner that ignores `onStdout` buffers instead; the newline flushes
    // the last line.
    feed(`${objects.stdout}\n`);
    const complete = objects.code === 0 && !objects.error;
    // A line that is no object id makes pack-objects die before it writes a
    // pack: a partial list must not be kept, and an empty one would still
    // write an empty pack.
    input.end(complete && count > 0 ? undefined : "abort\n");
    const packed = await packing;
    if (!complete) return;
    if (count > 0 && (packed.code !== 0 || packed.error)) return;
    const copied = await git(["update-ref", "--stdin"], {
      env: storeEnv(repository),
      stdin: `${refs.map(({ ref, expectedHash }) => `update ${ref} ${expectedHash}`).join("\n")}\n`,
    });
    if (copied.code !== 0 || copied.error) return;
    if ((await deleteRefsBatched(git, refs, { env: userEnv })) !== "ok") return;
  }
  const legacyRoot = join(repository.commonDir, "omp-undo-redo");
  for (const name of ["history", "owners"]) {
    await moveFiles(join(legacyRoot, name), join(repository.storeDir, "omp-undo-redo", name));
  }
  await rmdir(legacyRoot).catch(() => undefined);
}

/** Moves every file of `from` into `to`. A file already in `to` is kept
 *  unless the legacy copy is newer: an older version still running keeps
 *  rewriting the legacy file after an earlier migration, and history files are
 *  whole-state rewrites, so the newer copy wins (as in liveness: last writer
 *  wins). Copy + rename, not a bare rename: the two directories may sit on
 *  different volumes, and readers must never see a partial file.
 *  shortcut: mtime is the only signal an older version writes, and a load
 *  here refreshes the store file's mtime, so a load between an old version's
 *  save and the next start keeps the stale store copy; upgrade if the history
 *  format gains a save counter both versions write. */
async function moveFiles(from: string, to: string): Promise<void> {
  const names = await readdir(from).catch(() => null);
  if (!names) return;
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const source = join(from, name);
    const target = join(to, name);
    // An unreadable source is left for the next run, never deleted uncopied.
    const sourceTime = await stat(source).then(
      (s) => s.mtimeMs,
      () => null,
    );
    if (sourceTime === null) continue;
    const targetTime = await stat(target).then(
      (s) => s.mtimeMs,
      () => -Infinity,
    );
    if (sourceTime > targetTime) {
      const temporary = join(to, `.${name}.${randomUUID()}.tmp`);
      try {
        await copyFile(source, temporary);
        await renameWithRetry(temporary, target);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        continue;
      }
    }
    // A save landing mid-copy changes the mtime: leave it for the next run.
    const unchanged = await stat(source).then(
      (s) => s.mtimeMs === sourceTime,
      () => false,
    );
    if (unchanged) await rm(source, { force: true }).catch(() => undefined);
  }
  await rmdir(from).catch(() => undefined);
}
