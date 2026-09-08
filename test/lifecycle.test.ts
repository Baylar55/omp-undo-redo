import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkpointNamespace } from "../src/core/checkpoints.js";
import { runtimeRootDirectory } from "../src/core/runtime-action-state-store.js";
import ompUndoRedo from "../src/index.js";
import {
  context,
  FakeExtensionApi,
  git,
  makeRepository,
  privateRefs,
  rmRetry as rmRetryTimes,
  type TestContext,
  type TestEntry,
} from "./helpers.js";

/** Lifecycle tests tear down whole workspaces whose captures may still be
 *  settling, so they retry longer than the shared default. */
const rmRetry = (path: string): Promise<void> => rmRetryTimes(path, 10);

async function makeUnbornRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-unborn-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  return cwd;
}

async function runtimeState(sessionId: string): Promise<Record<string, unknown>> {
  const path = join(
    runtimeRootDirectory(),
    String(process.pid),
    "sessions",
    `${checkpointNamespace(sessionId)}.json`,
  );
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
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
  it("restores non-Git files during undo and redo", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-non-git-lifecycle-"));
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = await prepareUndoneSession(pi, cwd, "non-git-session");

      await expect(readFile(join(cwd, "tracked.txt"))).rejects.toThrow();
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
      await pi.runCommand("redo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
    } finally {
      await rmRetry(cwd);
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
        "Undid last turn: session moved back and file snapshot restored.",
      );
      expect(await privateRefs(cwd)).toHaveLength(2);
      const refs = await privateRefs(cwd);
      expect(refs.every((ref) => ref.startsWith("refs/omp-undo-redo/history/"))).toBe(true);
      await pi.runCommand("redo", ctx);
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid last turn: session moved forward and file snapshot restored.",
      );
    } finally {
      await rmRetry(cwd);
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
      await rmRetry(cwd);
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
      await rmRetry(cwd);
    }
  });

  it("restores files outside the session cwd when the session starts in a subdirectory", async () => {
    // Regression: `git apply` ignores patched paths outside its working
    // directory, so a session started in a subdirectory restored only that
    // subtree — and still reported "file snapshot restored".
    const cwd = await makeRepository("omp-undo-redo-subdir-");
    try {
      const nested = join(cwd, "sub");
      await mkdir(nested);
      await writeFile(join(nested, "inside.txt"), "base\n");
      await git(cwd, ["add", "."]);
      await git(cwd, ["commit", "-qm", "nested"]);

      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(nested, "subdir-session");
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      await writeFile(join(nested, "inside.txt"), "changed\n");
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      await pi.runCommand("undo", ctx);

      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
      expect(await readFile(join(nested, "inside.txt"), "utf8")).toBe("base\n");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
    } finally {
      await rmRetry(cwd);
    }
  });

  it("binds separate git runners to linked worktrees of the same repository", async () => {
    // Linked worktrees share `repository.commonDir`. `resolveBackend` must
    // cache them by `repository.worktree`, or the second linked worktree would
    // run its git operations inside the first worktree.
    const mainWs = await makeRepository("omp-undo-redo-main-wt-");
    const linkedWs = await mkdtemp(join(tmpdir(), "omp-undo-redo-linked-wt-"));
    try {
      await git(mainWs, ["worktree", "add", "-b", "linked", linkedWs]);
      await writeFile(join(linkedWs, "linked.txt"), "linked-base\n");
      await git(linkedWs, ["add", "."]);
      await git(linkedWs, ["commit", "-qm", "linked-base"]);

      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);

      const mainCtx = context(mainWs, "main-session");
      const linkedCtx = context(linkedWs, "linked-session");
      await pi.emit("session_start", mainCtx);
      await pi.emit("session_start", linkedCtx);

      // Modify only the linked worktree and undo
      await pi.emit("before_agent_start", linkedCtx);
      await writeFile(join(linkedWs, "linked.txt"), "linked-changed\n");
      linkedCtx.leaf = "linked-turn";
      await pi.emit("agent_end", linkedCtx);
      linkedCtx.navigateTree = async (targetId) => {
        linkedCtx.leaf = targetId;
        return { cancelled: false };
      };
      await pi.runCommand("undo", linkedCtx);

      expect(linkedCtx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
      expect(await readFile(join(linkedWs, "linked.txt"), "utf8")).toBe("linked-base\n");
      expect(await readFile(join(mainWs, "tracked.txt"), "utf8")).toBe("base\n");
    } finally {
      await rmRetry(linkedWs);
      await rmRetry(mainWs);
    }
  });

  it("switches to the real git runner when a workspace runs git init mid-session", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-init-mid-"));
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "init-mid-session");
      await pi.emit("session_start", ctx);

      // Turn 1: non-Git mode (uses private repo)
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "first.txt"), "first\n");
      ctx.leaf = "turn1";
      await pi.emit("agent_end", ctx);

      // User initializes Git in the workspace:
      await git(cwd, ["init", "-q"]);
      await git(cwd, ["config", "user.name", "test"]);
      await git(cwd, ["config", "user.email", "test@example.com"]);
      await git(cwd, ["config", "core.autocrlf", "false"]);

      // Turn 2: must resolve the real Git repo, not reuse the private repo runner
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "second.txt"), "second\n");
      ctx.leaf = "turn2";
      await pi.emit("agent_end", ctx);

      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };

      await pi.runCommand("undo", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
      await expect(readFile(join(cwd, "second.txt"))).rejects.toThrow();
    } finally {
      await rmRetry(cwd);
    }
  });
});

describe("runtime action-state lifecycle", () => {
  it("publishes non-Git turn availability and active leaf", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-runtime-lifecycle-"));
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const sessionId = "runtime-turn-session";
      const ctx = context(cwd, sessionId);
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);

      const published = await runtimeState(sessionId);
      expect(published.actions).toEqual([
        { id: "undo", enabled: true },
        { id: "redo", enabled: false },
      ]);
      expect(published.activeSessionLeaf).toBe("turn");
      expect(published.actionResult).toBeUndefined();
    } finally {
      await rmRetry(cwd);
    }
  });

  it("publishes Undo and Redo results with selected leaves", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-runtime-navigation-"));
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const sessionId = "runtime-navigation-session";
      const ctx = await prepareUndoneSession(pi, cwd, sessionId);

      const undone = await runtimeState(sessionId);
      expect(undone.actions).toEqual([
        { id: "undo", enabled: false },
        { id: "redo", enabled: true },
      ]);
      expect(undone.activeSessionLeaf).toBe("leaf");
      expect(undone.actionResult).toMatchObject({ id: "undo", applied: true });

      await pi.runCommand("redo", ctx);
      const redone = await runtimeState(sessionId);
      expect(redone.actions).toEqual([
        { id: "undo", enabled: true },
        { id: "redo", enabled: false },
      ]);
      expect(redone.activeSessionLeaf).toBe("turn");
      expect(redone.actionResult).toMatchObject({ id: "redo", applied: true });

      await pi.emit("session_start", ctx);
      expect((await runtimeState(sessionId)).actionResult).toBeUndefined();
    } finally {
      await rmRetry(cwd);
    }
  });

  it("publishes fresh failed results without changing navigation revision", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-runtime-results-"));
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const sessionId = "runtime-result-session";
      const ctx = await prepareUndoneSession(pi, cwd, sessionId);
      const first = await runtimeState(sessionId);
      const firstToken = (first.actionResult as { token: string }).token;

      await pi.runCommand("undo", ctx);
      const empty = await runtimeState(sessionId);
      expect(empty.actionResult).toMatchObject({ id: "undo", applied: false });
      expect((empty.actionResult as { token: string }).token).not.toBe(firstToken);
      expect(empty.sessionRevision).toBe(first.sessionRevision);

      const cancelledId = "runtime-cancelled-session";
      const cancelled = context(cwd, cancelledId);
      await pi.emit("session_start", cancelled);
      await pi.emit("before_agent_start", cancelled);
      cancelled.leaf = "cancelled-turn";
      await pi.emit("agent_end", cancelled);
      const beforeCancel = await runtimeState(cancelledId);
      await pi.runCommand("undo", cancelled);
      const afterCancel = await runtimeState(cancelledId);
      expect(afterCancel.actionResult).toMatchObject({ id: "undo", applied: false });
      expect(afterCancel.sessionRevision).toBe(beforeCancel.sessionRevision);

      const busyId = "runtime-busy-session";
      const busy = context(cwd, busyId);
      await pi.emit("session_start", busy);
      busy.isIdle = () => false;
      await pi.runCommand("undo", busy);
      const afterBusy = await runtimeState(busyId);
      expect(afterBusy.actionResult).toMatchObject({ id: "undo", applied: false });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("clears Redo and publishes new leaf after unrelated navigation", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const sessionId = "runtime-branch-session";
      const ctx = await prepareUndoneSession(pi, cwd, sessionId);
      const oldLeafId = ctx.leaf;
      ctx.leaf = "unrelated";
      await pi.emit("session_tree", ctx, {
        type: "session_tree",
        oldLeafId,
        newLeafId: ctx.leaf,
      });

      const published = await runtimeState(sessionId);
      expect(published.actions).toEqual([
        { id: "undo", enabled: false },
        { id: "redo", enabled: false },
      ]);
      expect(published.activeSessionLeaf).toBe("unrelated");
    } finally {
      await rmRetry(cwd);
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
      await rmRetry(cwd);
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
        await rmRetry(cwd);
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
        "Redid last turn: session moved forward and file snapshot restored.",
      );
    } finally {
      await rmRetry(cwd);
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
        "Redid last turn: session moved forward and file snapshot restored.",
      );
      await thirdApi.emit("session_shutdown", third);
    } finally {
      await rmRetry(cwd);
    }
  });

  it("restores multi-turn undo and redo checkpoints across runtime restarts when undone turns exist", async () => {
    const cwd = await makeRepository();
    const sessionId = "resumed-multi-turn-session";
    const p1: TestEntry = {
      id: "p1",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const r1: TestEntry = {
      id: "r1",
      parentId: p1.id,
      type: "message",
      message: { role: "assistant" },
    };
    const p2: TestEntry = {
      id: "p2",
      parentId: r1.id,
      type: "message",
      message: { role: "user" },
    };
    const r2: TestEntry = {
      id: "r2",
      parentId: p2.id,
      type: "message",
      message: { role: "assistant" },
    };
    try {
      const firstApi = new FakeExtensionApi();
      ompUndoRedo(firstApi as never);
      const first = context(cwd, sessionId);
      first.leaf = p1.id;
      first.branch = [p1];
      first.entries = [p1];
      await firstApi.emit("session_start", first);

      // Turn 1
      await firstApi.emit("before_agent_start", first);
      await writeFile(join(cwd, "tracked.txt"), "turn1\n");
      first.leaf = r1.id;
      first.branch = [p1, r1];
      first.entries = [p1, r1];
      await firstApi.emit("agent_end", first);

      // Turn 2
      first.leaf = p2.id;
      first.branch = [p1, r1, p2];
      first.entries = [p1, r1, p2];
      await firstApi.emit("before_agent_start", first);
      await writeFile(join(cwd, "tracked.txt"), "turn2\n");
      first.leaf = r2.id;
      first.branch = [p1, r1, p2, r2];
      first.entries = [p1, r1, p2, r2];
      await firstApi.emit("agent_end", first);

      // Undo turn 2 before shutdown
      first.navigateTree = async (targetId) => {
        first.leaf = targetId;
        first.branch = targetId === p2.id ? [p1, r1, p2] : [p1];
        return { cancelled: false };
      };
      await firstApi.runCommand("undo", first);
      expect(first.leaf).toBe(p2.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("turn1\n");
      await firstApi.emit("session_shutdown", first);

      // Resume in a fresh extension process at leaf p2
      const secondApi = new FakeExtensionApi();
      ompUndoRedo(secondApi as never);
      const second = context(cwd, sessionId);
      second.leaf = p2.id;
      second.branch = [p1, r1, p2];
      second.entries = [p1, r1, p2, r2];
      second.navigateTree = async (targetId) => {
        second.leaf = targetId;
        if (targetId === r2.id) second.branch = [p1, r1, p2, r2];
        else if (targetId === p2.id) second.branch = [p1, r1, p2];
        else if (targetId === p1.id) second.branch = [p1];
        return { cancelled: false };
      };
      await secondApi.emit("session_start", second);

      // Redo turn 2
      await secondApi.runCommand("redo", second);
      expect(second.leaf).toBe(r2.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("turn2\n");
      expect(second.ui.notifications.at(-1)?.message).toBe(
        "Redid last turn: session moved forward and file snapshot restored.",
      );

      // Undo turn 2 again
      await secondApi.runCommand("undo", second);
      expect(second.leaf).toBe(p2.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("turn1\n");
      expect(second.ui.notifications.at(-1)?.message).toBe(
        "Undid last turn: session moved back and file snapshot restored.",
      );

      // Undo turn 1
      await secondApi.runCommand("undo", second);
      expect(second.leaf).toBe(p1.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      expect(second.ui.notifications.at(-1)?.message).toBe(
        "Undid last turn: session moved back and file snapshot restored.",
      );

      await secondApi.emit("session_shutdown", second);
    } finally {
      await rmRetry(cwd);
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
      await rmRetry(cwd);
    }
  });

  it("notifies the user when durable history exists but cannot be loaded", async () => {
    const cwd = await makeRepository();
    const sessionId = "corrupt-history-session";
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

      // Corrupt the durable history file so the next resume hits the
      // unavailable path (distinct from the expired tombstone path).
      const { historyPath } = await import("../src/core/history-store.js");
      const repo = {
        worktree: cwd,
        gitDir: join(cwd, ".git"),
        commonDir: join(cwd, ".git"),
      };
      await writeFile(historyPath(repo, sessionId), "{corrupted history");

      const secondApi = new FakeExtensionApi();
      ompUndoRedo(secondApi as never);
      const second = context(cwd, sessionId);
      second.leaf = response.id;
      second.branch = [prompt, response];
      second.entries = [prompt, response];
      await secondApi.emit("session_start", second);

      expect(
        second.ui.notifications.some((n) =>
          n.message.includes("Undo/redo file history for this session could not be loaded."),
        ),
      ).toBe(true);

      // Undo still works in session-only mode after the warning.
      second.navigateTree = async (targetId) => {
        second.leaf = targetId;
        second.branch = [prompt];
        return { cancelled: false };
      };
      await secondApi.runCommand("undo", second);
      expect(second.leaf).toBe(prompt.id);
      expect(second.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the resumed turn has no usable file checkpoint.",
      );

      await secondApi.emit("session_shutdown", second);
    } finally {
      await rmRetry(cwd);
    }
  });

  it("handles session history expiration on session_start and notifies user", async () => {
    const cwd = await makeRepository();
    const sessionId1 = "expired-lifecycle-session-1";
    const sessionId2 = "active-lifecycle-session-2";
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
      const originalEnv = process.env.OMP_UNDO_REDO_RETENTION_DAYS;
      process.env.OMP_UNDO_REDO_RETENTION_DAYS = "30";

      // 1. Initial run for session 1: create a turn checkpoint
      const firstApi = new FakeExtensionApi();
      ompUndoRedo(firstApi as never);
      const firstCtx = context(cwd, sessionId1);
      firstCtx.leaf = prompt.id;
      firstCtx.branch = [prompt];
      firstCtx.entries = [prompt];

      await firstApi.emit("session_start", firstCtx);
      await firstApi.emit("before_agent_start", firstCtx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      firstCtx.leaf = response.id;
      firstCtx.branch = [prompt, response];
      firstCtx.entries = [prompt, response];
      await firstApi.emit("agent_end", firstCtx);
      await firstApi.emit("session_shutdown", firstCtx);

      // 2. Overwrite history file timestamp for session 1 to 40 days ago
      const { historyPath } = await import("../src/core/history-store.js");
      const repo = {
        worktree: cwd,
        gitDir: join(cwd, ".git"),
        commonDir: join(cwd, ".git"),
      };
      const hPath = historyPath(repo, sessionId1);
      const content = JSON.parse(await readFile(hPath, "utf8"));
      content.lastAccessedAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      await writeFile(hPath, JSON.stringify(content));
      // The turn saves left a fresh cross-process heartbeat marker; drop it
      // so no live owner is implied and the dormant session is sweepable.
      const { activeHeartbeatPath } = await import("../src/core/history-liveness.js");
      await rm(
        activeHeartbeatPath(
          join(repo.commonDir, "omp-undo-redo", "history"),
          checkpointNamespace(sessionId1),
        ),
        { force: true },
      );

      // 3. Start session 2 to trigger background expiration of dormant session 1
      const secondApi = new FakeExtensionApi();
      ompUndoRedo(secondApi as never);
      const secondCtx = context(cwd, sessionId2);
      await secondApi.emit("session_start", secondCtx);

      // The expiration sweep runs in the background; wait until it has
      // written the tombstone for session 1 before resuming it.
      const { tombstonePath } = await import("../src/core/history-store.js");
      const expirationDeadline = Date.now() + 10_000;
      for (;;) {
        try {
          await access(tombstonePath(repo, sessionId1));
          break;
        } catch {
          if (Date.now() > expirationDeadline) {
            throw new Error("session 1 history was not expired within the deadline");
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }

      // 4. Resume session 1 (now expired)
      const resumeCtx = context(cwd, sessionId1);
      resumeCtx.leaf = response.id;
      resumeCtx.branch = [prompt, response];
      resumeCtx.entries = [prompt, response];
      resumeCtx.navigateTree = async (targetId) => {
        resumeCtx.leaf = targetId;
        resumeCtx.branch = [prompt];
        return { cancelled: false };
      };

      await secondApi.emit("session_start", resumeCtx);

      // Verify expiration notification was shown on resume
      expect(
        resumeCtx.ui.notifications.some((n) =>
          n.message.includes("Undo/redo file history for this session expired"),
        ),
      ).toBe(true);

      // Run undo on resumed session 1
      await secondApi.runCommand("undo", resumeCtx);
      expect(resumeCtx.leaf).toBe(prompt.id);
      expect(resumeCtx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because the resumed turn has no usable file checkpoint.",
      );

      await secondApi.emit("session_shutdown", secondCtx);
      await secondApi.emit("session_shutdown", resumeCtx);

      if (originalEnv !== undefined) {
        process.env.OMP_UNDO_REDO_RETENTION_DAYS = originalEnv;
      } else {
        delete process.env.OMP_UNDO_REDO_RETENTION_DAYS;
      }
    } finally {
      await rmRetry(cwd);
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
      await rmRetry(cwd);
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
      await rmRetry(cwd);
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
      await Promise.all([rmRetry(first), rmRetry(second)]);
    }
  });

  it("degrades to session-only navigation when git is unavailable", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      const gitUnavailableRunner: GitRunner = Object.assign(
        async () => ({
          stdout: "",
          stderr: "git: command not found",
          code: 1,
          error: "unavailable" as const,
        }),
        { cwd },
      );
      ompUndoRedo(pi as never, {
        gitRunnerFactory: () => gitUnavailableRunner,
      });
      const ctx = context(cwd, "git-unavailable-session");
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };

      await pi.emit("session_start", ctx);
      expect(ctx.ui.notifications).toContainEqual({
        message:
          "Git is not available.\nSession navigation still works, but file changes cannot be restored.",
        level: "warning",
      });

      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed-without-git\n");
      ctx.leaf = "turn-1";
      await pi.emit("agent_end", ctx);

      const warnings = ctx.ui.notifications.filter((n) => n.level === "warning");
      expect(warnings).toHaveLength(1);

      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("leaf");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed-without-git\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid the session turn, but files were not restored because Git was unavailable when the checkpoint was created.",
      );

      await pi.runCommand("redo", ctx);
      expect(ctx.leaf).toBe("turn-1");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Redid the session turn, but files were not restored because Git was unavailable when the checkpoint was created.",
      );
    } finally {
      await rmRetry(cwd);
    }
  });
});
