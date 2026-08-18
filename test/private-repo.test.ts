import type { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEnvGitRunner, createGitRunner } from "../src/core/git-runner.js";
import { ensurePrivateGitRepository, privateRepositoryPath } from "../src/core/private-repo.js";
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
      const git = createGitRunner(cwd);
      const repository = await ensurePrivateGitRepository(git, cwd, storeRoot);
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

      const second = await ensurePrivateGitRepository(git, cwd, storeRoot);
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
      const backend = await resolveBackend(cwd, blobStoreFor);
      expect(backend.kind).toBe("git");
      if (backend.kind !== "git") return;
      const canonical = await realpath(cwd);
      expect(backend.repository.worktree).toBe(canonical);
      expect(backend.repository.gitDir.startsWith(join(storeRoot, "repos"))).toBe(true);
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
      const backend = await resolveBackend(cwd, blobStoreFor);
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
      const backend = await resolveBackend(cwd, blobStoreFor);
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
      const git = createGitRunner(cwd);
      const repository = await ensurePrivateGitRepository(git, cwd, storeRoot);
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
      const git = createGitRunner(cwd);
      const repository = await ensurePrivateGitRepository(git, cwd, storeRoot);
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
});
