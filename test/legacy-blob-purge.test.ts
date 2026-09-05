import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ompUndoRedo, { purgeLegacyBlobStore } from "../src/index.js";

const LEGACY_DIRS = ["blobs", "trees", "refs", "locks", "leases", "journals", "history"] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

async function cleanStore(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe("legacy blob store purge", () => {
  it("purges a quiet legacy store and spares live 1.6 data", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-legacy-purge-"));
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));

    try {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      for (const dir of LEGACY_DIRS) {
        const dirPath = join(storeRoot, dir);
        await mkdir(dirPath, { recursive: true });
        const filePath = join(dirPath, "item.txt");
        await writeFile(filePath, "legacy-data");
        await utimes(filePath, stale, stale);
        await utimes(dirPath, stale, stale);
      }

      const reposDir = join(storeRoot, "repos", "workspace.git");
      const runtimeDir = join(storeRoot, "runtime", "1234");
      await mkdir(reposDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(reposDir, "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(runtimeDir, "state.json"), "{}");

      await purgeLegacyBlobStore();

      for (const dir of LEGACY_DIRS) {
        expect(await pathExists(join(storeRoot, dir))).toBe(false);
      }

      expect(await pathExists(reposDir)).toBe(true);
      expect(await pathExists(runtimeDir)).toBe(true);
      expect(await pathExists(storeRoot)).toBe(true);
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("skips a store a 1.5 process is still beating on via history active marker", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-legacy-purge-active-"));
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));

    try {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      for (const dir of LEGACY_DIRS) {
        const dirPath = join(storeRoot, dir);
        await mkdir(dirPath, { recursive: true });
        const filePath = join(dirPath, "item.txt");
        await writeFile(filePath, "legacy-data");
        await utimes(filePath, stale, stale);
        await utimes(dirPath, stale, stale);
      }

      // 1.5.x process refreshes history/.active.<sessionHash>
      // Parent directory must be stale while child marker is fresh, verifying child scan.
      const historyDir = join(storeRoot, "history");
      const activeMarker = join(historyDir, ".active.session123");
      await writeFile(activeMarker, "active-session");
      await utimes(activeMarker, new Date(), new Date());
      await utimes(historyDir, stale, stale);

      await purgeLegacyBlobStore();

      // None of the seven dirs should be removed
      for (const dir of LEGACY_DIRS) {
        expect(await pathExists(join(storeRoot, dir))).toBe(true);
      }
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("skips a store with recent activity in locks or leases", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-legacy-purge-locks-"));
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));

    try {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      for (const dir of LEGACY_DIRS) {
        const dirPath = join(storeRoot, dir);
        await mkdir(dirPath, { recursive: true });
        const filePath = join(dirPath, "item.txt");
        await writeFile(filePath, "legacy-data");
        await utimes(filePath, stale, stale);
        await utimes(dirPath, stale, stale);
      }

      // Parent directory must be stale while lock file is fresh, verifying child scan.
      const locksDir = join(storeRoot, "locks");
      const lockFile = join(locksDir, "store.lock");
      await writeFile(lockFile, "held");
      await utimes(lockFile, new Date(), new Date());
      await utimes(locksDir, stale, stale);

      await purgeLegacyBlobStore();

      for (const dir of LEGACY_DIRS) {
        expect(await pathExists(join(storeRoot, dir))).toBe(true);
      }
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("ignores a foreign directory with only blobs/", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-legacy-purge-foreign-"));
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));

    try {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const blobsDir = join(storeRoot, "blobs");
      await mkdir(blobsDir, { recursive: true });
      await writeFile(join(blobsDir, "other.dat"), "unrelated");
      await utimes(join(blobsDir, "other.dat"), stale, stale);
      await utimes(blobsDir, stale, stale);

      await purgeLegacyBlobStore();

      // blobs/ should still be present because trees/ and journals/ are absent
      expect(await pathExists(blobsDir)).toBe(true);
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("purges when signature is satisfied by blobs/ and journals/ (no trees/)", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-legacy-purge-journals-"));
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));

    try {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const blobsDir = join(storeRoot, "blobs");
      const journalsDir = join(storeRoot, "journals");
      await mkdir(blobsDir, { recursive: true });
      await mkdir(journalsDir, { recursive: true });
      await utimes(blobsDir, stale, stale);
      await utimes(journalsDir, stale, stale);

      await purgeLegacyBlobStore();

      expect(await pathExists(blobsDir)).toBe(false);
      expect(await pathExists(journalsDir)).toBe(false);
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("runs automatically during deferred boot-time housekeeping", async () => {
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-legacy-purge-boot-"));
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));

    vi.useFakeTimers();
    try {
      const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const blobsDir = join(storeRoot, "blobs");
      const treesDir = join(storeRoot, "trees");
      await mkdir(blobsDir, { recursive: true });
      await mkdir(treesDir, { recursive: true });
      await utimes(blobsDir, stale, stale);
      await utimes(treesDir, stale, stale);

      const pi = {
        on: () => {},
        registerCommand: () => {},
      } as unknown as Parameters<typeof ompUndoRedo>[0];

      ompUndoRedo(pi);

      // Before the 2s timer fires, the dirs should still exist
      expect(await pathExists(blobsDir)).toBe(true);
      expect(await pathExists(treesDir)).toBe(true);

      // Advance past the 2s deferred timer and await pending tasks
      await vi.advanceTimersByTimeAsync(2_500);
      vi.useRealTimers();

      for (let i = 0; i < 50; i += 1) {
        if (!(await pathExists(blobsDir)) && !(await pathExists(treesDir))) break;
        await new Promise((r) => setImmediate(r));
      }

      expect(await pathExists(blobsDir)).toBe(false);
      expect(await pathExists(treesDir)).toBe(false);
    } finally {
      vi.useRealTimers();
      await cleanStore(storeRoot);
    }
  });
});
