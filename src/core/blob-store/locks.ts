import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalPath, canonicalPathSync, sha256 } from "./fs.js";

const LOCK_HEARTBEAT_MS = 5_000;
const LOCK_LOCAL_STALE_MS = 30_000;
const LOCK_FOREIGN_STALE_MS = 24 * 60 * 60 * 1000;

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
    this.rootDirectory = canonicalPathSync(rootDirectory);
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
          const content = JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            ownerId: this.ownerId,
            startedAt: new Date().toISOString(),
          });
          const tmpPath = join(lockPath, `owner.${randomUUID()}.tmp`);
          await writeFile(tmpPath, content, { mode: 0o600 });
          await rename(tmpPath, join(lockPath, "owner.json"));
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        const beat = async (): Promise<void> => {
          try {
            const now = new Date();
            await utimes(lockPath, now, now);
          } catch {
            // Lock released or unavailable
          }
        };
        const interval = setInterval(() => void beat(), LOCK_HEARTBEAT_MS);
        interval.unref();

        return async () => {
          clearInterval(interval);
          try {
            const current = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
              ownerId?: string;
            };
            if (current.ownerId === this.ownerId) {
              await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
            }
          } catch {
            // Lock already reaped, removed, or unreadable — never delete another holder's lock
          }
        };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        try {
          const owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as {
            pid?: number;
            hostname?: string;
            ownerId?: string;
            startedAt?: string;
          };
          const metadata = await stat(lockPath);
          if (owner.hostname === hostname() && typeof owner.pid === "number") {
            try {
              process.kill(owner.pid, 0);
            } catch (probeError) {
              if ((probeError as NodeJS.ErrnoException).code === "ESRCH") {
                await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
                continue;
              }
            }
            // Same host: heartbeat staleness catches recycled PIDs and hung processes safely
            if (Date.now() - metadata.mtimeMs > LOCK_LOCAL_STALE_MS) {
              await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
              continue;
            }
          } else {
            // Foreign host / unprobeable: do not steal locks on short heartbeat (clock skew risk).
            // Only reap after conservative 24h fallback window to prevent permanent lockout.
            // Note: assumes foreign host wall-clock skew is within 24h.
            if (Date.now() - metadata.mtimeMs > LOCK_FOREIGN_STALE_MS) {
              let recent = false;
              if (owner.startedAt) {
                const startedMs = Date.parse(owner.startedAt);
                if (!Number.isNaN(startedMs) && Date.now() - startedMs < LOCK_FOREIGN_STALE_MS) {
                  recent = true;
                }
              }
              if (!recent) {
                await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
                continue;
              }
            }
          }
        } catch {
          // A process can crash between mkdir and owner publication (owner.json missing or partial),
          // or owner.json exists but is unparseable / permission-denied.
          try {
            const metadata = await stat(lockPath);
            let timeoutThreshold = LOCK_LOCAL_STALE_MS;
            try {
              const raw = await readFile(join(lockPath, "owner.json"), "utf8");
              if (raw.includes(`"hostname":"`) && !raw.includes(`"hostname":"${hostname()}"`)) {
                timeoutThreshold = LOCK_FOREIGN_STALE_MS;
              }
            } catch {
              // Missing or unreadable — treat as local crash
            }
            if (Date.now() - metadata.mtimeMs > timeoutThreshold) {
              await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
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
    const canonicalRoot = await canonicalPath(root);
    return this.withWorkspaceLock(canonicalRoot, async () => {
      const release = await this.acquireFilesystemLock(`workspace:${canonicalRoot}`);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }
}
