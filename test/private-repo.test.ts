import { execFileSync } from "node:child_process";
import type { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvGitRunner } from "../src/core/git-runner.js";
import {
  ensurePrivateGitRepository,
  privateRepositoryPath,
  storeRootDirectory,
} from "../src/core/private-repo.js";
import { createSnapshotCommit } from "../src/core/checkpoints.js";
import { historyDirectory } from "../src/core/history-store.js";
import type { BlobStore } from "../src/core/blob-store/index.js";
import type { GitRunner } from "../src/core/types.js";
import { resolveBackend } from "../src/index.js";

function blobStoreStub() {
  const calls: string[] = [];
  const store = { rootDirectory: "stub" } as unknown as BlobStore;
  return {
    calls,
    blobStoreFor: (workspaceRoot: string) => {
      calls.push(workspaceRoot);
      return store;
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("private per-workspace git repositories", () => {
  it("creates a private repo under the state root keyed by sha256 of the canonical cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-repo-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createEnvGitRunner(cwd2, env),
        cwd,
        storeRoot,
      );
      expect(repository).not.toBeNull();
      if (!repository) return;

      const canonical = await realpath(cwd);
      const expected = privateRepositoryPath(storeRoot, cwd);
      expect(resolve(repository.gitDir)).toBe(resolve(expected));
      expect(repository.worktree).toBe(canonical);
      expect(repository.commonDir).toBe(repository.gitDir);

      const envGit = createEnvGitRunner(cwd, { GIT_DIR: repository.gitDir });
      const configs: Array<[string, string]> = [
        ["core.bare", "false"],
        ["core.autocrlf", "false"],
        ["core.longpaths", "true"],
        ["core.symlinks", "true"],
        ["core.fsmonitor", "false"],
        ["feature.manyFiles", "true"],
        ["index.version", "4"],
        ["index.threads", "true"],
        ["core.untrackedCache", "true"],
        ["core.worktree", canonical],
      ];
      for (const [key, value] of configs) {
        const result = await envGit(["config", "--get", key]);
        expect(result.code, `${key}: ${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe(value);
      }

      const second = await ensurePrivateGitRepository(
        (cwd2, env) => createEnvGitRunner(cwd2, env),
        cwd,
        storeRoot,
      );
      expect(second).not.toBeNull();
      expect(second!.gitDir).toBe(repository.gitDir);
      for (const [key, value] of configs) {
        const result = await envGit(["config", "--get", key]);
        expect(result.code, `${key}: ${result.stderr}`).toBe(0);
        expect(result.stdout.trim()).toBe(value);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("resolveBackend returns a git backend for a non-git cwd when git is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-backend-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      vi.stubEnv("OMP_UNDO_REDO_BLOB_DIR", storeRoot);
      vi.stubEnv("OMP_UNDO_REDO_PRIVATE_GIT", "1");
      const { blobStoreFor } = blobStoreStub();
      const backend = await resolveBackend(cwd, blobStoreFor, true);
      expect(backend.kind).toBe("git");
      if (backend.kind !== "git") return;
      const canonical = await realpath(cwd);
      expect(backend.repository.worktree).toBe(canonical);
      const canonicalStoreRoot = await realpath(storeRoot);
      expect(backend.repository.gitDir.startsWith(join(canonicalStoreRoot, "repos"))).toBe(true);
      expect(backend.repository.gitDir).not.toBe(join(canonical, ".git"));
      expect(backend.repository.commonDir).toBe(backend.repository.gitDir);
      expect(historyDirectory(backend.repository)).toBe(
        join(backend.repository.commonDir, "omp-undo-redo", "history"),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("falls back to blob when private git is disabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-disabled-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      vi.stubEnv("OMP_UNDO_REDO_BLOB_DIR", storeRoot);
      vi.stubEnv("OMP_UNDO_REDO_PRIVATE_GIT", "0");
      const { blobStoreFor, calls } = blobStoreStub();
      const backend = await resolveBackend(cwd, blobStoreFor, false);
      expect(backend.kind).toBe("blob");
      if (backend.kind !== "blob") return;
      const canonical = await realpath(cwd);
      expect(backend.workspaceRoot).toBe(canonical);
      expect(calls).toContain(canonical);
    } finally {
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("falls back to blob when private repo init fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-fail-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      vi.stubEnv("OMP_UNDO_REDO_BLOB_DIR", storeRoot);
      vi.stubEnv("OMP_UNDO_REDO_PRIVATE_GIT", "1");
      await writeFile(join(storeRoot, "repos"), "not a directory");
      const { blobStoreFor, calls } = blobStoreStub();
      const backend = await resolveBackend(cwd, blobStoreFor, true);
      expect(backend.kind).toBe("blob");
      if (backend.kind !== "blob") return;
      const canonical = await realpath(cwd);
      expect(backend.workspaceRoot).toBe(canonical);
      expect(calls).toContain(canonical);
    } finally {
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("git operations run with GIT_DIR/GIT_WORK_TREE env", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-env-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createEnvGitRunner(cwd2, env),
        cwd,
        storeRoot,
      );
      expect(repository).not.toBeNull();
      if (!repository) return;

      const recorded: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const spawnGit = ((
        _command: string,
        args: string[],
        options: { env: Record<string, string | undefined> },
      ) => {
        recorded.push({ args, env: options.env });
        throw new Error("stub");
      }) as unknown as typeof spawn;
      const stubbed = createEnvGitRunner(cwd, { GIT_DIR: repository.gitDir }, { spawnGit });
      await stubbed(["update-ref", "--stdin"], { stdin: "" });
      expect(recorded.length).toBeGreaterThan(0);
      for (const entry of recorded) {
        expect(entry.env.GIT_DIR).toBe(repository.gitDir);
      }

      const envGit = createEnvGitRunner(cwd, { GIT_DIR: repository.gitDir });
      const invocations: Array<{ args: string[]; env: Record<string, string | undefined> }> = [];
      const recording = Object.assign(
        async (args: string[], options?: Parameters<GitRunner>[1]) => {
          invocations.push({ args, env: options?.env ?? {} });
          return envGit(args, options);
        },
        { cwd, env: { GIT_DIR: repository.gitDir } },
      ) satisfies GitRunner;
      const snapshot = await createSnapshotCommit(recording, "env-test");
      expect("hash" in snapshot).toBe(true);
      const addCall = invocations.find((entry) => entry.args[0] === "add");
      expect(addCall).toBeDefined();
      expect(addCall!.env.GIT_WORK_TREE).toBe(cwd);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("snapshot respects the workspace ignore list", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-ignore-"));
    try {
      const storeRoot = join(cwd, ".omp");
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createEnvGitRunner(cwd2, env),
        cwd,
        storeRoot,
      );
      expect(repository).not.toBeNull();
      if (!repository) return;

      await mkdir(join(cwd, "node_modules"));
      await writeFile(join(cwd, "node_modules", "dep.js"), "x");
      await writeFile(join(cwd, ".omp", "state.json"), "{}");
      await writeFile(join(cwd, "tracked.txt"), "hello");
      const excludePath = join(repository.gitDir, "info", "exclude");
      await writeFile(excludePath, `${await readFile(excludePath, "utf8")}node_modules/\n`);

      const envGit = createEnvGitRunner(cwd, { GIT_DIR: repository.gitDir });
      const snapshot = await createSnapshotCommit(envGit, "ignore-test");
      expect("hash" in snapshot).toBe(true);
      if (!("hash" in snapshot)) return;
      const tree = await envGit(["ls-tree", "-r", "--name-only", snapshot.hash]);
      expect(tree.code).toBe(0);
      expect(tree.stdout).toContain("tracked.txt");
      expect(tree.stdout).not.toContain(".omp");
      expect(tree.stdout).not.toContain("node_modules");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("seeds the built-in blob ignores into the private repo exclude", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-exclude-"));
    try {
      const storeRoot = join(cwd, ".omp");
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createEnvGitRunner(cwd2, env),
        cwd,
        storeRoot,
      );
      expect(repository).not.toBeNull();
      if (!repository) return;
      const exclude = await readFile(join(repository.gitDir, "info", "exclude"), "utf8");
      const entries = new Set(exclude.split(/\r?\n/));
      // The store root is inside the worktree, so its relative entry is seeded…
      expect(entries.has(".omp/")).toBe(true);
      // …and so are the same built-in ignores the blob store applies.
      for (const ignored of [
        ".git",
        "node_modules",
        "dist",
        "coverage",
        ".omp",
        ".next",
        "build",
        "out",
        "target",
      ]) {
        expect(entries.has(ignored)).toBe(true);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("canonicalizes the store root so junction/8.3 alias spellings yield one gitDir", async () => {
    // Regression for the owner-review finding: on machines whose TEMP/user dir
    // is spelled in 8.3 short form (e.g. C:\Users\BAYLAR~1.SAD\...), the
    // checkpoint records the realpath-canonicalized gitDir while the map entry
    // was built from the raw store root — a string mismatch that made
    // isPrivateRepository return false and the gc counter never increment
    // (21 turns, 42 adds, 0 gcs). privateRepositoryPath must canonicalize
    // BOTH inputs so every pipeline yields the same long-form path.
    // The mixed-form probe here is a directory JUNCTION: realpath expands a
    // junction to its target string while path.join does not — the exact
    // 8.3-short-form shape (realpath expands, raw join keeps), reproducible
    // on any machine without needing 8.3 short names to be enabled.
    const cwd = await mkdtemp(join(tmpdir(), "omp-canon-cwd-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-canon-store-"));
    const alias = join(tmpdir(), `omp-canon-alias-${process.pid}-${Date.now()}`);
    let aliasCreated = false;
    try {
      try {
        execFileSync("cmd", ["/c", "mklink", "/J", alias, storeRoot], { stdio: "ignore" });
        aliasCreated = true;
      } catch {
        // Junction creation failed (filesystem without junction support):
        // the 8.3 leg below still runs when short names are available.
      }
      // 8.3 short form of the same store root (%~fsI, unquoted set — a
      // quoted set makes cmd emit a broken `F:\"C:\...` token). When
      // short-name generation is disabled on the volume this equals the long
      // form and the leg is a no-op; the junction leg above always forces a
      // mixed form. The cwd needs no aliased form: it was already realpath-
      // canonicalized on the sha side before this fix, so only the store
      // root carries the mismatch (the owner's exact scenario).
      let shortStoreRoot = storeRoot;
      try {
        shortStoreRoot = execFileSync("cmd", ["/c", `for %I in (${storeRoot}) do @echo %~fsI`], {
          encoding: "utf8",
        }).trim();
      } catch {
        // cmd unavailable or %~fsI failed: fall through to the other variants.
      }
      const canonical = privateRepositoryPath(storeRoot, cwd);
      const storeForms = [
        ...(aliasCreated ? [alias] : []),
        ...(shortStoreRoot !== storeRoot ? [shortStoreRoot] : []),
      ];
      for (const storeForm of storeForms) {
        expect(privateRepositoryPath(storeForm, cwd)).toBe(canonical);
      }
      // End-to-end: the repository actually created from the RAW store root
      // and cwd must land at the canonical path, and that path must be its
      // own realpath form — the exact comparison the checkpoint side makes.
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createEnvGitRunner(cwd2, env),
        cwd,
        storeRoot,
      );
      expect(repository?.gitDir).toBe(canonical);
      if (repository) expect(await realpath(repository.gitDir)).toBe(repository.gitDir);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
      if (aliasCreated) await rm(alias, { recursive: true, force: true });
    }
  });

  it("resolves storeRootDirectory via OMP_UNDO_REDO_STORE_DIR and legacy OMP_UNDO_REDO_BLOB_DIR", async () => {
    const dirStore = await mkdtemp(join(tmpdir(), "omp-store-dir-"));
    const dirBlob = await mkdtemp(join(tmpdir(), "omp-blob-dir-"));
    try {
      const canonicalStore = await realpath(dirStore);
      const canonicalBlob = await realpath(dirBlob);

      delete process.env.OMP_UNDO_REDO_BLOB_DIR;
      vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", dirStore);
      expect(storeRootDirectory()).toBe(canonicalStore);

      delete process.env.OMP_UNDO_REDO_STORE_DIR;
      vi.stubEnv("OMP_UNDO_REDO_BLOB_DIR", dirBlob);
      expect(storeRootDirectory()).toBe(canonicalBlob);

      vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", dirStore);
      vi.stubEnv("OMP_UNDO_REDO_BLOB_DIR", dirBlob);
      expect(storeRootDirectory()).toBe(canonicalStore);
    } finally {
      await rm(dirStore, { recursive: true, force: true });
      await rm(dirBlob, { recursive: true, force: true });
    }
  });
});
