import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ompUndoRedo from "../src/index.js";
import { applyCheckpoint, finishAfterTurn, prepareBeforeTurn } from "../src/core/checkpoints.js";
import { SessionNavigation } from "../src/core/session-navigation.js";
import type { GitRunner } from "../src/core/types.js";

const execFileAsync = promisify(execFile);

const { mockState, createdMockDirs } = vi.hoisted(() => {
  return {
    mockState: {
      failMkdtempPrefix: null as string | null,
      failRmForMockDirs: false,
    },
    createdMockDirs: new Set<string>(),
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    mkdtemp: vi.fn(async (prefix: string, options?: Parameters<typeof actual.mkdtemp>[1]) => {
      if (mockState.failMkdtempPrefix && prefix.includes(mockState.failMkdtempPrefix)) {
        throw new Error(`Simulated mkdtemp failure for prefix ${prefix}`);
      }
      const dir = await actual.mkdtemp(prefix, options);
      if (prefix.includes("omp-undo-redo-index-") || prefix.includes("omp-undo-redo-patch-")) {
        createdMockDirs.add(dir);
      }
      return dir;
    }),
    rm: vi.fn(
      async (path: Parameters<typeof actual.rm>[0], options?: Parameters<typeof actual.rm>[1]) => {
        const pathStr = String(path);
        if (mockState.failRmForMockDirs && createdMockDirs.has(pathStr)) {
          throw new Error(`Simulated rm failure for directory ${pathStr}`);
        }
        return actual.rm(path, options);
      },
    ),
  };
});

type Handler = (...args: unknown[]) => unknown;

type TestContext = {
  cwd: string;
  leaf: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string;
    getBranch(): [];
    getEntry(): undefined;
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
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => value.leaf,
      getBranch: () => [],
      getEntry: () => undefined,
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

async function rawGit(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

function makeGitRunner(cwd: string, options?: { failCommand?: string }): GitRunner {
  return async (args, runOpts) => {
    if (options?.failCommand && args.includes(options.failCommand)) {
      return { code: 1, stdout: "", stderr: "simulated git failure", error: null };
    }
    if (runOpts?.stdin !== undefined) {
      const child = spawn("git", args, {
        cwd: runOpts?.cwd ?? cwd,
        env: { ...process.env, ...runOpts?.env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.on("error", () => {});
      child.stdin.end(runOpts.stdin);
      try {
        const [code] = (await once(child, "close")) as [number | null];
        return { stdout, stderr, code: typeof code === "number" ? code : 1, error: null };
      } catch (error) {
        return { stdout, stderr: `${stderr}${String(error)}`, code: 1, error: null };
      }
    }
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: runOpts?.cwd ?? cwd,
        env: runOpts?.env ? { ...process.env, ...runOpts.env } : undefined,
        windowsHide: true,
      });
      return { code: 0, stdout, stderr, error: null };
    } catch (err: unknown) {
      const error = err as { code?: number; stdout?: string; stderr?: string };
      return {
        code: error.code ?? 1,
        stdout: error.stdout ?? "",
        stderr: error.stderr ?? "",
        error: null,
      };
    }
  };
}

async function makeRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-temp-fail-"));
  await rawGit(cwd, ["init", "-q"]);
  await rawGit(cwd, ["config", "user.name", "test"]);
  await rawGit(cwd, ["config", "user.email", "test@example.com"]);
  await rawGit(cwd, ["config", "core.autocrlf", "false"]);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await rawGit(cwd, ["add", "."]);
  await rawGit(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

async function privateRefs(cwd: string): Promise<string[]> {
  const output = await rawGit(cwd, ["for-each-ref", "--format=%(refname)", "refs/omp-undo-redo/"]);
  return output ? output.split("\n") : [];
}

describe("temp-directory failure resilience", () => {
  beforeEach(() => {
    mockState.failMkdtempPrefix = null;
    mockState.failRmForMockDirs = false;
  });

  afterEach(async () => {
    const actualFs = await vi.importActual<typeof FsPromises>("node:fs/promises");
    const directories = [...createdMockDirs];
    mockState.failMkdtempPrefix = null;
    mockState.failRmForMockDirs = false;
    try {
      await Promise.all(
        directories.map((directory) => actualFs.rm(directory, { recursive: true, force: true })),
      );
    } finally {
      createdMockDirs.clear();
    }
  });

  it("A. before-snapshot allocation failure preserves session-only undo/redo", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "sess-before-alloc-fail");

      await pi.emit("session_start", ctx);

      mockState.failMkdtempPrefix = "omp-undo-redo-index-";

      await expect(pi.emit("before_agent_start", ctx)).resolves.toBeUndefined();

      mockState.failMkdtempPrefix = null;

      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn-1";

      await pi.emit("agent_end", ctx);

      expect(await privateRefs(cwd)).toEqual([]);

      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };

      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("leaf");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the file checkpoint could not be created.",
      );

      await pi.runCommand("redo", ctx);
      expect(ctx.leaf).toBe("turn-1");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid the session turn, but files were not restored because the file checkpoint could not be created.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("B. after-snapshot allocation failure releases the pending ref", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "sess-after-alloc-fail");

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      expect(await privateRefs(cwd)).toHaveLength(1);

      mockState.failMkdtempPrefix = "omp-undo-redo-index-";
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn-1";

      await expect(pi.emit("agent_end", ctx)).resolves.toBeUndefined();

      expect(await privateRefs(cwd)).toEqual([]);

      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };

      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("leaf");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the file checkpoint could not be created.",
      );

      await pi.runCommand("redo", ctx);
      expect(ctx.leaf).toBe("turn-1");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid the session turn, but files were not restored because the file checkpoint could not be created.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("C. snapshot cleanup failure cannot override successful capture", async () => {
    const cwd = await makeRepository();
    try {
      const gitRunner = makeGitRunner(cwd);
      mockState.failRmForMockDirs = true;

      const beforeRes = await prepareBeforeTurn(gitRunner, "sess-cleanup-fail");
      expect(beforeRes.status).toBe("git");
      if (beforeRes.status !== "git") return;
      expect(await privateRefs(cwd)).toHaveLength(1);

      await writeFile(join(cwd, "tracked.txt"), "changed\n");

      const afterRes = await finishAfterTurn(gitRunner, beforeRes.checkpoint, "leaf", "turn-1");
      expect(afterRes.status).toBe("git");
      if (afterRes.status !== "git") return;
      expect(await privateRefs(cwd)).toHaveLength(2);

      let currentLeaf = "turn-1";
      const nav = new SessionNavigation(
        {
          getLeafId: () => currentLeaf,
          navigateTree: async (targetId) => {
            currentLeaf = targetId;
            return { cancelled: false };
          },
        },
        gitRunner,
      );
      await nav.recordTurnEnd(afterRes.checkpoint);

      const undoResult = await nav.undo();
      expect(undoResult.status).toBe("moved");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");

      const redoResult = await nav.redo();
      expect(redoResult.status).toBe("moved");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("D. snapshot cleanup failure does not hide an operation failure", async () => {
    const cwd = await makeRepository();
    try {
      const gitRunner = makeGitRunner(cwd);

      const beforeRes = await prepareBeforeTurn(gitRunner, "sess-op-and-cleanup-fail");
      expect(beforeRes.status).toBe("git");
      if (beforeRes.status !== "git") return;

      const failingGitRunner = makeGitRunner(cwd, { failCommand: "write-tree" });
      mockState.failRmForMockDirs = true;

      const afterRes = await finishAfterTurn(
        failingGitRunner,
        beforeRes.checkpoint,
        "leaf",
        "turn-1",
      );

      expect(afterRes.status).toBe("session_only");
      if (afterRes.status === "session_only") {
        expect(afterRes.reason).toBe("after_snapshot_failed");
      }

      expect(await privateRefs(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("E. patch allocation failure returns 'failed' without mutation", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "sess-patch-alloc-fail");

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn-1";
      await pi.emit("agent_end", ctx);

      expect(await privateRefs(cwd)).toHaveLength(2);

      const headTreeBefore = await rawGit(cwd, ["rev-parse", "HEAD^{tree}"]);
      const fileContentBefore = await readFile(join(cwd, "tracked.txt"), "utf8");

      mockState.failMkdtempPrefix = "omp-undo-redo-patch-";

      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };

      await pi.runCommand("undo", ctx);

      expect(ctx.leaf).toBe("turn-1");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe(fileContentBefore);
      expect(await rawGit(cwd, ["rev-parse", "HEAD^{tree}"])).toBe(headTreeBefore);
      expect(ctx.ui.notifications.at(-1)?.message).toBe("Could not restore the Git checkpoint.");

      mockState.failMkdtempPrefix = null;
      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("leaf");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("F. patch cleanup failure preserves the primary apply result", async () => {
    const cwd = await makeRepository();
    try {
      const gitRunner = makeGitRunner(cwd);

      const beforeRes = await prepareBeforeTurn(gitRunner, "sess-patch-cleanup");
      expect(beforeRes.status).toBe("git");
      if (beforeRes.status !== "git") return;

      await writeFile(join(cwd, "tracked.txt"), "modified\n");
      const afterRes = await finishAfterTurn(gitRunner, beforeRes.checkpoint, "leaf", "t1");
      expect(afterRes.status).toBe("git");
      if (afterRes.status !== "git") return;

      mockState.failRmForMockDirs = true;

      let currentLeaf = "t1";
      const nav = new SessionNavigation(
        {
          getLeafId: () => currentLeaf,
          navigateTree: async (targetId) => {
            currentLeaf = targetId;
            return { cancelled: false };
          },
        },
        gitRunner,
      );
      await nav.recordTurnEnd(afterRes.checkpoint);

      const undoRes = await nav.undo();
      expect(undoRes.status).toBe("moved");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");

      await writeFile(join(cwd, "tracked.txt"), "conflicting content\n");
      const redoRes = await nav.redo();
      expect(redoRes.status).toBe("git_failed");
      if (redoRes.status === "git_failed") {
        expect(redoRes.failure).toBe("conflict");
      }
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("conflicting content\n");

      const emptyApplyRes = await applyCheckpoint(
        gitRunner,
        afterRes.checkpoint.afterHash,
        afterRes.checkpoint.afterHash,
      );
      expect(emptyApplyRes).toBe("applied");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
