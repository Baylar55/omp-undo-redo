import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { deleteRefsBatched, parseRefLines } from "./git-refs.js";
import { snapshotRunnerEnv, storeEnv } from "./checkpoints.js";
import type { GitRepository, GitRunner } from "./types.js";

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
    // Edges ("-<id>") are the user's tips; `--objects-edge-aggressive` also
    // leaves out every object their trees hold.
    const objects = await git(
      [
        "rev-list",
        "--objects",
        "--objects-edge-aggressive",
        "--stdin",
        "--not",
        `--exclude=${LEGACY_REF_ROOT}*`,
        "--all",
      ],
      { env: userEnv, stdin: `${refs.map(({ expectedHash }) => expectedHash).join("\n")}\n` },
    );
    if (objects.code !== 0 || objects.error) return;
    const owned = objects.stdout.split("\n").filter((line) => line && !line.startsWith("-"));
    if (owned.length > 0) {
      const packed = await git(
        ["pack-objects", "-q", join(repository.storeDir, "objects", "pack", "pack")],
        {
          env: { ...userEnv, ...snapshotRunnerEnv(repository) },
          stdin: `${owned.join("\n")}\n`,
        },
      );
      if (packed.code !== 0 || packed.error) return;
    }
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

/** Moves every file of `from` into `to`; a file already in `to` was written
 *  by this version and supersedes the legacy copy. Copy + rename, not a bare
 *  rename: the two directories may sit on different volumes, and readers must
 *  never see a partial file. */
async function moveFiles(from: string, to: string): Promise<void> {
  const names = await readdir(from).catch(() => null);
  if (!names) return;
  await mkdir(to, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const source = join(from, name);
    const target = join(to, name);
    const present = await stat(target).then(
      () => true,
      () => false,
    );
    if (!present) {
      const temporary = join(to, `.${name}.${randomUUID()}.tmp`);
      try {
        await copyFile(source, temporary);
        await rename(temporary, target);
      } catch {
        await rm(temporary, { force: true }).catch(() => undefined);
        continue;
      }
    }
    await rm(source, { force: true }).catch(() => undefined);
  }
  await rmdir(from).catch(() => undefined);
}
