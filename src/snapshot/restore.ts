import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitRunner } from "../types.js";
import { invoke, outputLines } from "../infra/git-runner.js";
import { debugLog } from "../infra/debug-log.js";
import { autocrlfSetting, autocrlfOffConfig } from "./markers.js";
import {
  pathsOutsideSnapshots,
  RESTORE_TIMEOUT_MS,
  shieldIgnoredPaths,
  pinnedTree,
  changedPaths,
  applyCheckPaths,
  pathsBeyondLinks,
} from "./restore-scope.js";

/** `nestedRepositories` and `unreadableFiles`: paths whose contents the
 *  restore could not touch, relative to the worktree root (see
 *  `pathsOutsideSnapshots`). `restoredFiles`: every path the restore wrote,
 *  created or deleted, relative to the worktree root. The snapshots cover the
 *  whole worktree, so this includes edits made during the turn by anyone
 *  else (an editor, another process), not only the agent's.
 *  `conflictedFiles`: the paths `git apply --check` refused, relative to the
 *  worktree root; empty when its output named none. `linkedFiles`: the paths
 *  the restore would reach through a symlink or junction in the worktree
 *  (see `pathsBeyondLinks`); nothing was written. */
export type CheckpointApplyResult =
  | {
      status: "applied";
      nestedRepositories: string[];
      unreadableFiles: string[];
      restoredFiles: string[];
    }
  | { status: "conflict"; conflictedFiles: string[] }
  | { status: "linked"; linkedFiles: string[] }
  | { status: "failed" };

/** Restores `targetHash`'s content over a worktree that currently matches
 *  `sourceHash`, via a patch instead of a checkout so the index is untouched.
 *  Nested repositories and unreadable files are outside the snapshots: the
 *  patch leaves them as they are, and an `applied` result lists them so the
 *  caller never reports their contents as restored. Worktree files are read
 *  and written the way the snapshots were captured: with `core.autocrlf` off
 *  (`autocrlfOffConfig`), or through it for snapshots of earlier versions.
 *  `checkOnly` stops after `git apply --check`: `applied` then means the
 *  restore would apply to the worktree as it is, and nothing was written.
 *  `ownedPaths`: the extension's directories inside the worktree
 *  (`ownedPathsInWorktree`); their paths keep their `sourceHash` state, so a
 *  snapshot taken before they were left out can never rewrite the store. */
export async function applyCheckpoint(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  checkOnly = false,
  ownedPaths: readonly string[] = [],
): Promise<CheckpointApplyResult> {
  // Read first: failing after the patch landed would misreport a restore.
  const outside = await pathsOutsideSnapshots(git, sourceHash, targetHash, ownedPaths);
  if (!outside) return { status: "failed" };
  const { nestedRepositories, unreadableFiles, unreadablePins, ownedPins } = outside;
  let config: string[] = [];
  if (outside.autocrlfOff) {
    const setting = await autocrlfSetting(git);
    if (!setting) return { status: "failed" };
    config = autocrlfOffConfig(setting);
  }
  const applied = await applyPatch(
    git,
    sourceHash,
    targetHash,
    [...unreadablePins, ...ownedPins],
    ownedPaths,
    config,
    checkOnly,
  );
  if (applied === "failed") return { status: "failed" };
  if ("conflictedFiles" in applied) return { status: "conflict", ...applied };
  if ("linkedFiles" in applied) return { status: "linked", ...applied };
  return { status: "applied", nestedRepositories, unreadableFiles, ...applied };
}

/** `git apply` without an index first deletes every path it modifies, then
 *  writes them back, so a failed write (locked file, full disk, killed child)
 *  leaves paths missing and the rest at target content. Undoes exactly what
 *  apply did, from `sourceHash` through a scratch index: paths it removed,
 *  paths it wrote (content equals the target blob), paths it left empty (a
 *  failed smudge filter) and paths it created (content equals the target
 *  blob). A path still holding other content is left alone: `apply --check`
 *  accepts drift outside the hunks, and overwriting it would destroy that
 *  edit; a file created at an added path after `apply --check` makes apply
 *  fail before writing anything, and deleting it would destroy that file.
 *  The hash and the checkout run with apply's `config`, so they convert
 *  exactly as apply did (clean filters, CRLF under `core.autocrlf` for
 *  snapshots of earlier versions) while tree blobs hold the cleaned form.
 *  Best effort: gitlinks are never touched by apply; symlinks, typechanges
 *  and a directory sitting where a deleted file was are left as found, as is
 *  an added file apply wrote partially or left empty. The hash-then-checkout
 *  window cannot be locked, so an edit landing inside it is overwritten. */
async function rollbackPartialApply(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  directory: string,
  config: readonly string[],
): Promise<void> {
  const worktree = git.cwd;
  if (!worktree) return;
  const timeoutMs = RESTORE_TIMEOUT_MS;
  const changes = await invoke(
    git,
    ["diff-tree", "-r", "-z", "--no-renames", sourceHash, targetHash],
    { timeoutMs },
  );
  if (changes.error || changes.code !== 0) return;

  // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  const restore: string[] = [];
  const remove: string[] = [];
  const written = new Map<string, string>();
  const added = new Set<string>();
  const fields = changes.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, targetMode, , targetSha, status] = fields[index]!.slice(1).split(" ");
    const path = fields[index + 1]!;
    if (sourceMode === "160000" || targetMode === "160000") continue;
    const present = await lstat(join(worktree, path)).catch(() => null);
    if (status === "A") {
      // Apply writes nothing when an added path already exists, so a file
      // there is apply's only if it holds the target blob. Anything else,
      // even an empty file (a failed smudge, as below, or a user's lock or
      // marker file), may have been created after `apply --check`: kept.
      if (present?.isFile()) {
        written.set(path, targetSha!);
        added.add(path);
      }
    } else if (!present) {
      restore.push(path);
    } else if (status !== "D" && present.isFile() && present.size === 0) {
      // Apply creates a file before converting its content, so a failed
      // smudge filter (Git LFS missing an object) leaves it empty. `apply
      // --check` proved the path held its hunks' preimage, so an empty file
      // is apply's write or an empty source: restoring the source is safe.
      restore.push(path);
    } else if (status !== "D" && present.isFile()) {
      written.set(path, targetSha!);
    }
  }
  if (written.size > 0) {
    const paths = [...written.keys()];
    // C-quote every line: git unquotes a line starting with `"` and dies on
    // the whole batch if that fails, and a raw newline would split a path.
    const quoted = paths.map(
      (path) => `"${path.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`))}"`,
    );
    const hashed = await invoke(git, [...config, "hash-object", "--stdin-paths"], {
      stdin: `${quoted.join("\n")}\n`,
      timeoutMs,
    });
    if (hashed.code === 0 && !hashed.error) {
      const ids = hashed.stdout.split("\n");
      paths.forEach((path, index) => {
        if (ids[index] !== written.get(path)) return;
        (added.has(path) ? remove : restore).push(path);
      });
    }
  }
  for (const path of remove) {
    await rm(join(worktree, path), { force: true }).catch(() => undefined);
  }
  if (restore.length === 0) return;

  const env: Record<string, string> = { GIT_INDEX_FILE: join(directory, "rollback-index") };
  if (git.env?.GIT_DIR) env.GIT_WORK_TREE = worktree;
  if ((await invoke(git, ["read-tree", sourceHash], { env })).code !== 0) return;
  await invoke(git, [...config, "checkout-index", "-f", "-z", "--stdin"], {
    env,
    stdin: restore.map((path) => `${path}\0`).join(""),
    timeoutMs,
  });
}

/** Every flag pins the plumbing contract against the user's own
 *  configuration, each of which otherwise kills restoration outright on that
 *  machine: `diff.noprefix`/`diff.srcPrefix`/`diff.dstPrefix` produce a patch
 *  `git apply -p1` cannot resolve; `color.diff=always` prefixes it with ANSI
 *  escapes ("No valid patches in input"); `diff.external` and textconv
 *  filters replace it with another program's output; `diff.submodule=log`
 *  replaces a gitlink hunk with a commit listing, which invalidates the whole
 *  patch; `diff.context=0` yields hunks `git apply` refuses without
 *  `--unidiff-zero`; `apply.whitespace=error` rejects content git itself
 *  snapshotted; `apply.ignoreWhitespace=change` lets a hunk match lines the
 *  user re-indented and silently writes the old whitespace back over them.
 *  `config`: `-c` args for every command that reads or writes
 *  worktree files (see `applyCheckpoint`). `pins`: `--index-info -z` entries
 *  applied over `targetHash`. */
async function applyPatch(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  pins: readonly string[],
  ownedPaths: readonly string[],
  config: readonly string[],
  checkOnly: boolean,
): Promise<
  { restoredFiles: string[] } | { conflictedFiles: string[] } | { linkedFiles: string[] } | "failed"
> {
  let tempDirectory: string | null = null;
  try {
    tempDirectory = await mkdtemp(join(tmpdir(), "omp-undo-redo-patch-"));
    const patchPath = join(tempDirectory, "checkpoint.patch");
    const restore = { timeoutMs: RESTORE_TIMEOUT_MS };
    const ignoredPins = await shieldIgnoredPaths(git, sourceHash, targetHash, tempDirectory);
    if (!ignoredPins) return "failed";
    const effectiveTarget = await pinnedTree(
      git,
      targetHash,
      [...ignoredPins, ...pins],
      tempDirectory,
    );
    if (!effectiveTarget) return "failed";
    const diff = await invoke(
      git,
      [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--ignore-submodules=none",
        "--submodule=short",
        "-U3",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "--exit-code",
        "--binary",
        sourceHash,
        effectiveTarget,
        `--output=${patchPath}`,
      ],
      restore,
    );
    // A killed or unspawnable child also exits 1, which is `--exit-code`'s
    // "there were differences": without this the truncated patch `--output`
    // already wrote would be applied and reported as a complete restore.
    if (diff.error) return "failed";
    if (diff.code === 0) return { restoredFiles: [] };
    if (diff.code !== 1) return "failed";
    // Listed before applying: failing after the patch landed would misreport.
    const restoredFiles = await changedPaths(git, sourceHash, effectiveTarget);
    if (!restoredFiles) return "failed";
    // Before `--check` too: recovery's check-only probe must not call such a
    // restore applicable. A runner from a host's `gitRunnerFactory` may carry
    // no cwd: git then names the worktree. A scan of the disk as it is now: a
    // link created between here and `git apply` is not caught (git's own
    // guard still covers real symlinks).
    let worktree = git.cwd;
    if (!worktree) {
      const top = await invoke(git, ["rev-parse", "--show-toplevel"]);
      worktree = top.code === 0 && !top.error ? outputLines(top.stdout)[0] : "";
      if (!worktree) return "failed";
    }
    const linked = await pathsBeyondLinks(worktree, restoredFiles);
    if (linked.length > 0) return { linkedFiles: linked };

    const check = await invoke(
      git,
      [...config, "apply", "--whitespace=nowarn", "--no-ignore-whitespace", "--check", patchPath],
      {
        ...restore,
        env: { LC_ALL: "C" },
      },
    );
    if (check.code !== 0) {
      if (check.error) return "failed";
      // `apply --check` failing does not prove the worktree drifted: a patch
      // git cannot parse fails identically. When the worktree still matches
      // the source snapshot, the patch is at fault — report that instead of
      // blaming the worktree and sending the user to clean an already clean
      // one.
      //
      // The probe runs against its own index seeded from `sourceHash`, never
      // the repository's: a private repo never writes its index at all (its
      // snapshots use alternates), so `git diff <commit>` there reports every
      // path as deleted, and a user's real index may carry staged adds or
      // deletes that are not worktree drift. `read-tree` records no stat data,
      // so the comparison must fall back to content — which is what
      // `diff.autoRefreshIndex` controls, hence pinning it. Reading the
      // worktree side is the one restore step `core.safecrlf` reaches (apply,
      // `hash-object` without `-w` and `checkout-index` never consult it):
      // pinned off as in `addWorktree`, so a text attribute cannot buffer one
      // warning per file. The extension's own directories are left out: their
      // files drift every turn, and an old snapshot holding them would always
      // read as a conflict.
      const probeEnv: Record<string, string> = {
        GIT_INDEX_FILE: join(tempDirectory, "probe-index"),
      };
      if (git.env?.GIT_DIR && git.cwd) probeEnv.GIT_WORK_TREE = git.cwd;
      const seeded = await invoke(git, ["read-tree", sourceHash], { env: probeEnv });
      if (seeded.error || seeded.code !== 0) return "failed";
      const tracked = await invoke(
        git,
        [
          ...config,
          "-c",
          "core.safecrlf=false",
          "-c",
          "diff.autoRefreshIndex=true",
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--quiet",
          sourceHash,
          "--",
          ...ownedPaths.map((path) => `:(top,exclude,literal)${path}`),
        ],
        { env: probeEnv, timeoutMs: RESTORE_TIMEOUT_MS },
      );
      if (tracked.error) return "failed";
      const conflict = { conflictedFiles: applyCheckPaths(check.stderr) };
      if (tracked.code !== 0) return conflict;
      if (check.stderr.includes("already exists in working directory")) return conflict;
      return "failed";
    }

    if (checkOnly) return { restoredFiles };
    const applied = await invoke(
      git,
      [...config, "apply", "--whitespace=nowarn", "--no-ignore-whitespace", patchPath],
      restore,
    );
    if (applied.code === 0) return { restoredFiles };
    await rollbackPartialApply(git, sourceHash, effectiveTarget, tempDirectory, config).catch(
      (error: unknown) => debugLog({ event: "restore-rollback-failed", error: String(error) }),
    );
    return "failed";
  } catch (error) {
    debugLog({ event: "restore-failed", error: String(error) });
    return "failed";
  } finally {
    if (tempDirectory !== null) {
      await rm(tempDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
