import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkpointNamespace, historyRefPrefix } from "../src/core/checkpoints.js";
import { createGitRunner } from "../src/core/git-runner.js";
import {
  ensurePrivateGitRepository,
  privateRepositoryPath,
  storeRootDirectory,
} from "../src/core/private-repo.js";
import type { GitRunner } from "../src/core/types.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../src/index.js";
import {
  context,
  FakeExtensionApi,
  gitRepository,
  makeRepository,
  rmRetry,
  type TestContext,
} from "./helpers.js";

const testStoreRoot = join(tmpdir(), `omp-undo-redo-gc-store-${process.pid}`);
process.env.OMP_UNDO_REDO_STORE_DIR = testStoreRoot;

afterAll(async () => {
  await rm(testStoreRoot, { recursive: true, force: true });
});

/** Isolated store per test: sweeps and background gcs from other instances
 *  can then never race this file's assertions on the repos directory. */
async function withHermeticStore(run: (reposDir: string) => Promise<void>): Promise<void> {
  const store = join(
    tmpdir(),
    `omp-undo-redo-store-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const previousStore = process.env.OMP_UNDO_REDO_STORE_DIR;
  process.env.OMP_UNDO_REDO_STORE_DIR = store;
  try {
    await run(join(store, "repos"));
  } finally {
    if (previousStore === undefined) delete process.env.OMP_UNDO_REDO_STORE_DIR;
    else process.env.OMP_UNDO_REDO_STORE_DIR = previousStore;
    await rm(store, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Backdates a repo past the 24h eviction idle cutoff, mirroring the
 *  lastActivityMs depth (repo root + direct children). */
async function backdateRepo(gitDir: string): Promise<void> {
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(gitDir, stale, stale);
  for (const child of await readdir(gitDir)) {
    await utimes(join(gitDir, child), stale, stale);
  }
}

/** Polls until predicate holds or the window lapses (housekeeping runs
 *  detached from session_shutdown, so callers must wait). */
async function waitFor(predicate: () => Promise<boolean>, attempts = 50): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Turns a fresh private-repo capture into the extension's housekeeping. */
async function runTurns(
  pi: FakeExtensionApi,
  ctx: TestContext,
  turns: number,
  tracked: string,
): Promise<void> {
  await pi.emit("session_start", ctx);
  for (let turn = 0; turn < turns; turn += 1) {
    ctx.leaf = `leaf${turn}`;
    await pi.emit("before_agent_start", ctx);
    await writeFile(join(ctx.cwd, tracked), `v${turn}\n`);
    await pi.emit("agent_end", ctx);
  }
}

describe("private-repo housekeeping", () => {
  it("runs a background git gc on the private repo after a capture threshold", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-gc-"));
    const commands: string[][] = [];
    try {
      const pi = new FakeExtensionApi();
      const dependencies: OmpUndoRedoDependencies = {
        gitRunnerFactory: (cwd2: string, env?: Record<string, string>): GitRunner => {
          const inner = env ? createGitRunner(cwd2, { env }) : createGitRunner(cwd2);
          const wrapped: GitRunner = async (args, options) => {
            commands.push(args);
            return inner(args, options);
          };
          return wrapped;
        },
      };
      ompUndoRedo(pi as never, dependencies);
      const ctx = context(cwd, "gc-session");
      // 20 turns = 20 before-captures → the 20-capture threshold schedules the
      // gc. (The after-captures run inside finalizeTurn, not beginCapture, so
      // they do not contribute to the counter.)
      await runTurns(pi, ctx, 20, "tracked.txt");
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (commands.some((command) => command[0] === "gc")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        commands.some((command) => command[0] === "gc" && command.includes("--prune=1.hour.ago")),
      ).toBe(true);
    } finally {
      await rmRetry(cwd);
    }
  }, 120000);

  it("gcs a Git workspace's snapshot store, never the user's own repository", async () => {
    // Regression: `isPrivateRepository` used to answer "yes" for any repo in
    // the shared `privateRepositories` map — which caches the user's own repo
    // in Git mode — so 20 turns triggered `gc --prune=now` with GIT_DIR
    // pointing at the workspace's .git.
    const cwd = await makeRepository("omp-undo-redo-gc-usergit-");
    const gcs: { args: string[]; gitDir?: string }[] = [];
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, {
        gitRunnerFactory: (cwd2: string, env?: Record<string, string>): GitRunner => {
          const inner = env ? createGitRunner(cwd2, { env }) : createGitRunner(cwd2);
          const wrapped: GitRunner = async (args, options) => {
            if (args[0] === "gc") gcs.push({ args, gitDir: env?.GIT_DIR });
            return inner(args, options);
          };
          wrapped.cwd = cwd2;
          if (env) wrapped.env = env;
          return wrapped;
        },
      });
      const ctx = context(cwd, "gc-usergit-session");
      await runTurns(pi, ctx, 20, "tracked.txt");
      await pi.emit("session_shutdown", ctx);
      // Shutdown housekeeping is detached, so a gc would appear after the
      // handler resolves: poll the recorded commands.
      const { storeDir, gitDir } = await gitRepository(cwd);
      expect(await waitFor(async () => gcs.some((gc) => gc.gitDir === storeDir), 20)).toBe(true);
      // Other stores under the shared root (earlier tests' repos) may be gc'd
      // by the retention sweep; the user's own repository never is.
      expect(gcs.some((gc) => gc.gitDir === gitDir)).toBe(false);
      // Shared by every process in the repository: never `--prune=now`.
      for (const gc of gcs) expect(gc.args).toContain("--prune=1.hour.ago");
    } finally {
      await rmRetry(cwd);
    }
  }, 120000);

  it("renames repos of vanished workspaces to recoverable trash, then purges aged trash", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-evict-"));
    try {
      await withHermeticStore(async (reposDir) => {
        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never, {});
        const ctx = context(cwd, "evict-session");
        await runTurns(pi, ctx, 1, "tracked.txt");
        // runTurns' agent_end awaits finalize, so the private repo exists
        // deterministically the moment the turn completes.
        expect(await readdir(reposDir)).toHaveLength(1);
        // The workspace disappears; the repo was captured seconds ago, so
        // backdate its mtimes past the 24h idle cutoff to make abandonment
        // decidable within the test.
        await rmRetry(cwd);
        const [repoEntry] = await readdir(reposDir);
        const gitDir = join(reposDir, repoEntry);
        await backdateRepo(gitDir);
        await pi.emit("session_shutdown", ctx);
        let trash = "";
        expect(
          await waitFor(async () => {
            const entries = await readdir(reposDir);
            trash = entries.find((name) => /\.evicted-\d+$/.test(name)) ?? "";
            return trash !== "" && !entries.some((name) => name.endsWith(".git"));
          }),
        ).toBe(true);
        // Eviction renames instead of deleting: history stays recoverable.
        expect(trash).toMatch(/\.evicted-\d+$/);
        await readFile(join(reposDir, trash, "config"), "utf8");

        // Trash aged past retention is purged by the next boot sweep.
        const agedName = trash.replace(
          /(\.evicted-)\d+$/,
          (_m, prefix: string) => `${prefix}${Date.now() - 8 * 24 * 60 * 60 * 1000}`,
        );
        await rename(join(reposDir, trash), join(reposDir, agedName));
        ompUndoRedo(new FakeExtensionApi() as never, {});
        expect(await waitFor(async () => (await readdir(reposDir)).length === 0)).toBe(true);
      });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("evicts the repo of a vanished workspace whose setup was abandoned after git init", async () => {
    // A crash between `git init` and the config calls left HEAD without
    // `core.worktree`, the only way the sweep learns a store's workspace, and
    // later launches trusted the store as it was: it was skipped forever.
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-evict-abandoned-"));
    try {
      await withHermeticStore(async (reposDir) => {
        const gitDir = privateRepositoryPath(storeRootDirectory(), cwd);
        await mkdir(reposDir, { recursive: true });
        const init = await createGitRunner(cwd, { env: { GIT_DIR: gitDir } })(["init", "-q"]);
        expect(init.code).toBe(0);
        // Quiet for a day: HEAD and config both, as a crashed launch leaves them.
        await backdateRepo(gitDir);

        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never, {});
        const ctx = context(cwd, "evict-abandoned-session");
        await runTurns(pi, ctx, 1, "tracked.txt");
        await rmRetry(cwd);
        await backdateRepo(gitDir);
        await pi.emit("session_shutdown", ctx);
        expect(
          await waitFor(async () =>
            (await readdir(reposDir)).some((name) => /\.evicted-\d+$/.test(name)),
          ),
        ).toBe(true);
      });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("evicts an unfinished, ref-less store whose workspace never relaunched, keeping one with refs", async () => {
    // No launch ever repairs a store whose workspace is gone, and without a
    // setup marker the sweep had no source to stat: it was skipped forever.
    await withHermeticStore(async (reposDir) => {
      const empty = privateRepositoryPath(storeRootDirectory(), join(tmpdir(), "omp-gone-empty"));
      const withRefs = privateRepositoryPath(storeRootDirectory(), join(tmpdir(), "omp-gone-refs"));
      await mkdir(reposDir, { recursive: true });
      for (const gitDir of [empty, withRefs]) {
        const init = await createGitRunner(reposDir, { env: { GIT_DIR: gitDir } })(["init", "-q"]);
        expect(init.code).toBe(0);
      }
      // Unfinished Git-mode stores are usable, so one may already hold snapshots.
      await mkdir(join(withRefs, "refs", "omp-undo-redo"), { recursive: true });
      await writeFile(join(withRefs, "refs", "omp-undo-redo", "x"), `${"0".repeat(40)}\n`);
      await backdateRepo(empty);
      await backdateRepo(withRefs);

      ompUndoRedo(new FakeExtensionApi() as never, {});
      expect(
        await waitFor(async () =>
          (await readdir(reposDir)).some((name) => name.startsWith(`${basename(empty)}.evicted-`)),
        ),
      ).toBe(true);
      expect(await readdir(reposDir)).toContain(basename(withRefs));
    });
  });

  it("keeps a freshly captured repo even when its workspace has vanished", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-evict-fresh-"));
    try {
      await withHermeticStore(async (reposDir) => {
        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never, {});
        const ctx = context(cwd, "evict-fresh-session");
        await runTurns(pi, ctx, 1, "tracked.txt");
        await rmRetry(cwd);
        // No backdating: captured seconds ago, so the 24h idle cutoff must
        // keep the repo in place across the shutdown sweep. Wait out a full
        // would-be eviction window (re-stat delay + rename retries) before
        // asserting that nothing was renamed.
        const [repoEntry] = await readdir(reposDir);
        await pi.emit("session_shutdown", ctx);
        const changed = await waitFor(
          async () => (await readdir(reposDir)).join(",") !== repoEntry,
          30,
        );
        expect(changed).toBe(false);
        expect(await readdir(reposDir)).toEqual([repoEntry]);
      });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("evicts a repo whose gc.pid is crash debris older than the idle cutoff", async () => {
    await withHermeticStore(async (reposDir) => {
      // Fabricate a minimal abandoned repo: the sweep consumes only the
      // <hash>.git layout, config's worktree pointer, and mtimes. No
      // session is involved, so no background gc can race the assertion.
      const worktreeParent = await mkdtemp(join(tmpdir(), "omp-undo-redo-stalegc-ws-"));
      try {
        const repoEntry = `${"f".repeat(64)}.git`;
        const gitDir = join(reposDir, repoEntry);
        await mkdir(gitDir, { recursive: true });
        await createGitRunner(reposDir)([
          "config",
          "--file",
          join(gitDir, "config"),
          "core.worktree",
          join(worktreeParent, "project"),
        ]);
        await writeFile(join(gitDir, "gc.pid"), "999999\n");
        await backdateRepo(gitDir);
        ompUndoRedo(new FakeExtensionApi() as never, {});
        let trash = "";
        expect(
          await waitFor(async () => {
            const entries = await readdir(reposDir);
            trash = entries.find((name) => /\.evicted-\d+$/.test(name)) ?? "";
            return trash !== "";
          }),
        ).toBe(true);
        // Renamed intact: contents stay recoverable.
        await readFile(join(reposDir, trash, "config"), "utf8");
      } finally {
        await rm(worktreeParent, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  it("keeps a repo whose live workspace path git quotes in config", async () => {
    // Regression: git writes `worktree = "C:\\…\\C# proj"` for values with
    // `#`/`;`; a raw regex kept quotes and escapes, stat hit ENOENT, and an
    // idle repo of a live workspace was evicted.
    await withHermeticStore(async (reposDir) => {
      const parent = await mkdtemp(join(tmpdir(), "omp-undo-redo-quoted-ws-"));
      try {
        const worktree = join(parent, "C# proj; 2");
        await mkdir(worktree);
        const repoEntry = `${"e".repeat(64)}.git`;
        const gitDir = join(reposDir, repoEntry);
        await mkdir(gitDir, { recursive: true });
        await createGitRunner(reposDir)([
          "config",
          "--file",
          join(gitDir, "config"),
          "core.worktree",
          worktree,
        ]);
        expect(await readFile(join(gitDir, "config"), "utf8")).toContain('"');
        await backdateRepo(gitDir);
        ompUndoRedo(new FakeExtensionApi() as never, {});
        const changed = await waitFor(
          async () => (await readdir(reposDir)).join(",") !== repoEntry,
          30,
        );
        expect(changed).toBe(false);
      } finally {
        await rm(parent, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  });

  it("skips eviction while a gc.pid file marks the repo as in use", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-evict-gcpid-"));
    try {
      await withHermeticStore(async (reposDir) => {
        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never, {});
        const ctx = context(cwd, "evict-gcpid-session");
        await runTurns(pi, ctx, 1, "tracked.txt");
        await rmRetry(cwd);
        const [repoEntry] = await readdir(reposDir);
        const gitDir = join(reposDir, repoEntry);
        await backdateRepo(gitDir);
        await writeFile(join(gitDir, "gc.pid"), "999999\n");
        await pi.emit("session_shutdown", ctx);
        // Wait out the full would-be eviction window; the pidfile must have
        // kept the rename from ever happening.
        const kept = await waitFor(
          async () => (await readdir(reposDir)).join(",") !== repoEntry,
          30,
        ).then((changed) => !changed);
        expect(kept).toBe(true);
        expect(await readdir(reposDir)).toEqual([repoEntry]);
      });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("does not treat a statable workspace path as vanished", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-evict-file-"));
    try {
      await withHermeticStore(async (reposDir) => {
        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never, {});
        const ctx = context(cwd, "evict-file-session");
        await runTurns(pi, ctx, 1, "tracked.txt");
        await rmRetry(cwd);
        const [repoEntry] = await readdir(reposDir);
        await backdateRepo(join(reposDir, repoEntry));
        // The path exists again — but as a file. stat succeeds, so nothing
        // may be read as "gone".
        await writeFile(cwd, "placeholder\n");
        await pi.emit("session_shutdown", ctx);
        const kept = await waitFor(
          async () => (await readdir(reposDir)).join(",") !== repoEntry,
          30,
        ).then((changed) => !changed);
        expect(kept).toBe(true);
        expect(await readdir(reposDir)).toEqual([repoEntry]);
      });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("expires and prunes aged history in a private repo no session reopens", async () => {
    await withHermeticStore(async (reposDir) => {
      const dormant = await mkdtemp(join(tmpdir(), "omp-undo-redo-retention-dormant-"));
      const current = await mkdtemp(join(tmpdir(), "omp-undo-redo-retention-current-"));
      try {
        const repository = await ensurePrivateGitRepository(
          (cwd2, env) => createGitRunner(cwd2, env ? { env } : undefined),
          dormant,
          join(reposDir, ".."),
        );
        if (!repository) throw new Error("private repo init failed");
        const git = createGitRunner(dormant, { env: { GIT_DIR: repository.gitDir } });
        const out = async (args: string[], stdin?: string): Promise<string> =>
          (await git(args, stdin === undefined ? undefined : { stdin })).stdout.trim();
        const historyDir = join(repository.gitDir, "omp-undo-redo", "history");
        await mkdir(historyDir, { recursive: true });
        const seedSession = async (id: string, content: string, accessedAt: Date) => {
          const blob = await out(["hash-object", "-w", "--stdin"], content);
          const tree = await out(["mktree"], `100644 blob ${blob}\tsecret.env\n`);
          const commit = await out(
            ["-c", "user.name=t", "-c", "user.email=t@t", "commit-tree", tree, "-m", id],
            "",
          );
          const hash = checkpointNamespace(id);
          await git(["update-ref", `${historyRefPrefix(hash)}c1/before`, commit]);
          await writeFile(
            join(historyDir, `${hash}.json`),
            JSON.stringify({ lastAccessedAt: accessedAt.toISOString() }),
          );
          return { blob, prefix: historyRefPrefix(hash) };
        };
        const aged = await seedSession("aged", "SECRET=aged\n", new Date(Date.now() - 3 * 864e5));
        const live = await seedSession("live", "SECRET=live\n", new Date());
        // Snapshot objects are days old by the time their session expires.
        const old = new Date(Date.now() - 3 * 864e5);
        const objectsDir = join(repository.gitDir, "objects");
        for (const fanout of await readdir(objectsDir)) {
          if (!/^[0-9a-f]{2}$/.test(fanout)) continue;
          for (const name of await readdir(join(objectsDir, fanout))) {
            await utimes(join(objectsDir, fanout, name), old, old);
          }
        }
        // Unreferenced and fresh: what an in-flight capture has written.
        const inFlight = await out(["hash-object", "-w", "--stdin"], "SECRET=in-flight\n");
        const exists = async (object: string) => (await git(["cat-file", "-e", object])).code === 0;

        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never, {});
        const ctx = context(current, "retention-current-session");
        await pi.emit("session_start", ctx);
        expect(await waitFor(async () => !(await exists(aged.blob)), 150)).toBe(true);
        expect(await out(["for-each-ref", aged.prefix])).toBe("");
        expect(await out(["for-each-ref", live.prefix])).not.toBe("");
        expect(await exists(live.blob)).toBe(true);
        expect(await exists(inFlight)).toBe(true);
        await pi.emit("session_shutdown", ctx);
      } finally {
        await rmRetry(dormant);
        await rmRetry(current);
      }
    });
  }, 60000);
});
