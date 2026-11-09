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
  misplacedHunkPaths,
  pathsBeyondLinks,
} from "./restore-scope.js";

/** `nestedRepositories` and `unreadableFiles`: paths whose contents the
 *  restore could not touch, relative to the worktree root (see
 *  `pathsOutsideSnapshots`). `restoredFiles`: every path the restore wrote,
 *  created or deleted, relative to the worktree root. The snapshots cover the
 *  whole worktree, so this includes edits made during the turn by anyone
 *  else (an editor, another process), not only the agent's.
 *  `conflictedFiles`: the paths `git apply --check` refused or would have
 *  patched in the wrong place (see `misplacedHunkPaths`), relative to the
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
  // Deleted paths found on disk: on a case-insensitive file system possibly
  // only through an added case twin (see `caseTwinCreations`) that the
  // removal below takes away, leaving the source's file missing.
  const deleted: string[] = [];
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
    } else if (status === "D") {
      deleted.push(path);
    }
  }
  for (const path of (await pathsHoldingBlobs(git, written, config)) ?? []) {
    (added.has(path) ? remove : restore).push(path);
  }
  for (const path of remove) {
    await rm(join(worktree, path), { force: true }).catch(() => undefined);
  }
  if (remove.length > 0) {
    for (const path of deleted) {
      if (!(await lstat(join(worktree, path)).catch(() => null))) restore.push(path);
    }
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

/** Paths of `expected` whose worktree file, hashed under `config` and the
 *  attributes on disk, is the blob `expected` maps it to; null when git
 *  fails. */
async function pathsHoldingBlobs(
  git: GitRunner,
  expected: ReadonlyMap<string, string>,
  config: readonly string[],
): Promise<string[] | null> {
  const paths = [...expected.keys()];
  if (paths.length === 0) return [];
  // C-quote every line: git unquotes a line starting with `"` and dies on
  // the whole batch if that fails, and a raw newline would split a path.
  const quoted = paths.map(
    (path) => `"${path.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : `\\${c}`))}"`,
  );
  const hashed = await invoke(git, [...config, "hash-object", "--stdin-paths"], {
    stdin: `${quoted.join("\n")}\n`,
    timeoutMs: RESTORE_TIMEOUT_MS,
  });
  if (hashed.code !== 0 || hashed.error) return null;
  const ids = hashed.stdout.split("\n");
  return paths.filter((path, index) => ids[index] === expected.get(path));
}

/** A `.gitattributes` at any depth, in any case (the case-insensitive file
 *  systems of Windows and macOS serve it to git under any). */
const ATTRIBUTES_FILE = /(?:^|\/)\.gitattributes$/i;

/** Regular files of `targetHash` that `git apply` writes as exactly their
 *  `targetHash` blob: created ones (`apply --check` proved the path free) and
 *  modified ones whose worktree file still hashes to the `sourceHash` blob.
 *  A drifted file gets the hunks merged into the user's edits instead, which
 *  a checkout of the target would destroy. Run before apply, so the hash
 *  reads under the attributes on disk, as apply does. Null when git fails. */
async function exactRestorePaths(
  git: GitRunner,
  sourceHash: string,
  targetHash: string,
  config: readonly string[],
): Promise<string[] | null> {
  const changes = await invoke(
    git,
    ["diff-tree", "-r", "-z", "--no-renames", sourceHash, targetHash],
    { timeoutMs: RESTORE_TIMEOUT_MS },
  );
  if (changes.error || changes.code !== 0) return null;
  // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
  const exact: string[] = [];
  const modified = new Map<string, string>();
  const fields = changes.stdout.split("\0");
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [sourceMode, targetMode, sourceSha] = fields[index]!.slice(1).split(" ");
    const path = fields[index + 1]!;
    if (!targetMode!.startsWith("100") || sourceMode === "160000") continue;
    if (sourceMode!.startsWith("100")) modified.set(path, sourceSha!);
    else exact.push(path);
  }
  const unchanged = await pathsHoldingBlobs(git, modified, config);
  return unchanged && [...exact, ...unchanged];
}

/** Paths `targetHash` adds over `sourceHash` that, in `worktree`, are the
 *  same file as another path the restore changes: on a case-insensitive file
 *  system, the old name of a case-only rename. Comparing the files, not
 *  `core.ignorecase`, leaves a case-sensitive one (or a file the user put
 *  at the new name) to `git apply`'s own check. Null when git fails. */
async function caseTwinCreations(
  git: GitRunner,
  worktree: string,
  sourceHash: string,
  targetHash: string,
): Promise<string[] | null> {
  const changes = await invoke(
    git,
    ["diff-tree", "-r", "-z", "--no-renames", "--name-status", sourceHash, targetHash],
    { timeoutMs: RESTORE_TIMEOUT_MS },
  );
  if (changes.error || changes.code !== 0) return null;
  const fields = changes.stdout.split("\0");
  const byCase = new Map<string, string[]>();
  const added: string[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const path = fields[index + 1]!;
    if (fields[index] === "A") added.push(path);
    const key = path.toLowerCase();
    byCase.set(key, [...(byCase.get(key) ?? []), path]);
  }
  // An inode of 0 (some network file systems) identifies nothing.
  const identity = (path: string) =>
    lstat(join(worktree, path), { bigint: true }).then(
      (stats) => (stats.ino === 0n ? null : `${stats.dev}:${stats.ino}`),
      () => null,
    );
  const twins: string[] = [];
  for (const path of added) {
    const others = byCase.get(path.toLowerCase())!.filter((other) => other !== path);
    if (others.length === 0) continue;
    const file = await identity(path);
    if (!file) continue;
    for (const other of others) {
      if ((await identity(other)) === file) {
        twins.push(path);
        break;
      }
    }
  }
  return twins;
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
    const diffArgs = [
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
    ];
    const diff = await invoke(git, [...diffArgs, `--output=${patchPath}`], restore);
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
    // A case-insensitive file system serves a case-only rename's old file
    // under the new name, so `git apply` (which checks every created path
    // before deleting anything) reports it as "already exists". Those
    // creations go to a second patch applied once the first has deleted the
    // old file; checking only the first is complete: the created path is
    // the old file, whose deletion it checks.
    const deferred = await caseTwinCreations(git, worktree, sourceHash, effectiveTarget);
    if (!deferred) return "failed";
    let createPath: string | null = null;
    if (deferred.length > 0) {
      createPath = join(tempDirectory, "case-renames.patch");
      for (const [output, magic] of [
        [patchPath, "top,exclude,literal"],
        [createPath, "top,literal"],
      ] as const) {
        const pathspecs = deferred.map((path) => `:(${magic})${path}`);
        const split = await invoke(
          git,
          [...diffArgs, `--output=${output}`, "--", ...pathspecs],
          restore,
        );
        if (split.error || split.code !== 1) return "failed";
      }
    }

    const checkArgs = [
      ...config,
      "apply",
      "--whitespace=nowarn",
      "--no-ignore-whitespace",
      "--check",
    ];
    const checkOptions = { ...restore, env: { LC_ALL: "C" } };
    // `-v` reports every hunk git matched away from its recorded line.
    const verbose = await invoke(git, [...checkArgs, "-v", patchPath], checkOptions);
    // The probe index: see `misplacedHunkPaths` and the drift probe below.
    const probeEnv: Record<string, string> = {
      GIT_INDEX_FILE: join(tempDirectory, "probe-index"),
    };
    if (git.env?.GIT_DIR && git.cwd) probeEnv.GIT_WORK_TREE = git.cwd;
    if (verbose.code !== 0) {
      if (verbose.error) return "failed";
      // A failed `-v` check also prints the file lines a hunk searched for,
      // which `applyCheckPaths` would read as git's own messages.
      const check = await invoke(git, [...checkArgs, patchPath], checkOptions);
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
    const misplaced = await misplacedHunkPaths(
      git,
      sourceHash,
      patchPath,
      verbose.stderr,
      config,
      probeEnv,
    );
    if (!misplaced) return "failed";
    if (misplaced.length > 0) return { conflictedFiles: misplaced };

    if (checkOnly) return { restoredFiles };
    // `git apply` converts the files it writes under the attributes on disk
    // before the patch, so a restore that changes a `.gitattributes` wrote
    // them the source's way (CRLF where the target holds no `eol=crlf`), and
    // the next restore read them as drift. The files apply writes as exactly
    // the target's blob are checked out again from it, under the target's
    // attributes, as `git checkout` would write them. The index is seeded
    // before apply, so only the checkout can fail once the patch landed; an
    // edit landing between the hash and the checkout is overwritten.
    // ponytail: a drifted file keeps the source's conversion; re-convert the
    // merged blob (`apply --cached` on a scratch index) if that ever matters.
    const reconvert = restoredFiles.some((path) => ATTRIBUTES_FILE.test(path))
      ? await exactRestorePaths(git, sourceHash, effectiveTarget, config)
      : [];
    if (!reconvert) return "failed";
    const targetEnv: Record<string, string> = {
      GIT_INDEX_FILE: join(tempDirectory, "target-index"),
    };
    if (git.env?.GIT_DIR) targetEnv.GIT_WORK_TREE = worktree;
    if (reconvert.length > 0) {
      const seeded = await invoke(git, ["read-tree", effectiveTarget], { env: targetEnv });
      if (seeded.error || seeded.code !== 0) return "failed";
    }
    const applyArgs = [...config, "apply", "--whitespace=nowarn", "--no-ignore-whitespace"];
    let applied = await invoke(git, [...applyArgs, patchPath], restore);
    if (applied.code === 0 && createPath) {
      applied = await invoke(git, [...applyArgs, createPath], restore);
    }
    if (applied.code === 0) {
      if (reconvert.length === 0) return { restoredFiles };
      // Without stat data in the index every path is rewritten.
      const checkout = await invoke(git, [...config, "checkout-index", "-f", "-z", "--stdin"], {
        env: targetEnv,
        stdin: reconvert.map((path) => `${path}\0`).join(""),
        ...restore,
      });
      return !checkout.error && checkout.code === 0 ? { restoredFiles } : "failed";
    }
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
