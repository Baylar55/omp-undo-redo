import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEnvGitRunner, createGitRunner } from "../src/core/git-runner.js";
import type { GitRunner } from "../src/core/types.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../src/index.js";

type Handler = (...args: unknown[]) => unknown;

const testStoreRoot = join(tmpdir(), `omp-undo-redo-gc-store-${process.pid}`);
process.env.OMP_UNDO_REDO_BLOB_DIR = testStoreRoot;

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
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (commands.some((command) => command[0] === "gc")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(
        commands.some((command) => command[0] === "gc" && command.includes("--prune=now")),
      ).toBe(true);
    } finally {
      await rmRetry(cwd);
    }
  });

  it("evicts private repos whose workspace no longer exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-evict-"));
    const reposDir = join(testStoreRoot, "repos");
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, {});
      const ctx = context(cwd, "evict-session");
      await runTurns(pi, ctx, 1, "tracked.txt");
      // The gc-trigger test (same file, shared store) left a repo behind;
      // this instance's boot sweep evicts it fire-and-forget, so settle on
      // exactly our own repo before asserting.
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await readdir(reposDir)).length === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await readdir(reposDir)).toHaveLength(1);
      // The workspace disappears; the shutdown sweep evicts its repo.
      await rmRetry(cwd);
      await pi.emit("session_shutdown", ctx);
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if ((await readdir(reposDir)).length === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(await readdir(reposDir)).toHaveLength(0);
    } finally {
      await rmRetry(cwd);
      await rm(testStoreRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});
