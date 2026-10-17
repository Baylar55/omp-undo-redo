import { rename } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import type {
  CwdGitRunnerFactory,
  DiscoveredRepository,
  GitRepository,
  GitRunner,
} from "../types.js";
import { pathInside, runtimeRootDirectory, storeRootDirectory } from "../infra/paths.js";
import { RETRY_DELAY_MS } from "../infra/fs.js";
import { debugLog } from "../infra/debug-log.js";
import {
  privateRepositoryPath,
  ensureReposDirectory,
  setUpStore,
  applyConfig,
  readStoreConfig,
  storeHasRefs,
} from "./setup.js";

/** Config key naming the repository a Git-mode store belongs to (its
 *  `commonDir`); eviction treats the store as abandoned once that path is gone. */
export const GIT_STORE_SOURCE_KEY = "omp-undo-redo.commondir";

/** Ensures the bare snapshot store for a Git repository:
 *  `<storeRoot>/repos/<sha256(commonDir)>.git`, shared by linked worktrees the
 *  way their `.git` is. Snapshot commands still run against the user's
 *  repository (its HEAD, config, ignore and attribute rules) with
 *  `GIT_OBJECT_DIRECTORY` pointed here, so new objects land in the store,
 *  and `GIT_ALTERNATE_OBJECT_DIRECTORIES` pointed at the user's objects,
 *  which are borrowed rather than copied (see `snapshotRunnerEnv`). No
 *  `objects/info/alternates` file: a command run without that env sees only
 *  the store's own objects, which is how capture finds what it must copy.
 *  Refs are written with `GIT_DIR` set to the store. A store whose setup was
 *  abandoned is redone (see `setupState`); one that cannot be is used as
 *  found. Returns the store path, or null when a new one cannot be created. */
export async function ensureGitSnapshotStore(
  gitRunnerFactory: CwdGitRunnerFactory,
  repository: DiscoveredRepository,
  storeRoot: string,
): Promise<string | null> {
  const storeDir = privateRepositoryPath(storeRoot, repository.commonDir);
  const storeGit = gitRunnerFactory(repository.worktree, { GIT_DIR: storeDir });
  // Objects written against the user's repository use its hash, so the store
  // must too or its refs could not name them. Exit 1 is "not set", which is
  // SHA-1; any other failure is "cannot tell" (null) and never picks one.
  const repositoryFormat = async (): Promise<string | null> => {
    const format = await gitRunnerFactory(repository.worktree, {
      GIT_DIR: repository.commonDir,
    })(["config", "--get", "extensions.objectformat"]);
    if (format.error) return null;
    if (format.code === 1) return "sha1";
    return (format.code === 0 && format.stdout.trim()) || null;
  };
  try {
    await ensureReposDirectory(dirname(storeDir), storeRoot);
    // Earlier versions gave a SHA-1 repository a SHA-256 store under a sha256
    // `init.defaultObjectFormat`/`GIT_DEFAULT_HASH`. No ref could ever be
    // written to it, so it is renamed aside as eviction trash (reaped after
    // 7 days) and set up again. Only a store declaring a non-SHA-1 format is
    // checked: no version made a SHA-1 store for a SHA-256 repository while
    // it could read the repository's format, and a failed read now stops setup.
    const storeFormat = (await readStoreConfig(storeDir))?.get("extensions.objectformat");
    if (storeFormat && storeFormat !== "sha1") {
      const expected = await repositoryFormat();
      if (expected && expected !== storeFormat) {
        // Unreadable refs count as refs: never move a store on a guess.
        const hasRefs = await storeHasRefs(storeDir).catch(() => null);
        let outcome = hasRefs === null ? "refs-unreadable" : "has-refs";
        let attempts = 0;
        if (hasRefs === false) {
          // Each try first re-reads the store, which a concurrent launch may
          // have replaced; tries repeat while Windows refuses the read or the
          // rename (a scanner holding a file of the store).
          while (attempts < 5) {
            if (attempts > 0) await sleep(RETRY_DELAY_MS);
            attempts += 1;
            const config = await readStoreConfig(storeDir);
            if (config === null) {
              outcome = "config-unreadable";
              continue;
            }
            if (config.get("extensions.objectformat") !== storeFormat) {
              outcome = "replaced";
              break;
            }
            try {
              await rename(storeDir, `${storeDir}.evicted-${Date.now()}`);
              outcome = "moved";
              break;
            } catch (error) {
              outcome = (error as NodeJS.ErrnoException).code ?? "rename-failed";
              if (!["EPERM", "EACCES", "EBUSY"].includes(outcome)) break;
            }
          }
        }
        debugLog({
          event: "store-format-repair",
          storeDir,
          storeFormat,
          expected,
          outcome,
          attempts,
        });
      }
    }
    const ready = await setUpStore(
      storeDir,
      async () => {
        // The env pins the hash over the user's `init.defaultObjectFormat`
        // and `GIT_DEFAULT_HASH`; git before 2.29 ignores it and only knows SHA-1.
        const objectFormat = await repositoryFormat();
        if (!objectFormat) return false;
        const init = await storeGit(["init", "--bare", "-q"], {
          env: { GIT_DEFAULT_HASH: objectFormat },
        });
        return init.code === 0;
      },
      () =>
        applyConfig(storeGit, [
          ["core.sharedRepository", "0600"],
          // Only the extension's own git reads these refs, so paths past
          // MAX_PATH cannot hide them from anyone's gc.
          ["core.longpaths", "true"],
          // Last: `setupFinished` reads it as proof the rest ran.
          [GIT_STORE_SOURCE_KEY, repository.commonDir],
        ]),
    );
    return ready ? storeDir : null;
  } catch {
    return null;
  }
}

/** A Git-mode store borrows the user's objects instead of copying them. */
export function borrowsObjects(repository: GitRepository): boolean {
  return repository.storeDir !== repository.gitDir;
}

/** The extension's own directories inside `repository`'s worktree
 *  (`/`-separated): the store root, the `repos/` dir holding every store, and
 *  the runtime root, each from where it is written. A home directory that is a
 *  Git repository, or `OMP_UNDO_REDO_STORE_DIR`/`OMP_UNDO_REDO_RUNTIME_DIR` set
 *  inside one, puts them there: snapshots must leave them out and restores
 *  leave them alone, or each snapshot captures the store's own objects and an
 *  undo deletes the ones its target still needs. `repos/` covers a store root
 *  that is the worktree itself (`OMP_UNDO_REDO_RUNTIME_DIR=<repo>/runtime`),
 *  which no path inside it can name. Nested entries are harmless: every
 *  consumer takes their union.
 *  shortcut: a runtime root that is the worktree itself stays captured (its
 *  `<pid>/` dirs have no fixed name); exclude those by pattern if it is ever seen. */
export function ownedPathsInWorktree(repository: GitRepository): string[] {
  return [storeRootDirectory(), dirname(repository.storeDir), runtimeRootDirectory()]
    .map((path) => pathInside(repository.worktree, path))
    .filter((path) => path !== null);
}

function userObjects(repository: GitRepository): string {
  return join(repository.commonDir, "objects");
}

/** Env binding a runner to `repository`'s snapshot store. Private-Git runs
 *  every command inside the private repo; Git mode keeps the user's
 *  repository (HEAD, config, ignore rules), writes objects to the store and
 *  reads the user's through `GIT_ALTERNATE_OBJECT_DIRECTORIES`, so snapshot
 *  objects never enter the user's object store. Clean filters still run in
 *  the user's repository: Git LFS writes to its LFS storage (README). */
export function snapshotRunnerEnv(repository: GitRepository): Record<string, string> {
  return borrowsObjects(repository)
    ? {
        GIT_OBJECT_DIRECTORY: join(repository.storeDir, "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: userObjects(repository),
      }
    : { GIT_DIR: repository.storeDir };
}

/** Inverse of `snapshotRunnerEnv`: the store `git` is bound to, if any. */
export function boundStore(git: GitRunner): string | undefined {
  const objects = git.env?.GIT_OBJECT_DIRECTORY;
  return objects ? dirname(objects) : git.env?.GIT_DIR;
}

/** Env for commands run inside the store: snapshot refs, and its `gc`,
 *  which must read the objects a Git-mode store borrows. */
export function storeEnv(repository: GitRepository): Record<string, string> {
  return borrowsObjects(repository)
    ? { GIT_DIR: repository.storeDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: userObjects(repository) }
    : { GIT_DIR: repository.storeDir };
}
