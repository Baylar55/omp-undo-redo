import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "../types.js";
import { invoke } from "../infra/git-runner.js";
import { AUTOCRLF_OFF_LINE, NESTED_REPOSITORY_LINE, UNREADABLE_FILE_LINE } from "./markers.js";
import type { OutsideSnapshot } from "./markers.js";

/** Restore invocations get a far larger ceiling than the runner's default:
 *  diffing and applying a multi-GB binary change is slow but legitimate, and
 *  a killed `git apply` can leave the worktree half-written. The deadline
 *  exists only so a wedged child cannot hang the process forever. */
export const RESTORE_TIMEOUT_MS = 10 * 60 * 1000;

/** Paths of `paths` that `tree`'s own ignore rules exclude. The rules are
 *  materialized into a scratch worktree (`tree`'s `.gitignore` files only) so
 *  `check-ignore` evaluates them exactly as git would have when that tree was
 *  snapshotted, alongside the repository's `info/exclude` and global excludes. */
async function ignoredUnder(
  git: GitRunner,
  tree: string,
  paths: readonly string[],
  directory: string,
  label: string,
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const rules = join(directory, `${label}-rules`);
  await mkdir(rules);
  const env = { GIT_INDEX_FILE: join(directory, `${label}-index`), GIT_WORK_TREE: rules };
  if ((await invoke(git, ["read-tree", tree], { env })).code !== 0) return null;
  const files = await invoke(git, ["ls-files", "-z", "--", ":(glob)**/.gitignore"], { env });
  if (files.code !== 0) return null;
  if (files.stdout) {
    const written = await invoke(git, ["checkout-index", "-z", "--stdin"], {
      env,
      stdin: files.stdout,
    });
    if (written.code !== 0) return null;
  }
  const ignored = await invoke(git, ["check-ignore", "--no-index", "-z", "--stdin"], {
    env,
    stdin: paths.join("\0"),
  });
  if (ignored.error || (ignored.code !== 0 && ignored.code !== 1)) return null;
  return ignored.stdout.split("\0").filter(Boolean);
}

/** Snapshots omit ignored paths, so a path can be missing from a tree only
 *  because that tree's rules ignored it while the file stayed on disk.
 *  Restoring must leave such a path alone: deleting it destroys the user's
 *  ignored file (undoing a turn that un-ignored `.env`), and creating it
 *  collides with the file still on disk (redoing that turn). Returns the
 *  `--index-info` entries pinning those paths to their `sourceHash` state.
 *  Only a `.gitignore` change between the two trees can produce such a path,
 *  so every other restore costs one `diff-tree`. */
export async function shieldIgnoredPaths(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  directory: string,
): Promise<string[] | null> {
  const changes = await invoke(git, ["diff-tree", "-r", "-z", sourceHash, targetHash], {
    timeoutMs: RESTORE_TIMEOUT_MS,
  });
  if (changes.error || changes.code !== 0) return null;
  // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  // The source mode/sha of an added path are zeros, which `--index-info` reads
  // as "remove", so one entry format pins both directions.
  const fields = changes.stdout.split("\0");
  const deleted = new Map<string, string>();
  const added = new Map<string, string>();
  let rulesChanged = false;
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, , sourceSha, , status] = fields[index]!.slice(1).split(" ");
    const path = fields[index + 1]!;
    if (path === ".gitignore" || path.endsWith("/.gitignore")) rulesChanged = true;
    if (status === "D") deleted.set(path, `${sourceMode} ${sourceSha}`);
    else if (status === "A") added.set(path, `${sourceMode} ${sourceSha}`);
  }
  if (!rulesChanged || (deleted.size === 0 && added.size === 0)) return [];

  const keptOnDisk = await ignoredUnder(git, targetHash, [...deleted.keys()], directory, "target");
  const hiddenInSource = await ignoredUnder(
    git,
    sourceHash,
    [...added.keys()],
    directory,
    "source",
  );
  if (!keptOnDisk || !hiddenInSource) return null;
  const pinned = keptOnDisk.map((path) => `${deleted.get(path)}\t${path}\0`);
  if (hiddenInSource.length > 0) {
    const top = await invoke(git, ["rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return null;
    const worktree = top.stdout.trim();
    for (const path of hiddenInSource) {
      // Absent on disk means nothing to collide with: let the patch create it.
      const onDisk = await lstat(join(worktree, path)).then(
        () => true,
        () => false,
      );
      if (onDisk) pinned.push(`${added.get(path)}\t${path}\0`);
    }
  }
  return pinned;
}

/** `targetHash` with `pins` (`--index-info -z` entries) applied, or
 *  `targetHash` itself when there is nothing to pin. */
export async function pinnedTree(
  git: GitRunner,
  targetHash: string,
  pins: readonly string[],
  directory: string,
): Promise<string | null> {
  if (pins.length === 0) return targetHash;
  const env = { GIT_INDEX_FILE: join(directory, "pin-index") };
  if ((await invoke(git, ["read-tree", targetHash], { env })).code !== 0) return null;
  const updated = await invoke(git, ["update-index", "-z", "--index-info"], {
    env,
    stdin: pins.join(""),
  });
  if (updated.code !== 0) return null;
  const tree = await invoke(git, ["write-tree"], { env });
  const treeHash = tree.stdout.trim();
  return tree.code === 0 && treeHash ? treeHash : null;
}

export interface SnapshotsOutside extends OutsideSnapshot {
  /** `--index-info -z` entries pinning every unreadable file to its source
   *  entry (a removal when the source has none). */
  unreadablePins: string[];
  /** Both commits carry `AUTOCRLF_OFF_LINE`. */
  autocrlfOff: boolean;
}

/** Paths neither commit holds the contents of. Nested repositories: gitlinks
 *  (a submodule or committed nested repository is recorded as its HEAD commit
 *  only, and `git apply` without an index skips gitlink hunks) plus the ones a
 *  snapshot left out for having no commit. Unreadable files: a snapshot's
 *  entry for one is stale or missing, so the restore must leave the file on
 *  disk alone. Null when a commit is unreadable. Also reads how both commits
 *  were captured (`autocrlfOff`). The listings are streamed,
 *  so memory stays bounded by what is kept, not by the tree's size.
 *  ponytail: lists every tree entry per restore; record gitlinks at capture
 *  time if undo in million-file trees gets slow. */
export async function pathsOutsideSnapshots(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<SnapshotsOutside | null> {
  const nested = new Set<string>();
  const unreadable = new Set<string>();
  let autocrlfOff = true;
  for (const commit of [sourceHash, targetHash]) {
    const object = await invoke(git, ["cat-file", "commit", commit]);
    if (object.error || object.code !== 0) return null;
    const message = object.stdout.slice(object.stdout.indexOf("\n\n") + 2);
    const lines = message.split("\n");
    if (!lines.includes(AUTOCRLF_OFF_LINE)) autocrlfOff = false;
    for (const line of lines) {
      if (line.startsWith(NESTED_REPOSITORY_LINE)) {
        nested.add(line.slice(NESTED_REPOSITORY_LINE.length));
      } else if (line.startsWith(UNREADABLE_FILE_LINE)) {
        unreadable.add(line.slice(UNREADABLE_FILE_LINE.length));
      }
    }
  }
  const sourceEntries = new Map<string, string>();
  for (const commit of [sourceHash, targetHash]) {
    // Entries: "<mode> <type> <object>\t<path>", a format `--index-info` reads.
    let partial = "";
    const feed = (chunk: string) => {
      const entries = (partial + chunk).split("\0");
      partial = entries.pop()!;
      for (const entry of entries) {
        const path = entry.slice(entry.indexOf("\t") + 1);
        if (entry.startsWith("160000 ")) nested.add(path);
        if (commit === sourceHash && unreadable.has(path)) sourceEntries.set(path, entry);
      }
    };
    const tree = await invoke(git, ["ls-tree", "-r", "-z", "--full-tree", commit], {
      timeoutMs: RESTORE_TIMEOUT_MS,
      onStdout: feed,
    });
    if (tree.error || tree.code !== 0) return null;
    // A runner that ignores `onStdout` buffers instead; scanning twice is harmless.
    feed(`${tree.stdout}\0`);
  }
  // Mode 0 with an all-zero id of the repository's hash length removes a path.
  const removal = `0 ${"0".repeat(sourceHash.length)}`;
  return {
    nestedRepositories: [...nested].sort(),
    unreadableFiles: [...unreadable].sort(),
    unreadablePins: [...unreadable].map(
      (path) => `${sourceEntries.get(path) ?? `${removal}\t${path}`}\0`,
    ),
    autocrlfOff,
  };
}

/** `git apply --check` stderr (run under `LC_ALL=C`) lines that name a path:
 *  every failed hunk or binary patch ends in "<path>: patch does not apply";
 *  the other forms come from the worktree check of a path. */
const APPLY_CHECK_PATH = [
  /^error: (.+): (?:patch does not apply|already exists in working directory|wrong type|No such file or directory)$/,
  /^error: (.+) has type [0-7]+, expected [0-7]+$/,
];

/** The distinct paths `git apply --check` refused, in the order it named them. */
export function applyCheckPaths(stderr: string): string[] {
  const paths = new Set<string>();
  for (const line of stderr.split(/\r?\n/)) {
    for (const pattern of APPLY_CHECK_PATH) {
      const match = pattern.exec(line);
      if (match) {
        paths.add(match[1]);
        break;
      }
    }
  }
  return [...paths];
}

/** Paths `git apply` touches going from `sourceHash` to `targetHash`. Gitlinks
 *  are skipped: apply leaves them alone and `pathsOutsideSnapshots` reports
 *  them. Null when git fails. */
export async function changedPaths(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
): Promise<string[] | null> {
  const changes = await invoke(
    git,
    ["diff-tree", "-r", "-z", "--no-renames", sourceHash, targetHash],
    { timeoutMs: RESTORE_TIMEOUT_MS },
  );
  if (changes.error || changes.code !== 0) return null;
  // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  const fields = changes.stdout.split("\0");
  const paths: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, targetMode] = fields[index]!.slice(1).split(" ");
    if (sourceMode !== "160000" && targetMode !== "160000") paths.push(fields[index + 1]!);
  }
  return paths;
}
