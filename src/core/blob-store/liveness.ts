import { readdir, readFile, rm, stat, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import { atomicWrite } from "./fs.js";

/** Captures walk their workspace outside the store lock and write blobs that
 *  no ref references until the walk's publish step. A concurrent GC must not
 *  sweep those blobs, so each capture keeps a marker file alive with a
 *  heartbeat and GC defers its sweep while any marker is fresh. Marker
 *  creation is serialized under the store lock, closing the
 *  check-vs-start race. */
const CAPTURE_MARKER_BEAT_MS = 5_000;
const CAPTURE_MARKER_STALE_MS = 30_000;

/** Cross-process liveness for the store: the lease that proves this owner is
 *  alive (used to reap a dead owner's active refs) and the capture markers
 *  that defer GC sweeps while captures are in flight. */

export class StoreLiveness {
  private readonly rootDirectory: string;
  private readonly ownerId: string;
  private readonly clock: () => Date;
  private leasePublished = false;

  constructor(rootDirectory: string, ownerId: string, clock: () => Date) {
    this.rootDirectory = rootDirectory;
    this.ownerId = ownerId;
    this.clock = clock;
  }

  get hasPublishedLease(): boolean {
    return this.leasePublished;
  }

  async publishLease(): Promise<void> {
    if (this.leasePublished) return;
    await atomicWrite(
      join(this.rootDirectory, "leases", `${this.ownerId}.json`),
      JSON.stringify({
        ownerId: this.ownerId,
        pid: process.pid,
        hostname: hostname(),
        startedAt: this.clock().toISOString(),
      }),
    );
    this.leasePublished = true;
  }

  /** Removes this owner's lease file (shutdown path once the owner holds no
   *  active refs). */
  async clearLease(): Promise<void> {
    await rm(join(this.rootDirectory, "leases", `${this.ownerId}.json`), { force: true }).catch(
      () => undefined,
    );
    this.leasePublished = false;
  }

  /** True only when the lease names a dead local process — never for a
   *  foreign host or an unprobeable state, so reaping stays conservative. */
  async ownerIsProvablyStale(ownerId: string): Promise<boolean> {
    try {
      const value = JSON.parse(
        await readFile(join(this.rootDirectory, "leases", `${ownerId}.json`), "utf8"),
      ) as { ownerId?: unknown; pid?: unknown; hostname?: unknown };
      if (
        value.ownerId !== ownerId ||
        typeof value.pid !== "number" ||
        value.hostname !== hostname()
      )
        return false;
      try {
        process.kill(value.pid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH";
      }
    } catch {
      return false;
    }
  }

  /** Registers this capture as in-flight so a concurrent GC defers its sweep.
   *  The marker lives in locks/, where every process sharing the store can see
   *  it, and is kept fresh with a heartbeat until the capture finishes (the
   *  caller must invoke the returned stop function, including on failure). */
  async beginCaptureMarker(): Promise<() => Promise<void>> {
    const path = join(
      this.rootDirectory,
      "locks",
      `capture-${this.ownerId}-${randomUUID()}.marker`,
    );
    await atomicWrite(
      path,
      JSON.stringify({
        ownerId: this.ownerId,
        pid: process.pid,
        startedAt: this.clock().toISOString(),
      }),
    );
    const beat = async (): Promise<void> => {
      try {
        const now = new Date();
        await utimes(path, now, now);
      } catch {
        // Marker already removed or the store is unavailable; the staleness
        // window covers the gap.
      }
    };
    const interval = setInterval(() => void beat(), CAPTURE_MARKER_BEAT_MS);
    interval.unref();
    return async () => {
      clearInterval(interval);
      await rm(path, { force: true }).catch(() => undefined);
    };
  }

  async reapStaleLeases(): Promise<void> {
    const leasesDir = join(this.rootDirectory, "leases");
    let entries: Dirent[];
    try {
      entries = await readdir(leasesDir, { withFileTypes: true });
    } catch {
      return;
    }
    const candidates = entries.filter((e) => e.isFile() && e.name.endsWith(".json"));
    const concurrency = 16;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < candidates.length) {
        const entry = candidates[idx++];
        const ownerId = entry.name.slice(0, -5);
        // Never delete own lease while we own active refs — shutdown path handles it
        if (ownerId === this.ownerId) continue;
        if (await this.ownerIsProvablyStale(ownerId)) {
          await rm(join(leasesDir, entry.name), { force: true }).catch(() => undefined);
        } else {
          // Fallback age guard for leases whose pid is recycled but hostname matches
          // and kill returns EPERM/0 — treat >24h as stale (PID recycling hazard)
          try {
            const st = await stat(join(leasesDir, entry.name));
            if (Date.now() - st.mtimeMs >= 24 * 60 * 60 * 1000) {
              const content = await readFile(join(leasesDir, entry.name), "utf8").catch(() => "");
              let parsed: {
                startedAt?: string;
                ownerId?: unknown;
                pid?: unknown;
                hostname?: unknown;
              };
              try {
                parsed = JSON.parse(content) as {
                  startedAt?: string;
                  ownerId?: unknown;
                  pid?: unknown;
                  hostname?: unknown;
                };
              } catch {
                continue;
              }
              // Re-probe startedAt vs mtime for extra safety
              if (parsed.startedAt) {
                const startedMs = Date.parse(parsed.startedAt);
                if (!Number.isNaN(startedMs) && Date.now() - startedMs < 24 * 60 * 60 * 1000)
                  continue;
              }
              if (parsed.hostname === hostname() && typeof parsed.pid === "number") {
                try {
                  process.kill(parsed.pid, 0);
                  continue;
                } catch (e) {
                  if ((e as NodeJS.ErrnoException).code !== "ESRCH") continue;
                }
              } else {
                continue;
              }
              await rm(join(leasesDir, entry.name), { force: true }).catch(() => undefined);
            }
          } catch {
            // Ignore stat/read errors
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, candidates.length) }, () => worker()),
    );
  }

  /** True while any capture marker is fresh. Reaps markers that stopped
   *  beating (crashed captures) so a stale marker never defers the sweep
   *  forever. Must be called under the store lock. */
  async captureInFlight(): Promise<boolean> {
    try {
      const entries = await readdir(join(this.rootDirectory, "locks"));
      let inFlight = false;
      for (const name of entries) {
        if (!name.endsWith(".marker")) continue;
        const path = join(this.rootDirectory, "locks", name);
        try {
          const metadata = await stat(path);
          if (Date.now() - metadata.mtimeMs < CAPTURE_MARKER_STALE_MS) {
            inFlight = true;
          } else {
            await rm(path, { force: true });
          }
        } catch {
          // Vanished between readdir and stat.
        }
      }
      return inFlight;
    } catch {
      return false;
    }
  }
}
