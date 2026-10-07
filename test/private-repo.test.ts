import { execFileSync } from "node:child_process";
import type { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitRunner } from "../src/core/git-runner.js";
import {
  DEFAULT_EXCLUDES,
  ensureGitSnapshotStore,
  ensurePrivateGitRepository,
  GIT_STORE_SOURCE_KEY,
  privateRepositoryPath,
  storeRootDirectory,
} from "../src/core/private-repo.js";
import { createSnapshotCommit, resolveRepository } from "../src/core/checkpoints.js";
import { historyDirectory } from "../src/core/history-store.js";
import type { GitRunner } from "../src/core/types.js";
import { resolveBackend } from "../src/index.js";
import { makeRepository } from "./helpers.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const factory = (cwd: string, env?: Record<string, string>): GitRunner =>
  createGitRunner(cwd, { env });

/** A factory whose runners record every git invocation in `commands`. */
function recordingFactory(commands: string[][]): typeof factory {
  return (cwd, env) => {
    const inner = createGitRunner(cwd, { env });
    return Object.assign(
      async (args: string[], options?: Parameters<GitRunner>[1]) => {
        commands.push(args);
        return inner(args, options);
      },
      { cwd: inner.cwd, env: inner.env },
    );
  };
}

/** Runs git against the store at `gitDir`, which must succeed. */
async function gitInStore(cwd: string, gitDir: string, args: string[]): Promise<void> {
  const result = await createGitRunner(cwd, { env: { GIT_DIR: gitDir } })(args);
  expect(result.code, result.stderr).toBe(0);
}

/** Leaves `gitDir` as an interrupted setup would: `interrupt` builds the state,
 *  then everything in it has been untouched for `quietForMs`. */
async function abandonStore(
  gitDir: string,
  quietForMs: number,
  interrupt: () => Promise<void>,
): Promise<void> {
  await mkdir(dirname(gitDir), { recursive: true });
  await interrupt();
  const touched = new Date(Date.now() - quietForMs);
  for (const name of await readdir(gitDir)) await utimes(join(gitDir, name), touched, touched);
}

/** `key` read the way the retention sweep reads it: from the store's config file. */
async function storeConfig(gitDir: string, key: string): Promise<{ code: number; value: string }> {
  const result = await createGitRunner(dirname(gitDir))([
    "config",
    "--file",
    join(gitDir, "config"),
    "--get",
    key,
  ]);
  return { code: result.code, value: result.stdout.trim() };
}

describe("private per-workspace git repositories", () => {
  it("creates a private repo under the state root keyed by sha256 of the canonical cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-repo-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createGitRunner(cwd2, { env }),
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

      const envGit = createGitRunner(cwd, { env: { GIT_DIR: repository.gitDir } });
      const configs: Array<[string, string]> = [
        ["core.bare", "false"],
        ["core.sharedRepository", "0600"],
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
        (cwd2, env) => createGitRunner(cwd2, { env }),
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

  it("finishes a store whose setup was abandoned after git init", async () => {
    // `git init` writes HEAD before the config calls: a crash or a held
    // config.lock in between left a store that looked initialized and stayed
    // bare, so its repository could not be resolved and every turn was
    // session-only, and without `core.worktree`, the only way the retention
    // sweep finds a store's workspace.
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-abandoned-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const gitDir = privateRepositoryPath(storeRoot, cwd);
      await abandonStore(gitDir, 60_000, () => gitInStore(cwd, gitDir, ["init", "-q"]));
      expect((await storeConfig(gitDir, "core.worktree")).code).toBe(1);

      const commands: string[][] = [];
      expect(
        await ensurePrivateGitRepository(recordingFactory(commands), cwd, storeRoot),
      ).not.toBeNull();
      // A second `git init` would reset `core.bare`: only the config calls are redone.
      expect(commands.some((args) => args[0] === "init")).toBe(false);
      expect(await storeConfig(gitDir, "core.worktree")).toEqual({
        code: 0,
        value: await realpath(cwd),
      });
      expect(await storeConfig(gitDir, "core.bare")).toEqual({ code: 0, value: "false" });
      expect(await storeConfig(gitDir, "core.autocrlf")).toEqual({ code: 0, value: "false" });
      const resolved = await resolveRepository(createGitRunner(cwd, { env: { GIT_DIR: gitDir } }));
      expect("repository" in resolved).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it.each([
    [
      "only HEAD written",
      async (gitDir: string) => {
        await mkdir(gitDir, { recursive: true });
        await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/master\n");
      },
    ],
    [
      "no objects/ yet",
      async (gitDir: string, cwd: string) => {
        await gitInStore(cwd, gitDir, ["init", "-q"]);
        await rm(join(gitDir, "objects"), { recursive: true });
      },
    ],
  ])("finishes a store whose git init stopped early: %s", async (_state, interrupt) => {
    // Older gits write HEAD before their own config, and every git creates
    // `objects/` last, so a store can have HEAD yet be a directory git
    // rejects. Only another `git init` fixes that.
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-interrupted-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const gitDir = privateRepositoryPath(storeRoot, cwd);
      await abandonStore(gitDir, 60_000, () => interrupt(gitDir, cwd));
      expect((await storeConfig(gitDir, "core.worktree")).code).toBe(1);

      expect(await ensurePrivateGitRepository(factory, cwd, storeRoot)).not.toBeNull();
      expect(await storeConfig(gitDir, "core.worktree")).toEqual({
        code: 0,
        value: await realpath(cwd),
      });
      expect((await stat(join(gitDir, "objects"))).isDirectory()).toBe(true);
      const resolved = await resolveRepository(createGitRunner(cwd, { env: { GIT_DIR: gitDir } }));
      expect("repository" in resolved).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("leaves an unfinished store alone while the launch that began it may still be running", async () => {
    // A launch mid-setup rewrites the config every few tens of milliseconds; a
    // second launch writing alongside it only makes the first one collide on
    // config.lock and give up, so only a store quiet for a while is finished,
    // and a young one gets no config write at all.
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-young-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const gitDir = privateRepositoryPath(storeRoot, cwd);
      await abandonStore(gitDir, 0, () => gitInStore(cwd, gitDir, ["init", "-q"]));

      const commands: string[][] = [];
      expect(
        await ensurePrivateGitRepository(recordingFactory(commands), cwd, storeRoot),
      ).not.toBeNull();
      expect(commands.filter((args) => args[0] === "init" || args[0] === "config")).toEqual([]);
      expect((await storeConfig(gitDir, "core.worktree")).code).toBe(1);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("uses a store it cannot finish as found, and finishes it on a later launch", async () => {
    // A contended config.lock fails every config call. The store was usable
    // before this change, so it stays usable: failing here would turn a
    // workspace session-only over a lock that clears on its own.
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-locked-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const gitDir = privateRepositoryPath(storeRoot, cwd);
      await abandonStore(gitDir, 60_000, () => gitInStore(cwd, gitDir, ["init", "-q"]));
      await writeFile(join(gitDir, "config.lock"), "");

      expect(await ensurePrivateGitRepository(factory, cwd, storeRoot)).not.toBeNull();
      expect((await storeConfig(gitDir, "core.worktree")).code).toBe(1);

      await rm(join(gitDir, "config.lock"));
      expect(await ensurePrivateGitRepository(factory, cwd, storeRoot)).not.toBeNull();
      expect(await storeConfig(gitDir, "core.worktree")).toEqual({
        code: 0,
        value: await realpath(cwd),
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("clears a config.lock left by a killed git and finishes the store", async () => {
    // Git never removes a lock its killed process left behind, so every later
    // config call failed and the store stayed unfinished forever.
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-stale-lock-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const gitDir = privateRepositoryPath(storeRoot, cwd);
      await abandonStore(gitDir, 60_000, async () => {
        await gitInStore(cwd, gitDir, ["init", "-q"]);
        await writeFile(join(gitDir, "config.lock"), "");
      });

      expect(await ensurePrivateGitRepository(factory, cwd, storeRoot)).not.toBeNull();
      expect(await storeConfig(gitDir, "core.worktree")).toEqual({
        code: 0,
        value: await realpath(cwd),
      });
      await expect(stat(join(gitDir, "config.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("does not redo a finished store on later launches", async () => {
    // A second `git init` resets `core.bare`, and a launch that rewrote every
    // key would pay a dozen git processes and widen the config.lock window for
    // nothing.
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-finished-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      expect(await ensurePrivateGitRepository(factory, cwd, storeRoot)).not.toBeNull();
      const commands: string[][] = [];

      expect(
        await ensurePrivateGitRepository(recordingFactory(commands), cwd, storeRoot),
      ).not.toBeNull();
      expect(commands.some((args) => args[0] === "init")).toBe(false);
      // `core.worktree` is the last key of the config sequence, so a redo shows up as a write to it.
      const rewrote = commands.some(
        (args) => args[0] === "config" && args.includes("core.worktree") && !args.includes("--get"),
      );
      expect(rewrote).toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("finishes an abandoned Git snapshot store so the sweep can find its repository", async () => {
    const cwd = await makeRepository();
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const resolved = await resolveRepository(createGitRunner(cwd));
      if (!("repository" in resolved)) throw new Error("not a repository");
      const { repository } = resolved;
      const storeDir = privateRepositoryPath(storeRoot, repository.commonDir);
      await abandonStore(storeDir, 60_000, () =>
        gitInStore(cwd, storeDir, ["init", "--bare", "-q"]),
      );
      expect((await storeConfig(storeDir, GIT_STORE_SOURCE_KEY)).code).toBe(1);

      expect(await ensureGitSnapshotStore(factory, repository, storeRoot)).toBe(storeDir);
      expect(await storeConfig(storeDir, GIT_STORE_SOURCE_KEY)).toEqual({
        code: 0,
        value: repository.commonDir,
      });
      expect(await storeConfig(storeDir, "core.sharedRepository")).toEqual({
        code: 0,
        value: "0600",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("finishes a Git snapshot store whose git init stopped after HEAD", async () => {
    const cwd = await makeRepository();
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      const resolved = await resolveRepository(createGitRunner(cwd));
      if (!("repository" in resolved)) throw new Error("not a repository");
      const { repository } = resolved;
      const storeDir = privateRepositoryPath(storeRoot, repository.commonDir);
      await abandonStore(storeDir, 60_000, async () => {
        await mkdir(storeDir, { recursive: true });
        await writeFile(join(storeDir, "HEAD"), "ref: refs/heads/master\n");
      });

      expect(await ensureGitSnapshotStore(factory, repository, storeRoot)).toBe(storeDir);
      expect(await storeConfig(storeDir, GIT_STORE_SOURCE_KEY)).toEqual({
        code: 0,
        value: repository.commonDir,
      });
      expect((await stat(join(storeDir, "objects"))).isDirectory()).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  // POSIX-only: Windows ignores these mode bits, so the assertion is
  // meaningless there (and this fix is POSIX-only exposure).
  it.skipIf(process.platform === "win32")(
    "creates the private store owner-only so other local users cannot read snapshots",
    async () => {
      // A Private-Git snapshot captures every workspace file outside the
      // built-in ignore list — .env, id_rsa, credentials.json included — so a
      // 0755 store let any local user read the whole workspace out of
      // <storeRoot>/repos/<sha256>.git/objects/.
      const cwd = await mkdtemp(join(tmpdir(), "omp-private-perm-"));
      const storeParent = await mkdtemp(join(tmpdir(), "omp-private-perm-store-"));
      const storeRoot = join(storeParent, "store");
      try {
        const repository = await ensurePrivateGitRepository(
          (cwd2, env) => createGitRunner(cwd2, { env }),
          cwd,
          storeRoot,
        );
        expect(repository).not.toBeNull();
        if (!repository) return;
        for (const directory of [dirname(repository.gitDir), await realpath(storeRoot)]) {
          expect((await stat(directory)).mode & 0o777).toBe(0o700);
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
        await rm(storeParent, { recursive: true, force: true });
      }
    },
  );

  it("resolveBackend returns a git backend for a non-git cwd when git is available", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-backend-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
      const backend = await resolveBackend(cwd);
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

  it("uses private git unconditionally for non-git cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-disabled-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
      const backend = await resolveBackend(cwd);
      expect(backend.kind).toBe("git");
      if (backend.kind !== "git") return;
      const canonical = await realpath(cwd);
      expect(backend.repository.worktree).toBe(canonical);
    } finally {
      vi.unstubAllEnvs();
      await rm(cwd, { recursive: true, force: true });
      await rm(storeRoot, { recursive: true, force: true });
    }
  });

  it("falls back to session when private repo init fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-fail-"));
    const storeRoot = await mkdtemp(join(tmpdir(), "omp-private-store-"));
    try {
      vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", storeRoot);
      await writeFile(join(storeRoot, "repos"), "not a directory");
      const backend = await resolveBackend(cwd);
      expect(backend.kind).toBe("session");
      if (backend.kind !== "session") return;
      expect(backend.reason).toBe("private_repository_unavailable");
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
        (cwd2, env) => createGitRunner(cwd2, { env }),
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
      const stubbed = createGitRunner(cwd, { env: { GIT_DIR: repository.gitDir }, spawnGit });
      await stubbed(["update-ref", "--stdin"], { stdin: "" });
      expect(recorded.length).toBeGreaterThan(0);
      for (const entry of recorded) {
        expect(entry.env.GIT_DIR).toBe(repository.gitDir);
      }

      const envGit = createGitRunner(cwd, { env: { GIT_DIR: repository.gitDir } });
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
        (cwd2, env) => createGitRunner(cwd2, { env }),
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

      const envGit = createGitRunner(cwd, { env: { GIT_DIR: repository.gitDir } });
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

  it("seeds the built-in excludes into the private repo exclude", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-exclude-"));
    try {
      const storeRoot = join(cwd, ".omp");
      const repository = await ensurePrivateGitRepository(
        (cwd2, env) => createGitRunner(cwd2, { env }),
        cwd,
        storeRoot,
      );
      expect(repository).not.toBeNull();
      if (!repository) return;
      const exclude = await readFile(join(repository.gitDir, "info", "exclude"), "utf8");
      const entries = new Set(exclude.split(/\r?\n/));
      // The store root is inside the worktree, so its relative entry is seeded…
      expect(entries.has(".omp/")).toBe(true);
      for (const ignored of DEFAULT_EXCLUDES) expect(entries.has(ignored)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not grow info/exclude across repeated launches and heals a bloated file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-private-exclude-idem-"));
    try {
      const storeRoot = join(cwd, ".omp");
      const factory = (cwd2: string, env?: NodeJS.ProcessEnv) => createGitRunner(cwd2, { env });
      const repository = await ensurePrivateGitRepository(factory, cwd, storeRoot);
      expect(repository).not.toBeNull();
      if (!repository) return;
      const excludePath = join(repository.gitDir, "info", "exclude");
      const fresh = await readFile(excludePath, "utf8");

      await ensurePrivateGitRepository(factory, cwd, storeRoot);
      await ensurePrivateGitRepository(factory, cwd, storeRoot);
      expect(await readFile(excludePath, "utf8")).toBe(fresh);

      // Bloated by an older version, plus a user line that must survive.
      await writeFile(excludePath, `${fresh}my-secret-dir/\n${fresh}${fresh}`, "utf8");
      await ensurePrivateGitRepository(factory, cwd, storeRoot);
      const healed = (await readFile(excludePath, "utf8")).split("\n").filter(Boolean);
      expect(healed.filter((line) => line === "node_modules")).toHaveLength(1);
      expect(healed).toContain("my-secret-dir/");
      for (const ignored of DEFAULT_EXCLUDES) expect(healed).toContain(ignored);

      // Store-root entry also collapses to one copy.
      expect(healed.filter((line) => line === ".omp/")).toHaveLength(1);

      // With a negation line, order is significant: no dedupe, but missing entries still land.
      await writeFile(excludePath, "node_modules\n!keep-me\nnode_modules\n", "utf8");
      await ensurePrivateGitRepository(factory, cwd, storeRoot);
      const negated = (await readFile(excludePath, "utf8")).split("\n").filter(Boolean);
      expect(negated.slice(0, 3)).toEqual(["node_modules", "!keep-me", "node_modules"]);
      for (const ignored of DEFAULT_EXCLUDES) expect(negated).toContain(ignored);
      expect(negated).toContain(".omp/");
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
        (cwd2, env) => createGitRunner(cwd2, { env }),
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
