import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRepository, GitRunner } from "../../types.js";
import { parseRefLines } from "../../infra/git-parse.js";
import { snapshotRunnerEnv, storeEnv } from "../git-store.js";
import { deleteRefsBatched } from "../refs.js";
import { canonicalCwd, storeRootDirectory } from "../../infra/paths.js";
import { removeDirWithRetry } from "../../infra/fs.js";

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

const LEGACY_BLOB_DIRS = [
  "blobs",
  "trees",
  "refs",
  "locks",
  "leases",
  "journals",
  "history",
] as const;

const LEGACY_BLOB_QUIET_MS = 7 * 24 * 60 * 60 * 1000;

/** One-shot removal of the pre-v1.5.1 store layout, whose dirs hold user file
 *  content and are never reclaimed by anything else. Kept while the pre-1.5.1
 *  tail (v1.5.1 shipped 2026-08-21) can still upgrade straight to 1.6.x.
 *  ponytail: delete this, LEGACY_BLOB_DIRS, LEGACY_BLOB_QUIET_MS,
 *  cleanLegacyGitIndexes, their boot wiring, and test/legacy-blob-purge.test.ts
 *  at v1.7.0. removeDirWithRetry/EVICTION_RETRY_DELAY_MS stay: eviction uses them. */
export async function purgeLegacyBlobStore(): Promise<void> {
  const root = canonicalCwd(storeRootDirectory());
  const isDir = async (name: string): Promise<boolean> =>
    stat(join(root, name))
      .then((s) => s.isDirectory())
      .catch(() => false);
  if (!(await isDir("blobs"))) return;
  if (!(await isDir("trees")) && !(await isDir("journals"))) return;

  let newest = 0;
  for (const name of LEGACY_BLOB_DIRS) {
    const dir = join(root, name);
    const metadata = await stat(dir).catch(() => undefined);
    if (!metadata) continue;
    newest = Math.max(newest, metadata.mtimeMs);
    // Liveness lives in these three only; blobs/ and trees/ are never walked.
    if (name !== "locks" && name !== "leases" && name !== "history") continue;
    for (const entry of await readdir(dir).catch(() => [])) {
      const child = await stat(join(dir, entry)).catch(() => undefined);
      if (child) newest = Math.max(newest, child.mtimeMs);
    }
  }
  if (Date.now() - newest < LEGACY_BLOB_QUIET_MS) return;

  for (const name of LEGACY_BLOB_DIRS) await removeDirWithRetry(join(root, name));
}

/** One-time removal of legacy git-indexes directory from pre-v1.5.1 store layout */
export async function cleanLegacyGitIndexes(): Promise<void> {
  const legacy = join(canonicalCwd(storeRootDirectory()), "git-indexes");
  await rm(legacy, { recursive: true, force: true }).catch(() => undefined);
}
