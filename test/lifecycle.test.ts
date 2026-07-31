import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import ompUndoRedo from "../src/index.js";

const execFileAsync = promisify(execFile);
type Handler = (...args: unknown[]) => unknown;

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

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function makeRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-lifecycle-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

async function makeUnbornRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-unborn-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  return cwd;
}

async function privateRefs(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/omp-undo-redo/"]);
  return output ? output.split("\n") : [];
}

async function prepareUndoneSession(
  pi: FakeExtensionApi,
  cwd: string,
  sessionId: string,
): Promise<TestContext> {
  const ctx = context(cwd, sessionId);
  await pi.emit("session_start", ctx);
  await pi.emit("before_agent_start", ctx);
  await writeFile(join(cwd, "tracked.txt"), "changed\n");
  ctx.leaf = "turn";
  await pi.emit("agent_end", ctx);
  ctx.navigateTree = async (targetId) => {
    const oldLeafId = ctx.leaf;
    ctx.leaf = targetId;
    await pi.emit("session_tree", ctx, {
      type: "session_tree",
      oldLeafId,
      newLeafId: targetId,
    });
    return { cancelled: false };
  };
  await pi.runCommand("undo", ctx);
  return ctx;
}

describe("session-only lifecycle fallback", () => {
  it("keeps non-Git turns undoable without changing files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-non-git-lifecycle-"));
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = await prepareUndoneSession(pi, cwd, "non-git-session");

      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the working directory is not a Git repository.",
      );
      await pi.runCommand("redo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid the session turn, but files were not restored because the working directory is not a Git repository.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("restores files for turns in an unborn repository", async () => {
    const cwd = await makeUnbornRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = await prepareUndoneSession(pi, cwd, "unborn-session");

      await expect(readFile(join(cwd, "tracked.txt"))).rejects.toThrow();
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid last turn: session moved back and worktree snapshot restored; Git index left unchanged.",
      );
      expect(await privateRefs(cwd)).toHaveLength(2);
      const refs = await privateRefs(cwd);
      expect(refs.every((ref) => ref.startsWith("refs/omp-undo-redo/history/"))).toBe(true);
      await pi.runCommand("redo", ctx);
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid last turn: session moved forward and worktree snapshot restored; Git index left unchanged.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("retains a session boundary when after-snapshot creation fails", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "after-failure-session");
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      expect(await privateRefs(cwd)).toHaveLength(1);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      await writeFile(join(cwd, ".git", "HEAD"), "not-a-head\n");
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);
      await writeFile(join(cwd, ".git", "HEAD"), "ref: refs/heads/master\n");
      expect(await privateRefs(cwd)).toEqual([]);

      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      await pi.runCommand("undo", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the Git repository has an invalid HEAD.",
      );
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps undo and redo traversable across a file-history gap", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "file-history-gap-session");
      await pi.emit("session_start", ctx);
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };

      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "B\n");
      ctx.leaf = "turn-1";
      await pi.emit("agent_end", ctx);
      expect(await privateRefs(cwd)).toHaveLength(2);

      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "C\n");
      const head = await readFile(join(cwd, ".git", "HEAD"), "utf8");
      await writeFile(join(cwd, ".git", "HEAD"), "not-a-head\n");
      ctx.leaf = "turn-2";
      await pi.emit("agent_end", ctx);
      await writeFile(join(cwd, ".git", "HEAD"), head);
      expect(await privateRefs(cwd)).toEqual([]);

      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "D\n");
      ctx.leaf = "turn-3";
      await pi.emit("agent_end", ctx);
      expect(await privateRefs(cwd)).toHaveLength(2);

      await pi.runCommand("undo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("C\n");
      await pi.runCommand("undo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("C\n");
      await pi.runCommand("undo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("C\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because a later turn had no file checkpoint, so this older file checkpoint was discarded.",
      );

      await pi.runCommand("redo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("C\n");
      await pi.runCommand("redo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("C\n");
      await pi.runCommand("redo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("D\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("navigation invalidation lifecycle", () => {
  it("clears redo after unrelated session tree navigation", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = await prepareUndoneSession(pi, cwd, "tree-session");

      const oldLeafId = ctx.leaf;
      ctx.leaf = "unrelated";
      await pi.emit("session_tree", ctx, {
        type: "session_tree",
        oldLeafId,
        newLeafId: ctx.leaf,
      });
      await pi.runCommand("redo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe("Nothing to redo in this session.");
      expect(await privateRefs(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("clears redo for successful source session switches and branches", async () => {
    for (const event of ["session_switch", "session_branch"] as const) {
      const cwd = await makeRepository();
      try {
        const pi = new FakeExtensionApi();
        ompUndoRedo(pi as never);
        const ctx = await prepareUndoneSession(pi, cwd, `${event}-session`);
        const beforeEvent =
          event === "session_switch" ? "session_before_switch" : "session_before_branch";
        await pi.emit(beforeEvent, ctx);
        await pi.emit(event, ctx);
        await pi.runCommand("redo", ctx);

        expect(ctx.ui.notifications.at(-1)?.message).toBe("Nothing to redo in this session.");
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }
  });

  it("preserves redo when a switch is cancelled before its post-event", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = await prepareUndoneSession(pi, cwd, "cancelled-switch-session");

      await pi.emit("session_before_switch", ctx);
      await pi.runCommand("redo", ctx);

      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid last turn: session moved forward and worktree snapshot restored; Git index left unchanged.",
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("resumed session history", () => {
  it("restores undo and redo checkpoints across runtime restarts", async () => {
    const cwd = await makeRepository();
    const sessionId = "resumed-session";
    const prompt: TestEntry = {
      id: "prompt",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const response: TestEntry = {
      id: "response",
      parentId: prompt.id,
      type: "message",
      message: { role: "assistant" },
    };
    const firstExit: TestEntry = {
      id: "first-exit",
      parentId: response.id,
      type: "custom",
      customType: "session_exit",
    };
    const secondExit: TestEntry = {
      id: "second-exit",
      parentId: prompt.id,
      type: "custom",
      customType: "session_exit",
    };
    try {
      const firstApi = new FakeExtensionApi();
      ompUndoRedo(firstApi as never);
      const first = context(cwd, sessionId);
      first.leaf = prompt.id;
      first.branch = [prompt];
      first.entries = [prompt];
      await firstApi.emit("session_start", first);
      await firstApi.emit("before_agent_start", first);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      first.leaf = response.id;
      first.branch = [prompt, response];
      first.entries = [prompt, response];
      await firstApi.emit("agent_end", first);
      await firstApi.emit("session_shutdown", first);

      const secondApi = new FakeExtensionApi();
      ompUndoRedo(secondApi as never);
      const second = context(cwd, sessionId);
      second.leaf = firstExit.id;
      second.branch = [prompt, response, firstExit];
      second.entries = [prompt, response, firstExit];
      second.navigateTree = async (targetId) => {
        second.leaf = targetId;
        second.branch = targetId === prompt.id ? [prompt] : [prompt, response];
        return { cancelled: false };
      };
      await secondApi.emit("session_start", second);
      await writeFile(join(cwd, "tracked.txt"), "manual\n");
      await secondApi.runCommand("undo", second);
      expect(second.leaf).toBe(firstExit.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("manual\n");
      expect(second.ui.notifications.at(-1)?.message).toBe("Worktree changed; nothing was undone.");
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      await secondApi.runCommand("undo", second);
      expect(second.leaf).toBe(prompt.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      await secondApi.emit("session_shutdown", second);

      const thirdApi = new FakeExtensionApi();
      ompUndoRedo(thirdApi as never);
      const third = context(cwd, sessionId);
      third.leaf = secondExit.id;
      third.branch = [prompt, secondExit];
      third.entries = [prompt, response, firstExit, secondExit];
      third.navigateTree = async (targetId) => {
        third.leaf = targetId;
        third.branch = targetId === prompt.id ? [prompt] : [prompt, response];
        return { cancelled: false };
      };
      await thirdApi.emit("session_start", third);
      await thirdApi.runCommand("redo", third);
      expect(third.leaf).toBe(response.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(third.ui.notifications.at(-1)?.message).toBe(
        "Redid last turn: session moved forward and worktree snapshot restored; Git index left unchanged.",
      );
      await thirdApi.emit("session_shutdown", third);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reconstructs conversation-only undo when no durable file history exists", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-resumed-session-only-"));
    const prompt: TestEntry = {
      id: "prompt",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const response: TestEntry = {
      id: "response",
      parentId: prompt.id,
      type: "message",
      message: { role: "assistant" },
    };
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "resumed-session-only");
      ctx.leaf = response.id;
      ctx.branch = [prompt, response];
      ctx.entries = [prompt, response];
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        ctx.branch = [prompt];
        return { cancelled: false };
      };

      await pi.emit("session_start", ctx);
      await pi.runCommand("undo", ctx);

      expect(ctx.leaf).toBe(prompt.id);
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the resumed turn has no usable file checkpoint.",
      );
      await pi.emit("session_shutdown", ctx);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("extension lifecycle cleanup", () => {
  it("retains completed checkpoints, releases pending checkpoints, and preserves unrelated refs", async () => {
    const cwd = await makeRepository();
    try {
      await git(cwd, ["update-ref", "refs/keep", "HEAD"]);
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "session-one");

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      await pi.emit("agent_end", ctx);
      expect(await privateRefs(cwd)).toHaveLength(2);

      await pi.emit("session_shutdown", ctx);
      await pi.emit("session_shutdown", ctx);
      expect(await privateRefs(cwd)).toHaveLength(2);
      expect(await git(cwd, ["rev-parse", "refs/keep"])).toBe(
        await git(cwd, ["rev-parse", "HEAD"]),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drains pending checkpoints when shutdown interrupts a turn", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "pending-session");

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      expect(await privateRefs(cwd)).toHaveLength(1);
      await pi.emit("session_shutdown", ctx);
      expect(await privateRefs(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("retains resumable history for every in-memory session and repository", async () => {
    const first = await makeRepository();
    const second = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const firstContext = context(first, "first-session");
      const secondContext = context(second, "second-session");

      await pi.emit("session_start", firstContext);
      await pi.emit("before_agent_start", firstContext);
      await writeFile(join(first, "tracked.txt"), "first change\n");
      await pi.emit("agent_end", firstContext);
      await pi.emit("session_start", secondContext);
      await pi.emit("before_agent_start", secondContext);
      await writeFile(join(second, "tracked.txt"), "second change\n");
      await pi.emit("agent_end", secondContext);
      expect(await privateRefs(first)).toHaveLength(2);
      expect(await privateRefs(second)).toHaveLength(2);

      await pi.emit("session_shutdown", secondContext);
      expect(await privateRefs(first)).toHaveLength(2);
      expect(await privateRefs(second)).toHaveLength(2);
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });
});
