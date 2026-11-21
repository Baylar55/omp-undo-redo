import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ompUndoRedo from "../../src/index.js";
import {
  context,
  FakeExtensionApi,
  makeRepository,
  rmRetry,
  type TestContext,
  type TestEntry,
} from "../helpers/index.js";

// Pi's order (1.5.2, `AgentSession._startRun` / `AgentSessionRuntime`): every
// copy of the extension gets `session_start` with a `reason` before any run. A
// prompt emits before_agent_start, then agent_start/agent_end once per loop
// (retries and compaction resumes are more loops), then, from 0.80.4, one
// agent_settled. `agent_end` carries no `willContinue`. `/new`, `/resume` and
// fork emit only a pre-event, then shut this copy down and start a new one.

const prompt: TestEntry = { id: "p", parentId: null, type: "message", message: { role: "user" } };
const response: TestEntry = {
  id: "r",
  parentId: "p",
  type: "message",
  message: { role: "assistant" },
};

function piContext(cwd: string, sessionId: string): TestContext {
  const ctx = context(cwd, sessionId);
  ctx.navigateTree = async (targetId) => {
    ctx.leaf = targetId;
    ctx.branch = targetId === prompt.id ? [prompt] : ctx.branch;
    return { cancelled: false };
  };
  return ctx;
}

async function start(
  ctx: TestContext,
  reason: "startup" | "new" | "resume" | "fork" = "startup",
): Promise<FakeExtensionApi> {
  const pi = new FakeExtensionApi();
  ompUndoRedo(pi as never);
  await pi.emit("session_start", ctx, { type: "session_start", reason });
  return pi;
}

/** One prompt; each loop writes a file and ends with agent_end. */
async function run(
  pi: FakeExtensionApi,
  ctx: TestContext,
  promptLeaf: string,
  loops: Array<{ file: string; text: string; leaf: string }>,
  settled = true,
): Promise<void> {
  ctx.leaf = promptLeaf;
  await pi.emit("before_agent_start", ctx);
  for (const loop of loops) {
    await pi.emit("agent_start", ctx);
    await writeFile(join(ctx.cwd, loop.file), loop.text);
    ctx.leaf = loop.leaf;
    await pi.emit("agent_end", ctx, { type: "agent_end", messages: [] });
  }
  if (settled) await pi.emit("agent_settled", ctx, { type: "agent_settled", aborted: false });
}

const read = (cwd: string, file: string) => readFile(join(cwd, file), "utf8");

describe("Pi event order", () => {
  it("keeps the first run's retry in that run's checkpoint", async () => {
    const cwd = await makeRepository();
    try {
      const ctx = piContext(cwd, "pi-first-run");
      const pi = await start(ctx);
      await run(pi, ctx, "p1", [
        { file: "tracked.txt", text: "one\n", leaf: "e1" },
        { file: "other.txt", text: "retried\n", leaf: "r1" },
      ]);
      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("p1");
      await expect(read(cwd, "tracked.txt")).resolves.toBe("base\n");
      await expect(read(cwd, "other.txt")).rejects.toThrow();
      await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("records the turn at agent_settled, so quitting right after keeps it", async () => {
    const cwd = await makeRepository();
    try {
      const ctx = piContext(cwd, "pi-quit");
      ctx.leaf = prompt.id;
      ctx.branch = [prompt];
      ctx.entries = [prompt];
      const pi = await start(ctx);
      await run(pi, ctx, prompt.id, [{ file: "tracked.txt", text: "one\n", leaf: "r" }]);
      await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });

      const resumed = piContext(cwd, "pi-quit");
      resumed.leaf = response.id;
      resumed.branch = [prompt, response];
      resumed.entries = [prompt, response];
      const again = await start(resumed, "resume");
      await again.runCommand("undo", resumed);
      expect(resumed.leaf).toBe(prompt.id);
      await expect(read(cwd, "tracked.txt")).resolves.toBe("base\n");
      await again.emit("session_shutdown", resumed, { type: "session_shutdown", reason: "quit" });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("without agent_settled (Pi < 0.80.4), ends a turn at the next prompt or command", async () => {
    const cwd = await makeRepository();
    try {
      const ctx = piContext(cwd, "pi-no-settle");
      const pi = await start(ctx);
      await run(pi, ctx, "p1", [{ file: "tracked.txt", text: "one\n", leaf: "r1" }], false);
      await run(pi, ctx, "p2", [{ file: "other.txt", text: "two\n", leaf: "r2" }], false);
      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("p2");
      await expect(read(cwd, "other.txt")).rejects.toThrow();
      await expect(read(cwd, "tracked.txt")).resolves.toBe("one\n");
      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe("p1");
      await expect(read(cwd, "tracked.txt")).resolves.toBe("base\n");
      await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("records a turn still held open when a fork leaves the session", async () => {
    const cwd = await makeRepository();
    try {
      const ctx = piContext(cwd, "pi-forked");
      ctx.leaf = prompt.id;
      ctx.branch = [prompt];
      ctx.entries = [prompt];
      const pi = await start(ctx);
      await run(pi, ctx, prompt.id, [{ file: "tracked.txt", text: "one\n", leaf: "r" }], false);
      ctx.branch = [prompt, response];
      ctx.entries = [prompt, response];
      await pi.emit("session_before_fork", ctx, {
        type: "session_before_fork",
        entryId: prompt.id,
        position: "before",
      });
      await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "fork" });

      // Resumed later in a new copy: the turn is in its history.
      const resumed = piContext(cwd, "pi-forked");
      resumed.leaf = response.id;
      resumed.branch = [prompt, response];
      resumed.entries = [prompt, response];
      const again = await start(resumed, "resume");
      await again.runCommand("undo", resumed);
      expect(resumed.leaf).toBe(prompt.id);
      await expect(read(cwd, "tracked.txt")).resolves.toBe("base\n");
      await again.emit("session_shutdown", resumed, { type: "session_shutdown", reason: "quit" });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("serves the session /new opens in a new copy and clears the left session's redo", async () => {
    const cwd = await makeRepository();
    try {
      const first = piContext(cwd, "pi-left");
      first.leaf = prompt.id;
      first.branch = [prompt];
      first.entries = [prompt];
      const firstPi = await start(first);
      await run(firstPi, first, prompt.id, [{ file: "tracked.txt", text: "first\n", leaf: "r" }]);
      first.branch = [prompt, response];
      first.entries = [prompt, response];
      await firstPi.runCommand("undo", first);
      expect(first.leaf).toBe(prompt.id);
      await firstPi.emit("session_before_switch", first, {
        type: "session_before_switch",
        reason: "new",
      });
      await firstPi.emit("session_shutdown", first, { type: "session_shutdown", reason: "new" });

      const second = piContext(cwd, "pi-new");
      const secondPi = await start(second, "new");
      await run(secondPi, second, "b1", [
        { file: "other.txt", text: "second\n", leaf: "be1" },
        { file: "third.txt", text: "retried\n", leaf: "br1" },
      ]);
      await secondPi.runCommand("undo", second);
      expect(second.leaf).toBe("b1");
      await expect(read(cwd, "other.txt")).rejects.toThrow();
      await expect(read(cwd, "third.txt")).rejects.toThrow();
      await secondPi.emit("session_before_switch", second, {
        type: "session_before_switch",
        reason: "resume",
      });
      await secondPi.emit("session_shutdown", second, {
        type: "session_shutdown",
        reason: "resume",
      });

      // A committed `/new` is a session navigation: it clears the left
      // session's redo (README), as OMP's `session_switch` does.
      const back = piContext(cwd, "pi-left");
      back.leaf = prompt.id;
      back.branch = [prompt];
      back.entries = [prompt, response];
      back.navigateTree = async (targetId) => {
        back.leaf = targetId;
        back.branch = targetId === prompt.id ? [prompt] : [prompt, response];
        return { cancelled: false };
      };
      const backPi = await start(back, "resume");
      await backPi.runCommand("redo", back);
      expect(back.ui.notifications.at(-1)?.message).toBe("Nothing to redo in this session.");
      expect(back.leaf).toBe(prompt.id);
      await expect(read(cwd, "tracked.txt")).resolves.toBe("base\n");
      await backPi.emit("session_shutdown", back, { type: "session_shutdown", reason: "quit" });
    } finally {
      await rmRetry(cwd);
    }
  });

  it("keeps redo across a quit, like a restart", async () => {
    const cwd = await makeRepository();
    try {
      const ctx = piContext(cwd, "pi-quit-redo");
      ctx.leaf = prompt.id;
      ctx.branch = [prompt];
      ctx.entries = [prompt];
      const pi = await start(ctx);
      await run(pi, ctx, prompt.id, [{ file: "tracked.txt", text: "one\n", leaf: "r" }]);
      ctx.branch = [prompt, response];
      ctx.entries = [prompt, response];
      await pi.runCommand("undo", ctx);
      await pi.emit("session_shutdown", ctx, { type: "session_shutdown", reason: "quit" });

      const resumed = piContext(cwd, "pi-quit-redo");
      resumed.leaf = prompt.id;
      resumed.branch = [prompt];
      resumed.entries = [prompt, response];
      resumed.navigateTree = async (targetId) => {
        resumed.leaf = targetId;
        resumed.branch = targetId === prompt.id ? [prompt] : [prompt, response];
        return { cancelled: false };
      };
      const again = await start(resumed, "resume");
      await again.runCommand("redo", resumed);
      expect(resumed.leaf).toBe(response.id);
      await expect(read(cwd, "tracked.txt")).resolves.toBe("one\n");
      await again.emit("session_shutdown", resumed, { type: "session_shutdown", reason: "quit" });
    } finally {
      await rmRetry(cwd);
    }
  });
});
