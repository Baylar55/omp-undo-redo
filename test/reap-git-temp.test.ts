import { chmod, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createGitRunner } from "../src/core/git-runner.js";
import { GIT_TEMP_REAP_CUTOFF_MS, reapStaleGitTempFiles } from "../src/core/private-repo.js";
import ompUndoRedo from "../src/index.js";
import { FakeExtensionApi, git, makeRepository, rmRetry } from "./helpers.js";

const HOUR = 60 * 60 * 1000;

/** Deterministic wait for the detached boot sweep: poll the observable
 *  (file gone) instead of sleeping a guessed duration — mirrors the
 *  private-gc tests' waitFor, since the 2s-deferred sweep exposes no
 *  promise to await. */
async function waitForFileGone(path: string, attempts = 100): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await stat(path);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

async function seedFile(path: string, bytes = 16): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, Buffer.alloc(bytes, 0x62));
}

async function backdate(path: string, ageMs = 2 * HOUR): Promise<void> {
  const t = new Date(Date.now() - ageMs);
  await utimes(path, t, t);
}

describe("reapStaleGitTempFiles", () => {
  it("reaps stale tmp_pack and tmp_obj files but keeps fresh temps and real packs", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "omp-undo-redo-reap-"));
    try {
      const packDir = join(gitDir, "objects", "pack");
      await seedFile(join(packDir, "tmp_pack_old"));
      await seedFile(join(packDir, "tmp_pack_fresh"));
      await seedFile(join(packDir, "pack-0123456789abcdef0123456789abcdef01234567.pack"));
      await seedFile(join(packDir, "pack-0123456789abcdef0123456789abcdef01234567.idx"));
      // Git marks pack temp files read-only; the reaper must still remove them.
      await chmod(join(packDir, "tmp_pack_old"), 0o444);
      await backdate(join(packDir, "tmp_pack_old"));
      const fanout = join(gitDir, "objects", "ab");
      await seedFile(join(fanout, "tmp_obj_OIRRf2"));
      await backdate(join(fanout, "tmp_obj_OIRRf2"));

      const reaped = await reapStaleGitTempFiles(gitDir);

      expect(reaped).toBe(2);
      await expect(stat(join(packDir, "tmp_pack_old"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(fanout, "tmp_obj_OIRRf2"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(packDir, "tmp_pack_fresh"))).resolves.toBeTruthy();
      await expect(
        stat(join(packDir, "pack-0123456789abcdef0123456789abcdef01234567.pack")),
      ).resolves.toBeTruthy();
      await expect(
        stat(join(packDir, "pack-0123456789abcdef0123456789abcdef01234567.idx")),
      ).resolves.toBeTruthy();
    } finally {
      await rmRetry(gitDir);
    }
  });

  it("skips everything while gc.pid is fresh, reaps once the pidfile is stale debris", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "omp-undo-redo-reap-pid-"));
    try {
      const packDir = join(gitDir, "objects", "pack");
      await seedFile(join(packDir, "tmp_pack_old"));
      await backdate(join(packDir, "tmp_pack_old"));
      await writeFile(join(gitDir, "gc.pid"), "12345\n");

      // Fresh pidfile: a gc is running right now, nothing is touched.
      expect(await reapStaleGitTempFiles(gitDir)).toBe(0);
      await expect(stat(join(packDir, "tmp_pack_old"))).resolves.toBeTruthy();

      // Stale pidfile: crash debris from a killed child, backdated past the
      // 24h liveness window — the orphan is reaped.
      await backdate(join(gitDir, "gc.pid"), 25 * HOUR);
      expect(await reapStaleGitTempFiles(gitDir)).toBe(1);
      await expect(stat(join(packDir, "tmp_pack_old"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rmRetry(gitDir);
    }
  });

  it("leaves a real git repository fully functional", async () => {
    const repo = await makeRepository("omp-undo-redo-reap-realgit-");
    try {
      const packDir = join(repo, ".git", "objects", "pack");
      await seedFile(join(packDir, "tmp_pack_old"));
      await backdate(join(packDir, "tmp_pack_old"));

      expect(await reapStaleGitTempFiles(join(repo, ".git"))).toBe(1);
      await expect(stat(join(packDir, "tmp_pack_old"))).rejects.toMatchObject({ code: "ENOENT" });

      const runner = createGitRunner(repo);
      const fsck = await runner(["fsck", "--strict"]);
      expect(fsck.code).toBe(0);
      const log = await runner(["log", "--oneline"]);
      expect(log.code).toBe(0);
      expect(log.stdout.trim().length).toBeGreaterThan(0);
    } finally {
      await rmRetry(repo);
    }
  });

  it("honors a custom cutoff so callers can reap aggressively", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "omp-undo-redo-reap-cutoff-"));
    try {
      const packDir = join(gitDir, "objects", "pack");
      await seedFile(join(packDir, "tmp_pack_recent"));
      await backdate(join(packDir, "tmp_pack_recent"), 5 * 60 * 1000);

      expect(await reapStaleGitTempFiles(gitDir, { cutoffMs: HOUR })).toBe(0);
      expect(await reapStaleGitTempFiles(gitDir, { cutoffMs: 60 * 1000 })).toBe(1);
    } finally {
      await rmRetry(gitDir);
    }
  });

  it("default cutoff is one hour", () => {
    expect(GIT_TEMP_REAP_CUTOFF_MS).toBe(HOUR);
  });
});

describe("boot-time git temp sweep", () => {
  const store = join(tmpdir(), `omp-undo-redo-reap-store-${process.pid}-${Date.now()}`);
  const emptyStore = join(tmpdir(), `omp-undo-redo-reap-boot-empty-${process.pid}`);

  afterAll(async () => {
    await rm(store, { recursive: true, force: true });
    await rm(emptyStore, { recursive: true, force: true });
  });

  it("reaps stale temps across repos shortly after extension construction", async () => {
    const reposDir = join(store, "repos");
    const gitDir = join(
      reposDir,
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.git",
    );
    const packDir = join(gitDir, "objects", "pack");
    await seedFile(join(packDir, "tmp_pack_old"));
    await seedFile(join(packDir, "tmp_pack_fresh"));
    await backdate(join(packDir, "tmp_pack_old"));

    const previousStore = process.env.OMP_UNDO_REDO_STORE_DIR;
    process.env.OMP_UNDO_REDO_STORE_DIR = store;
    try {
      ompUndoRedo(new FakeExtensionApi() as never, {});
      expect(await waitForFileGone(join(packDir, "tmp_pack_old"))).toBe(true);
      await expect(stat(join(packDir, "tmp_pack_fresh"))).resolves.toBeTruthy();
    } finally {
      if (previousStore === undefined) delete process.env.OMP_UNDO_REDO_STORE_DIR;
      else process.env.OMP_UNDO_REDO_STORE_DIR = previousStore;
    }
  }, 30000);

  it("does not touch a real workspace repository", async () => {
    const repo = await makeRepository("omp-undo-redo-reap-boot-real-");
    const reposDir = join(emptyStore, "repos");
    const canaryGitDir = join(
      reposDir,
      "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe.git",
    );
    const canary = join(canaryGitDir, "objects", "pack", "tmp_pack_canary");
    await seedFile(canary);
    await backdate(canary);

    const previousStore = process.env.OMP_UNDO_REDO_STORE_DIR;
    process.env.OMP_UNDO_REDO_STORE_DIR = emptyStore;
    try {
      ompUndoRedo(new FakeExtensionApi() as never, {});
      // The canary's reap proves the sweep ran; the real repo must be
      // untouched by it.
      expect(await waitForFileGone(canary)).toBe(true);
      expect(await git(repo, ["status", "--porcelain"])).toBe("");
    } finally {
      if (previousStore === undefined) delete process.env.OMP_UNDO_REDO_STORE_DIR;
      else process.env.OMP_UNDO_REDO_STORE_DIR = previousStore;
      await rmRetry(repo);
    }
  }, 30000);
});
