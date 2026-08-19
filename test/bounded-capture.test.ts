import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createEnvGitRunner, createGitRunner } from "../src/core/git-runner.js";
import type { GitRunner } from "../src/core/types.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../src/index.js";

type Handler = (...args: unknown[]) => unknown;

const testStoreRoot = join(tmpdir(), `omp-undo-redo-test-store-${process.pid}`);
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

/** A runner factory whose git-add invocations take `delayMs` to complete.
 *  The returned waiter lets tests await an exact number of completed adds,
 *  so they never race wall-clock timers. */
function slowAddRunnerFactory(delayMs: number): {
  runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]>;
  waitForAdds: (n: number, timeoutMs?: number) => Promise<void>;
} {
  let count = 0;
  const listeners = new Set<() => void>();
  const waitForAdds = (n: number, timeoutMs = 5000): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (count >= n) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${n} git adds (saw ${count})`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });
  const runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]> = (
    cwd: string,
    env?: Record<string, string>,
  ): GitRunner => {
    const inner = env ? createEnvGitRunner(cwd, env) : createGitRunner(cwd);
    const slow: GitRunner = async (args, options) => {
      if (args.includes("add")) {
        const result = await inner(args, options);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        count += 1;
        listeners.forEach((listener) => listener());
        return result;
      }
      return inner(args, options);
    };
    slow.cwd = cwd;
    return slow;
  };
  return { runner, waitForAdds };
}

/** Like `slowAddRunnerFactory`, but also slows the snapshot's post-add chain
 *  (`write-tree`/`commit-tree`/`update-ref`), so a capture stays in flight well
 *  past any handler deadline even after `waitForAdds(1)` has confirmed the
 *  before-snapshot content. Makes the deferred-finalize race deterministic. */
function raceRunnerFactory(delayMs: number): {
  runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]>;
  waitForAdds: (n: number, timeoutMs?: number) => Promise<void>;
} {
  let count = 0;
  const listeners = new Set<() => void>();
  const waitForAdds = (n: number, timeoutMs = 8000): Promise<void> =>
    new Promise((resolve, reject) => {
      const check = () => {
        if (count >= n) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for ${n} git adds (saw ${count})`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        listeners.delete(check);
      };
      listeners.add(check);
      check();
    });
  const runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]> = (
    cwd: string,
    env?: Record<string, string>,
  ): GitRunner => {
    const inner = env ? createEnvGitRunner(cwd, env) : createGitRunner(cwd);
    const slow: GitRunner = async (args, options) => {
      if (args.includes("add")) {
        const result = await inner(args, options);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        count += 1;
        listeners.forEach((listener) => listener());
        return result;
      }
      if (["write-tree", "commit-tree", "update-ref", "rev-parse"].includes(args[0] ?? "")) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return inner(args, options);
      }
      return inner(args, options);
    };
    slow.cwd = cwd;
    return slow;
  };
  return { runner, waitForAdds };
}

describe("bounded capture lifecycle", () => {
  it("returns from before_agent_start before a slow file capture finishes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-bounded-"));
    const { runner, waitForAdds } = slowAddRunnerFactory(500);
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "bounded-session");
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await expect(waitForAdds(1, 200)).rejects.toThrow("timed out");
    } finally {
      await waitForAdds(1).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rmRetry(cwd);
    }
  });

  it("finalizes a turn whose before-capture overruns the handler deadline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-bounded-"));
    const { runner, waitForAdds } = raceRunnerFactory(500);
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "bounded-session");
      await pi.emit("session_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await pi.emit("before_agent_start", ctx);
      // waitForAdds(1) confirms the before-snapshot captured the pre-turn
      // state (the add's inner already ran), so the turn's change lands
      // deterministically AFTER the snapshot regardless of load. The slowed
      // post-add chain keeps the capture in flight past the 200 ms handler
      // deadline, so the finalize defers.
      await waitForAdds(1);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);
      await waitForAdds(2);
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await pi.runCommand("undo", ctx);
        const message = ctx.ui.notifications.at(-1)?.message ?? "";
        if (message.includes("Nothing to undo") || message.includes("still being captured")) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        break;
      }
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("base\n");
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
    } finally {
      await waitForAdds(2).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rmRetry(cwd);
    }
  });

  it("keeps a deferred finalize bound to its turn when a later turn starts before it settles", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-race-"));
    const { runner, waitForAdds } = raceRunnerFactory(500);
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "race-session");
      await pi.emit("session_start", ctx);
      // Turn N: pre-turn state "base". The before-capture's add runs
      // immediately; waitForAdds(1) confirms the snapshot content before the
      // turn changes the file. The slowed post-add chain keeps the capture in
      // flight well past the 200 ms handler deadline, so N's finalize defers.
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      ctx.leaf = "leafN";
      await pi.emit("before_agent_start", ctx);
      await waitForAdds(1);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      await pi.emit("agent_end", ctx);
      // Turn N+1 starts while N's capture is still settling. The in-flight
      // guard must skip a new capture so a slow workspace never stacks
      // overlapping `git add` runs.
      ctx.leaf = "leafN1";
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed-again\n");
      await pi.emit("agent_end", ctx);
      await waitForAdds(2);
      // Only N's before + after adds exist — N+1's guarded turn added none.
      await expect(waitForAdds(3, 200)).rejects.toThrow("timed out");
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await pi.runCommand("undo", ctx);
        const message = ctx.ui.notifications.at(-1)?.message ?? "";
        if (message.includes("Nothing to undo") || message.includes("still being captured")) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          continue;
        }
        break;
      }
      // The undo must restore N's pre-turn state — not N+1's "changed-again".
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("base\n");
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
    } finally {
      await waitForAdds(3).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rmRetry(cwd);
    }
  });

  it("warns instead of navigating while the before-capture is still in flight", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-bounded-"));
    const { runner, waitForAdds } = slowAddRunnerFactory(500);
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "bounded-session");
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await pi.runCommand("undo", ctx);
      const message = ctx.ui.notifications.at(-1)?.message ?? "";
      expect(message).toContain("still being captured");
    } finally {
      await waitForAdds(1).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rmRetry(cwd);
    }
  });

  it("keeps the synchronous path when the capture finishes within the deadline", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-bounded-"));
    try {
      const pi = new FakeExtensionApi();
      const { runner, waitForAdds } = slowAddRunnerFactory(10);
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "bounded-session");
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await waitForAdds(1);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);
      // The after-capture's git add is the slow phase (delay + git add);
      // once it is in, the remaining write-tree/commit-tree/update-ref chain
      // is fast, so the undo's own bounded wait (200ms) will find the
      // capture complete and take the synchronous path. Waiting on the add
      // count (not wall-clock) makes this deterministic under parallel load.
      await waitForAdds(2);
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      await pi.runCommand("undo", ctx);
      await expect(readFile(join(cwd, "tracked.txt"))).rejects.toThrow();
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
      await pi.runCommand("redo", ctx);
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
    } finally {
      await rmRetry(cwd);
    }
  });
});
