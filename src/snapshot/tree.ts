import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { GitRunner, SnapshotIndexLease } from "../types.js";
import { invoke } from "../infra/git-runner.js";
import { autocrlfSetting, snapshotMessage } from "./markers.js";
import type { OutsideSnapshot } from "./markers.js";

const GIT_AUTHOR = ["-c", "user.name=omp-undo-redo", "-c", "user.email=omp-undo-redo@local"];

const WORKTREE_PATHSPEC = ":(top)";

const NO_COMMIT_ERROR = /^error: '(.+?)\/?' does not have a commit checked out$/;

const UNABLE_TO_INDEX_ERROR = /^error: unable to index file '(.+?)\/?'$/;

export type SnapshotResult =
  | { hash: string; tree: string; snapshotIndexLease?: SnapshotIndexLease }
  | { reason: "invalid_head" | "snapshot_failed" };

type SeedSnapshotIndexResult =
  { status: "seeded"; headTree: string } | { status: "empty" | "invalid_head" | "failed" };

/** Seeds `env`'s index with `tree` plus the user's own index stat data for
 *  every entry whose blob `tree` still holds, so the `add -A` that follows
 *  re-hashes only changed files instead of every tracked one. `read-tree
 *  --reset` keeps an old entry only when it matches `tree` (`-m` would also
 *  refuse partially staged files and conflicts), so the result is a fresh
 *  `read-tree` with stat data. Declined (false) when the result could differ
 *  from a fresh seed, or reading the copy would touch the user's git dir:
 *  under `core.autocrlf` true or input the user's entries vouch for the
 *  converted blob, not for the bytes on disk that `addWorktree` records;
 *  skip-worktree and assume-unchanged flags survive the merge and `add -A`
 *  would skip those paths, and a copied split index resolves its shared part
 *  from the git dir, whose mtime git then refreshes on every read. The copy's
 *  mtime is set just below the original's, so git's racy-clean check covers
 *  at least what it covers in the user's index.
 *  Streams, not `copyFile`: libuv opens with FILE_SHARE_DELETE on Windows, so
 *  a concurrent git can still replace the index.
 *  ponytail: an entry git refreshed while `core.autocrlf` was on, and that
 *  nothing has re-added since it was turned off, still vouches for the
 *  converted blob (git's own `status` trusts it too); `add --renormalize`
 *  or a fresh checkout clears it. */
async function seedFromUserIndex(
  git: GitRunner,
  env: { GIT_INDEX_FILE: string },
  gitDir: string,
  tree: string,
): Promise<boolean> {
  if ((await autocrlfSetting(git)) !== "false") return false;
  const source = join(gitDir, "index");
  try {
    if ((await readdir(gitDir)).some((name) => name.startsWith("sharedindex."))) return false;
    const { atime, mtimeMs } = await stat(source);
    await pipeline(createReadStream(source), createWriteStream(env.GIT_INDEX_FILE));
    await utimes(env.GIT_INDEX_FILE, atime, new Date(mtimeMs - 1));
  } catch {
    return false;
  }
  if ((await invoke(git, ["read-tree", "--reset", tree], { env })).code !== 0) return false;
  // Tags: "H" plain, "S" skip-worktree, lowercase assume-unchanged.
  const entries = await invoke(git, ["ls-files", "-v", "-z"], { env });
  return (
    entries.code === 0 &&
    entries.stdout.split("\0").every((entry) => !entry || entry.startsWith("H "))
  );
}

/** `gitDir`: the repository whose index may seed stat data (`seedFromUserIndex`).
 *  A declined or failed attempt falls back to a plain `read-tree`, which
 *  replaces whatever the attempt left in the index file. */
async function seedSnapshotIndex(
  git: GitRunner,
  env: { GIT_INDEX_FILE: string },
  gitDir?: string,
): Promise<SeedSnapshotIndexResult> {
  const headTree = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  const hash = headTree.stdout.trim();
  if (headTree.code === 0 && hash) {
    if (gitDir && (await seedFromUserIndex(git, env, gitDir, hash))) {
      return { status: "seeded", headTree: hash };
    }
    const seeded = await invoke(git, ["read-tree", hash], { env });
    return seeded.code === 0 ? { status: "seeded", headTree: hash } : { status: "failed" };
  }
  if (headTree.error === "unavailable") return { status: "failed" };

  const symbolicHead = await invoke(git, ["symbolic-ref", "-q", "HEAD"]);
  if (symbolicHead.code !== 0 || !symbolicHead.stdout.trim()) return { status: "invalid_head" };
  const branchRef = symbolicHead.stdout.trim();
  const branch = await invoke(git, ["show-ref", "--verify", "--quiet", branchRef]);
  if (branch.code === 0) return { status: "invalid_head" };
  if (branch.error === "unavailable") return { status: "failed" };

  const empty = await invoke(git, ["read-tree", "--empty"], { env });
  return empty.code === 0 ? { status: "empty" } : { status: "failed" };
}

async function createCommitForTree(
  git: GitRunner,
  treeHash: string,
  message: string,
): Promise<SnapshotResult> {
  const commit = await invoke(git, [...GIT_AUTHOR, "commit-tree", treeHash, "-m", message]);
  if (commit.code !== 0) return { reason: "snapshot_failed" };
  const commitHash = commit.stdout.trim();
  return commitHash ? { hash: commitHash, tree: treeHash } : { reason: "snapshot_failed" };
}

/** A lease is usable only while its baseline still describes HEAD: the same
 *  HEAD tree for a born HEAD, and a still-unborn HEAD for an unborn lease.
 *  Checked once, after the tree is written: a check before the run would only
 *  fail a stale lease faster, and one spawn per snapshot costs more than the
 *  incremental pass a stale lease wastes before its caller reseeds. */
async function leaseBaselineCurrent(git: GitRunner, lease: SnapshotIndexLease): Promise<boolean> {
  const head = await invoke(git, ["rev-parse", "--verify", "HEAD^{tree}"]);
  if (head.error === "unavailable") return false;
  const tree = head.code === 0 ? head.stdout.trim() : "";
  return lease.unborn ? tree === "" : tree === lease.baseTree;
}

/** Drops index entries that the current ignore rules exclude. With `baseTree`,
 *  entries the baseline tracks are kept: `read-tree HEAD` holds them in a fresh
 *  snapshot whatever the ignore rules say. Index-only: no worktree file is
 *  re-read, so the retained stat cache survives. */
async function pruneIgnoredEntries(
  git: GitRunner,
  env: Record<string, string>,
  baseTree?: string,
): Promise<boolean> {
  const ignored = await invoke(
    git,
    ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"],
    { env },
  );
  if (ignored.code !== 0) return false;
  let paths = ignored.stdout;
  if (paths && baseTree) {
    const added = await invoke(
      git,
      [
        "diff-index",
        "--cached",
        "--no-renames",
        "--diff-filter=A",
        "--name-only",
        "-z",
        baseTree,
        "--",
      ],
      { env },
    );
    if (added.code !== 0) return false;
    const untracked = new Set(added.stdout.split("\0"));
    paths = paths
      .split("\0")
      .filter((path) => path && untracked.has(path))
      .map((path) => `${path}\0`)
      .join("");
  }
  if (!paths) return true;
  const removed = await invoke(git, ["update-index", "--force-remove", "-z", "--stdin"], {
    env,
    stdin: paths,
  });
  return removed.code === 0;
}

/** `git add -A` of the whole worktree. Two failures leave a path out instead
 *  of aborting every snapshot: an embedded repository with no commit checked
 *  out (cannot be recorded even as a gitlink; one `git init` in a subfolder
 *  would disable capture), and a file git cannot read (a database held open
 *  by a running app on Windows; it would disable capture for as long as the
 *  lock is held). The index keeps whatever entry an unreadable file had, so
 *  its tree entry is stale or missing: restores pin it (`applyPatch`) instead
 *  of treating it as deleted. Any other error still fails the snapshot, as
 *  does an error line not naming the file the following "unable to index"
 *  line reports. `LC_ALL=C` pins the messages being matched.
 *  `core.autocrlf=false`: `core.autocrlf` would store an LF blob for a CRLF
 *  file, so restoring an LF file wrote CRLF and a turn that only changed
 *  line endings recorded nothing. Text/eol attributes still apply: the
 *  repository asked for that normalization, and a restore writes what
 *  `git checkout` would. */
async function addWorktree(
  git: GitRunner,
  env: Record<string, string>,
): Promise<OutsideSnapshot | null> {
  // Under a text attribute, `core.safecrlf` only warns (one stderr line per
  // converted file) or, set to true, aborts the add; the blobs written are
  // the same either way.
  const added = await invoke(
    git,
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.safecrlf=false",
      "add",
      "-A",
      "--ignore-errors",
      "--",
      WORKTREE_PATHSPEC,
    ],
    { env: { ...env, LC_ALL: "C" } },
  );
  const outside: OutsideSnapshot = { nestedRepositories: [], unreadableFiles: [] };
  if (added.code === 0) return outside;
  if (added.error || added.code !== 1) return null;
  // Error lines git printed for the file the next "unable to index" names.
  let reasons: string[] = [];
  for (const line of added.stderr.split(/\r?\n/)) {
    const noCommit = NO_COMMIT_ERROR.exec(line);
    if (noCommit) {
      outside.nestedRepositories.push(noCommit[1]!);
      continue;
    }
    const unable = UNABLE_TO_INDEX_ERROR.exec(line);
    if (unable) {
      const path = unable[1]!;
      if (reasons.length === 0) {
        if (path !== outside.nestedRepositories.at(-1)) return null;
      } else {
        if (!reasons.every((reason) => reason.includes(path))) return null;
        outside.unreadableFiles.push(path);
        reasons = [];
      }
      continue;
    }
    if (line.startsWith("fatal:")) return null;
    if (line.startsWith("error:")) reasons.push(line);
  }
  const leftOut = outside.nestedRepositories.length + outside.unreadableFiles.length;
  return reasons.length === 0 && leftOut > 0 ? outside : null;
}

export async function createSnapshotCommit(
  git: GitRunner,
  message: string,
  retainIndex = false,
  gitDir?: string,
): Promise<SnapshotResult> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-index-"));
    const indexPath = join(tempDirectory, "index");
    const env = { GIT_INDEX_FILE: indexPath };
    const seeded = await seedSnapshotIndex(git, env, gitDir);
    if (seeded.status === "invalid_head") return { reason: "invalid_head" };
    if (seeded.status === "failed") return { reason: "snapshot_failed" };
    const addEnv: Record<string, string> = { ...env };
    if (git.env?.GIT_DIR && git.cwd) addEnv.GIT_WORK_TREE = git.cwd;
    const outside = await addWorktree(git, addEnv);
    if (!outside) return { reason: "snapshot_failed" };
    const tree = await invoke(git, ["write-tree"], { env });
    if (tree.code !== 0) return { reason: "snapshot_failed" };
    const treeHash = tree.stdout.trim();
    if (!treeHash) return { reason: "snapshot_failed" };
    const commit = await createCommitForTree(git, treeHash, snapshotMessage(message, outside));
    if (!("hash" in commit)) return commit;
    if (retainIndex && (seeded.status === "seeded" || seeded.status === "empty")) {
      const snapshotIndexLease: SnapshotIndexLease =
        seeded.status === "seeded"
          ? { directory: tempDirectory, indexPath, baseTree: seeded.headTree }
          : // ponytail: unborn HEAD has no baseline commit, so the seeding
            // snapshot's own tree is the baseline. It is reachable from the
            // before/after refs; if it is ever pruned, diff-index fails and the
            // lease is simply reseeded.
            { directory: tempDirectory, indexPath, baseTree: treeHash, unborn: true };
      tempDirectory = null;
      return { ...commit, snapshotIndexLease };
    }
    return commit;
  } catch {
    return { reason: "snapshot_failed" };
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** Paths a reused index restores from its baseline, from `diff-index --raw -z
 *  --diff-filter=ADT` output, as a NUL-separated pathspec file. Deletions and
 *  typechanges: `add -A` never re-adds an ignored path that a fresh `read-tree`
 *  would hold. Added gitlinks: `add -A` keeps a gitlink whose nested `.git` is
 *  gone, which would hide the directory's files from every later snapshot.
 *  Other added entries stay, so untracked files keep their stat cache instead of
 *  being re-hashed each snapshot; `pruneIgnoredEntries` drops the ones that
 *  became ignored. Bytes are sliced, never decoded, so any path survives.
 *  Null on malformed output. */
function normalizationPaths(raw: Buffer): Buffer | null {
  const paths: Buffer[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const metaEnd = raw.indexOf(0, offset);
    const pathEnd = metaEnd < 0 ? -1 : raw.indexOf(0, metaEnd + 1);
    if (pathEnd < 0) return null;
    // `:<srcmode> <dstmode> <srcsha> <dstsha> <status>`
    const [, dstMode, , , status] = raw.toString("latin1", offset, metaEnd).split(" ");
    if (status !== "A" || dstMode === "160000") paths.push(raw.subarray(metaEnd + 1, pathEnd + 1));
    offset = pathEnd + 1;
  }
  return Buffer.concat(paths);
}

export async function createSnapshotCommitFromLease(
  git: GitRunner,
  lease: SnapshotIndexLease,
  message: string,
): Promise<SnapshotResult> {
  const normalizationPath = join(lease.directory, `normalize-${randomUUID()}.nul`);
  const env = { GIT_INDEX_FILE: lease.indexPath };
  try {
    const differences = await invoke(
      git,
      [
        "diff-index",
        "--cached",
        "--no-renames",
        "--diff-filter=ADT",
        "--raw",
        "-z",
        `--output=${normalizationPath}`,
        lease.baseTree,
        "--",
      ],
      { env },
    );
    if (differences.code !== 0) return { reason: "snapshot_failed" };

    const restored = normalizationPaths(await readFile(normalizationPath));
    if (!restored) return { reason: "snapshot_failed" };
    if (restored.length > 0) {
      await writeFile(normalizationPath, restored);
      const reset = await invoke(
        git,
        [
          "--literal-pathspecs",
          "reset",
          "-q",
          lease.baseTree,
          `--pathspec-from-file=${normalizationPath}`,
          "--pathspec-file-nul",
        ],
        { env },
      );
      if (reset.code !== 0) return { reason: "snapshot_failed" };
    }

    const addEnv: Record<string, string> = { ...env };
    if (git.env?.GIT_DIR && git.cwd) addEnv.GIT_WORK_TREE = git.cwd;
    const outside = await addWorktree(git, addEnv);
    if (!outside) return { reason: "snapshot_failed" };
    // `add -A` cannot drop an entry that became ignored after it was staged, so
    // prune those explicitly; a fresh snapshot never holds one unless HEAD
    // tracks it (an unborn baseline tracks nothing).
    if (!(await pruneIgnoredEntries(git, addEnv, lease.unborn ? undefined : lease.baseTree))) {
      return { reason: "snapshot_failed" };
    }
    const tree = await invoke(git, ["write-tree"], { env });
    const treeHash = tree.stdout.trim();
    if (tree.code !== 0 || !treeHash) return { reason: "snapshot_failed" };

    if (!(await leaseBaselineCurrent(git, lease))) return { reason: "snapshot_failed" };
    return createCommitForTree(git, treeHash, snapshotMessage(message, outside));
  } catch {
    return { reason: "snapshot_failed" };
  } finally {
    await rm(normalizationPath, { force: true }).catch(() => undefined);
  }
}
