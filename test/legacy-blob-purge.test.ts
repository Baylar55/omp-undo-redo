import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { purgeLegacyBlobStore } from "../src/index.js";

const LEGACY_DIRS = ["blobs", "trees", "refs", "locks", "leases", "journals", "history"] as const;
const STALE = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

afterEach(() => {
  vi.unstubAllEnvs();
});

async function pathExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

/** Store root with the seven pre-1.5.1 dirs, all aged past the quiet window. */
async function seedLegacyStore(label: string, dirs: readonly string[] = LEGACY_DIRS) {
  const storeRoot = await mkdtemp(join(tmpdir(), `omp-legacy-purge-${label}-`));
  vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
  vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(storeRoot, "runtime"));
  for (const dir of dirs) {
    const dirPath = join(storeRoot, dir);
    await mkdir(dirPath, { recursive: true });
    const filePath = join(dirPath, "item.txt");
    await writeFile(filePath, "legacy-data");
    await utimes(filePath, STALE, STALE);
    await utimes(dirPath, STALE, STALE);
  }
  return storeRoot;
}

async function cleanStore(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

describe("legacy blob store purge", () => {
  it("purges a quiet legacy store and spares live 1.6 data", async () => {
    const storeRoot = await seedLegacyStore("quiet");
    try {
      const repoDir = join(storeRoot, "repos", "workspace.git");
      const runtimeDir = join(storeRoot, "runtime", "1234");
      await mkdir(repoDir, { recursive: true });
      await mkdir(runtimeDir, { recursive: true });
      await writeFile(join(repoDir, "HEAD"), "ref: refs/heads/main\n");
      await writeFile(join(runtimeDir, "state.json"), "{}");

      await purgeLegacyBlobStore();

      for (const dir of LEGACY_DIRS) {
        expect(await pathExists(join(storeRoot, dir))).toBe(false);
      }
      expect(await pathExists(repoDir)).toBe(true);
      expect(await pathExists(runtimeDir)).toBe(true);
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("spares a store a 1.5 process is still holding", async () => {
    const storeRoot = await seedLegacyStore("active");
    try {
      // Fresh child under a stale parent: liveness must come from the child
      // scan of locks/leases/history, not the directory mtime.
      const locksDir = join(storeRoot, "locks");
      await writeFile(join(locksDir, "store.lock"), "held");
      await utimes(join(locksDir, "store.lock"), new Date(), new Date());
      await utimes(locksDir, STALE, STALE);

      await purgeLegacyBlobStore();

      for (const dir of LEGACY_DIRS) {
        expect(await pathExists(join(storeRoot, dir))).toBe(true);
      }
    } finally {
      await cleanStore(storeRoot);
    }
  });

  it("never touches a foreign store root that only happens to have blobs/", async () => {
    const storeRoot = await seedLegacyStore("foreign", ["blobs"]);
    try {
      await purgeLegacyBlobStore();

      // No trees/ and no journals/: not our layout, so nothing is recursively removed.
      expect(await pathExists(join(storeRoot, "blobs"))).toBe(true);
    } finally {
      await cleanStore(storeRoot);
    }
  });
});
