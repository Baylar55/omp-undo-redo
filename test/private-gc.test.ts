import { mkdir, mkdtemp, readFile, readdir, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEnvGitRunner, createGitRunner } from "../src/core/git-runner.js";
import type { GitRunner } from "../src/core/types.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../src/index.js";

type Handler = (...args: unknown[]) => unknown;

const testStoreRoot = join(tmpdir(), `omp-undo-redo-gc-store-${process.pid}`);
process.env.OMP_UNDO_REDO_STORE_DIR = testStoreRoot;

afterAll(async () => {
  await rm(testStoreRoot, { recursive: true, force: true });
});

async function rmRetry(path: string, attempts = 6): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

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

type TestEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string };
  customType?: string;
};

type TestContext = {
  branch: TestEntry[];
  entries: TestEntry[];
  leaf: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string;
    getBranch(): TestEntry[];
    getEntry(id: string): TestEntry | undefined;
  };
  navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
  waitForIdle(): Promise<void>;
  isIdle(): boolean;
  ui: {
    notifications: Array<{ message: string; level: string }>;
    notify(message: string, level: string): void;
  };
};

class FakeExtensionApi {
  private readonly handlers = new Map<string, Handler>();
  private readonly commands = new Map<string, Handler>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  registerCommand(name: string, config: { handler: Handler }): void {
    this.commands.set(name, config.handler);
  }

  async runCommand(name: string, context: TestContext): Promise<void> {
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`No command registered for ${name}`);
    await handler("", context);
  }

  async emit(
    event: string,
    context: TestContext,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for ${event}`);
    await handler(payload ?? { type: event }, context);
  }
}

function context(cwd: string, sessionId: string): TestContext {
  const value: TestContext = {
    cwd,
    leaf: "leaf",
    branch: [],
    entries: [],
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => value.leaf,
      getBranch: () => value.branch,
      getEntry: (id) => value.entries.find((entry) => entry.id === id),
    },
    navigateTree: async () => ({ cancelled: true }),
    waitForIdle: async () => {},
    isIdle: () => true,
    ui: {
      notifications: [],
      notify(message, level) {
        value.ui.notifications.push({ message, level });
      },
    },
  };
  return value;
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
          const inner = env ? createEnvGitRunner(cwd2, env) : createGitRunner(cwd2);
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
        commands.some((command) => command[0] === "gc" && command.includes("--prune=now")),
      ).toBe(true);
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
        await writeFile(
          join(gitDir, "config"),
          `[core]\n\tworktree = ${join(worktreeParent, "project")}\n`,
        );
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
});
