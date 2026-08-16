import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { sha256 } from "./fs.js";

/** Mutual exclusion for the blob store. Two layers that must always be
 *  taken together:
 *  - an in-process promise chain per lock key (`withWorkspaceLock`), and
 *  - a cross-process filesystem lock directory under `<store>/locks/`
 *    (`acquireFilesystemLock`) that also reaps locks left behind by
 *    crashed owners on the same host.
 *
 *  `withStoreLock` guards whole-store agreement (refs/manifests, GC);
 *  `withWorkspaceMutex` guards one workspace's capture/apply phases. */

export class StoreLocks {
  private readonly rootDirectory: string;
  private readonly ownerId: string;
  private readonly locks = new Map<string, Promise<void>>();

  constructor(rootDirectory: string, ownerId: string) {
    this.rootDirectory = rootDirectory;
    this.ownerId = ownerId;
  }

  private async acquireFilesystemLock(name: string): Promise<() => Promise<void>> {
    const lockPath = join(this.rootDirectory, "locks", `${sha256(name)}.lock`);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(
            join(lockPath, "owner.json"),
            JSON.stringify({ pid: process.pid, hostname: hostname(), ownerId: this.ownerId }),
            { mode: 0o600 },
          );
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        return async () => {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
            pid?: number;
            hostname?: string;
          };
          if (owner.hostname === hostname() && typeof owner.pid === "number") {
            try {
              process.kill(owner.pid, 0);
            } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
                await rm(lockPath, { recursive: true, force: true });
                continue;
              }
            }
          }
        } catch {
          // A process can crash between mkdir and owner publication. Reap only an old,
          // ownerless lock; a live publisher gets a generous completion window.
          try {
            const metadata = await stat(lockPath);
            if (Date.now() - metadata.mtimeMs > 30_000) {
              await rm(lockPath, { recursive: true, force: true });
              continue;
            }
          } catch {
            continue;
          }
        }
        if (Date.now() >= deadline) throw new Error("blob store lock timeout");
        await delay(25);
      }
    }
  }

  /** Serializes operations per lock key within this process via a promise
   *  chain, so concurrent callers queue instead of interleaving. */
  private async withWorkspaceLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(root) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = prior.then(() => current);
    this.locks.set(root, tail);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(root) === tail) this.locks.delete(root);
    }
  }

  async withStoreLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withWorkspaceLock(`store:${this.rootDirectory}`, async () => {
      const release = await this.acquireFilesystemLock(`store:${this.rootDirectory}`);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }

  /** Serializes workspace-mutating phases (capture walks and applies) both
   *  within this process (promise chain) and across processes (filesystem
   *  lock). Scoped to one workspace, so a slow capture in one workspace never
   *  blocks another workspace — the store lock is reserved for ref/manifest
   *  publication and GC, which the whole store must agree on. */
  async withWorkspaceMutex<T>(root: string, operation: () => Promise<T>): Promise<T> {
    return this.withWorkspaceLock(root, async () => {
      const release = await this.acquireFilesystemLock(`workspace:${root}`);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }
}
