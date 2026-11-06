import { realpath } from "node:fs";
import { readdir, rename, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { promisify } from "node:util";
import { refusedPrivateWorkspace } from "../private-store.js";
import type { CwdGitRunnerFactory } from "../../types.js";
import { canonicalCwd, storeRootDirectory } from "../../infra/paths.js";
import { RETRY_DELAY_MS, removeDirWithRetry } from "../../infra/fs.js";
import {
  STORE_HOST_KEY,
  STORE_VOLUME_KEY,
  readStoreConfig,
  setupFinished,
  storeHasRefs,
} from "../setup.js";
import { GIT_STORE_SOURCE_KEY } from "../git-store.js";
import { localStoreHost } from "../host-identity.js";

/** `fs/promises` has no `realpath.native`; only native expands 8.3 short names. */
const nativeRealpath = promisify(realpath.native);

/** How long a snapshot repo must sit untouched before its workspace's
 *  disappearance counts as abandonment rather than a transient mount or
 *  lock hiccup (offline SMB/NFS volume, AV scan, temporarily renamed dir). */
const EVICTION_IDLE_CUTOFF_MS = 24 * 60 * 60 * 1000;

/** Evicted repos are renamed aside as recoverable trash and kept this long
 *  before any bytes are removed. */
const EVICTION_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Newest mtime across `dir`, its direct children, and the owner leases and
 *  session heartbeats under `omp-undo-redo/`. Git writes land in descendants
 *  (logs, packs, COMMIT_EDITMSG), not necessarily the root, so the root mtime
 *  alone under-reports recent activity; a live owner that takes no turns only
 *  beats its lease (hourly) and heartbeat, two levels down. Returns null when
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
  let unknown = false;
  const scan = async (parent: string): Promise<void> => {
    let children: string[];
    try {
      children = await readdir(parent);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") unknown = true;
      return;
    }
    await Promise.all(
      children.map(async (name) => {
        try {
          consider((await stat(join(parent, name))).mtimeMs);
        } catch (err) {
          // Gone since the listing (a temp renamed into place) is no beat;
          // anything else (EBUSY, EPERM, EIO) may hide a fresh one.
          const code = (err as NodeJS.ErrnoException).code;
          if (code !== "ENOENT" && code !== "ENOTDIR") unknown = true;
        }
      }),
    );
  };
  await Promise.all(
    [dir, join(dir, "omp-undo-redo", "owners"), join(dir, "omp-undo-redo", "history")].map(scan),
  );
  return unknown ? null : newest;
}

/** Whether the volume `source` was on is present, so that its absence means
 *  the source is gone: an unplugged drive, a disconnected mapped drive or an
 *  unmounted mount point also reads ENOENT. `volume` is the store's
 *  `STORE_VOLUME_KEY`: the mount root is that many levels above `source`, and
 *  is mounted when it holds another device than its parent (an empty mount
 *  point does not) or is a filesystem root that exists. */
async function volumePresent(source: string, volume: string | undefined): Promise<boolean> {
  const recorded = /^(\d+):(\d+)$/.exec(volume ?? "");
  let root = source;
  if (recorded) {
    for (let levels = Number(recorded[2]); levels > 0; levels -= 1) root = dirname(root);
  } else {
    // Set up by an earlier version: only the filesystem root can be checked.
    // A path of another platform (`C:\…` on POSIX, `/…` on Windows) is never
    // gone here.
    root = parse(source).root;
    if (!isAbsolute(source) || (process.platform === "win32" && root.length < 3)) return false;
  }
  try {
    const own = await stat(root);
    // On Windows the device is the volume serial: another volume given the
    // same drive letter is not this one. POSIX device numbers can change
    // across reboots (btrfs, NFS, disk order), so only the mount check runs.
    if (recorded && process.platform === "win32" && String(own.dev) !== recorded[1]) return false;
    const parent = dirname(root);
    return parent === root || own.dev !== (await stat(parent)).dev;
  } catch {
    return false;
  }
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
 *  workspace `refusedPrivateWorkspace` rejects is evicted on idleness alone.
 *  A store stamped by another machine (`STORE_HOST_KEY`) is that machine's
 *  to judge and is never evicted here; an unstamped one (set up by an earlier
 *  version and not opened since) is judged as before. */
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
  const host = await localStoreHost();
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
      // Another machine's store: whether its source exists, and whether it
      // is a refused workspace, only that machine can tell. An unreadable
      // config hides the stamp, so the store is kept.
      const config = await readStoreConfig(path);
      if (config === null) continue;
      const storeHost = config.get(STORE_HOST_KEY);
      if (storeHost !== undefined && storeHost !== host) continue;
      const volume = config.get(STORE_VOLUME_KEY);
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
            if (code !== "ENOENT" && code !== "ENOTDIR") return false;
          }
          // Stamped by this version without a volume (unreadable at setup):
          // an unplugged drive cannot be told from a deleted source, so it is
          // kept until a launch records one. Unstamped: judged as before.
          if (storeHost !== undefined && volume === undefined) return false;
          return volumePresent(source, volume);
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
