import { realpath } from "node:fs";
import { readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { refusedPrivateWorkspace } from "../private-store.js";
import type { CwdGitRunnerFactory } from "../../types.js";
import { canonicalCwd, storeRootDirectory } from "../../infra/paths.js";
import { RETRY_DELAY_MS, removeDirWithRetry } from "../../infra/fs.js";
import { setupFinished, storeHasRefs } from "../setup.js";
import { GIT_STORE_SOURCE_KEY } from "../git-store.js";

/** `fs/promises` has no `realpath.native`; only native expands 8.3 short names. */
const nativeRealpath = promisify(realpath.native);

/** How long a snapshot repo must sit untouched before its workspace's
 *  disappearance counts as abandonment rather than a transient mount or
 *  lock hiccup (offline SMB/NFS volume, AV scan, temporarily renamed dir). */
const EVICTION_IDLE_CUTOFF_MS = 24 * 60 * 60 * 1000;

/** Evicted repos are renamed aside as recoverable trash and kept this long
 *  before any bytes are removed. */
const EVICTION_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Newest mtime across `dir` and its direct children. Git writes land in
 *  descendants (logs, packs, COMMIT_EDITMSG), not necessarily the root, so
 *  the root mtime alone under-reports recent activity. Returns null when
 *  freshness cannot be determined; callers must then not evict. */
async function lastActivityMs(dir: string): Promise<number | null> {
  let newest: number | null = null;
  const consider = (ms: number): void => {
    if (newest === null || ms > newest) newest = ms;
  };
  try {
    consider((await stat(dir)).mtimeMs);
  } catch {
    return null;
  }
  let children: string[];
  try {
    children = await readdir(dir);
  } catch {
    return newest;
  }
  await Promise.all(
    children.map(async (name) => {
      try {
        consider((await stat(join(dir, name))).mtimeMs);
      } catch {
        // Ignore
      }
    }),
  );
  return newest;
}

/** Path whose disappearance means a store is abandoned: a private repo's
 *  `core.worktree` (its workspace) or a Git store's source `commonDir`; null
 *  when neither is readable. Git decodes the value: it quotes values
 *  containing `#`/`;` and escapes `\`/`"`, so a raw regex over the file
 *  yields a path that never stats (e.g. "C:\\…\\C# Projects") and evicts
 *  live history. */
export async function storeSource(
  reposDir: string,
  gitDir: string,
  gitRunnerFactory: CwdGitRunnerFactory,
): Promise<{ path: string; gitStore: boolean } | null> {
  // One spawn for both keys; `-z` keeps decoded values intact. Last value
  // wins, as with `--get`; `core.worktree` wins over the source key.
  const result = await gitRunnerFactory(reposDir)([
    "config",
    "--file",
    join(gitDir, "config"),
    "-z",
    "--get-regexp",
    `^(core\\.worktree|${GIT_STORE_SOURCE_KEY.replaceAll(".", "\\.")})$`,
  ]);
  if (result.code !== 0) return null;
  const values = new Map<string, string>();
  for (const entry of result.stdout.split("\0")) {
    const newline = entry.indexOf("\n");
    if (newline > 0) values.set(entry.slice(0, newline), entry.slice(newline + 1));
  }
  const worktree = values.get("core.worktree");
  if (worktree) return { path: worktree, gitStore: false };
  const source = values.get(GIT_STORE_SOURCE_KEY);
  return source ? { path: source, gitStore: true } : null;
}

/** Removes snapshot stores whose workspace (Private-Git) or repository (Git
 *  mode) no longer exists. Runs at boot and on shutdown so vanished
 *  workspaces cannot leave their snapshots (and the file contents inside
 *  them) behind forever.
 *
 *  Deliberately conservative: eviction requires the workspace stat to fail
 *  with ENOENT/ENOTDIR twice (re-checked after a delay, so a single mount
 *  or AV hiccup cannot trigger it), the repo to be idle past
 *  EVICTION_IDLE_CUTOFF_MS, nothing touching snapshot repos to be in
 *  flight, and even then the repo is only renamed aside as `.evicted-<ts>`
 *  trash for EVICTION_TRASH_RETENTION_MS instead of being deleted outright.
 *  A store whose setup never finished names no source; it is evicted on
 *  idleness alone, and only while it holds no refs. A private store of a
 *  workspace `refusedPrivateWorkspace` rejects is evicted on idleness alone. */
export async function evictStalePrivateRepos(
  gitRunnerFactory: CwdGitRunnerFactory,
  busy: () => boolean,
): Promise<void> {
  const reposDir = join(canonicalCwd(storeRootDirectory()), "repos");
  let entries: string[];
  try {
    entries = await readdir(reposDir);
  } catch {
    return;
  }

  // Defer when work touching snapshot repos is in flight (captures,
  // finalizes, undo/redo): git children may still be writing into them.
  // Whatever is left behind is revisited by the next boot or shutdown
  // sweep. Registered-but-idle sessions are deliberately NOT a guard:
  // the shutdown sweep exists to evict exactly those once drained.
  if (busy()) return;

  const now = Date.now();
  for (const entry of entries) {
    const path = join(reposDir, entry);
    const trashMatch = /\.evicted-(\d+)$/.exec(entry);
    if (trashMatch) {
      // Trash from an earlier sweep. Retention is stamped in the name
      // because rename preserves mtime.
      if (now - Number(trashMatch[1]) >= EVICTION_TRASH_RETENTION_MS) {
        await removeDirWithRetry(path);
      }
      continue;
    }
    if (!entry.endsWith(".git")) continue;
    try {
      // A running `git gc` (ours or external) is actively rewriting this
      // repo; touching it now would race the child. gc removes the pid
      // file when it exits, so a lingering one means the child was killed
      // hard — but only a RECENT pidfile is trusted as "live": one older
      // than the idle cutoff is crash debris and must not block eviction
      // forever. A real gc on these repos finishes well inside that
      // window; a genuinely long child just fails the rename below and is
      // retried by a later sweep.
      try {
        const gcPidStat = await stat(join(path, "gc.pid"));
        if (now - gcPidStat.mtimeMs < EVICTION_IDLE_CUTOFF_MS) continue;
      } catch {
        // No pidfile.
      }
      const found = await storeSource(reposDir, path, gitRunnerFactory);
      if (found) {
        const source = found.path;
        const vanished = async (): Promise<boolean> => {
          try {
            await stat(source);
            return false;
          } catch (err) {
            const code = (err as NodeJS.ErrnoException | undefined)?.code;
            // Anything else (EACCES, EBUSY, EIO, EMFILE...) means "cannot
            // tell", which must never be read as "gone".
            return code === "ENOENT" || code === "ENOTDIR";
          }
        };
        // A private store of a refused workspace (left by an earlier
        // version) is never used again, so it counts as abandoned. v1.5.0
        // and v1.5.1 wrote `core.worktree` through non-native realpath,
        // which keeps Windows 8.3 short names, so it is resolved again
        // here. Async: a dead network mount then stalls a threadpool
        // thread, as `vanished` would, never the event loop.
        const refused =
          !found.gitStore &&
          refusedPrivateWorkspace(await nativeRealpath(source).catch(() => source));
        if (!refused) {
          if (!(await vanished())) continue;
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
          if (!(await vanished())) continue;
        }
      } else if ((await setupFinished(path)) !== false || (await storeHasRefs(path))) {
        // No source to stat. Only a setup that never wrote its marker (a
        // crash or stale config.lock after `git init`) and holds no
        // snapshots is evicted: nothing else would ever name it again if
        // its workspace never relaunches.
        // ponytail: an unfinished Git-mode store that already has refs is
        // kept until its repository relaunches; its source is unknowable.
        continue;
      }
      const lastActivity = await lastActivityMs(path);
      if (lastActivity === null || now - lastActivity < EVICTION_IDLE_CUTOFF_MS) continue;
      const trashPath = `${path}.evicted-${now}`;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rename(path, trashPath);
          break;
        } catch {
          if (attempt === 4) break; // Stranded until a later sweep.
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
      }
    } catch {
      // Unreadable repo: leave it for a later sweep.
    }
  }
}
