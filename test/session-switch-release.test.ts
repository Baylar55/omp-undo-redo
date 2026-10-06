import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointNamespace } from "../src/core/checkpoints.js";
import type * as HistoryLiveness from "../src/core/history-liveness.js";
import ompUndoRedo from "../src/index.js";
import { context, FakeExtensionApi, makeRepository, rmRetry, type TestEntry } from "./helpers.js";

const beats = vi.hoisted(() => [] as string[]);
vi.mock("../src/core/history-liveness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof HistoryLiveness>();
  return {
    ...actual,
    touchSessionHeartbeat: (dir: string, hash: string) => {
      beats.push(hash);
      return actual.touchSessionHeartbeat(dir, hash);
    },
  };
});

const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;

function heartbeatTick(): string[] {
  beats.length = 0;
  vi.advanceTimersByTime(HEARTBEAT_INTERVAL_MS);
  return [...beats];
}

afterEach(() => {
  vi.useRealTimers();
});

describe("leaving a session", () => {
  it("stops its heartbeat on switch and reloads its history on resume", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const cwd = await makeRepository();
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
    const pi = new FakeExtensionApi();
    ompUndoRedo(pi as never);
    // One live manager whose id changes in place, as on /new and /resume.
    const ctx = context(cwd, "left-a");
    let liveId = "left-a";
    ctx.sessionManager.getSessionId = () => liveId;
    ctx.leaf = prompt.id;
    ctx.branch = [prompt];
    ctx.entries = [prompt];
    ctx.navigateTree = async (targetId) => {
      ctx.leaf = targetId;
      ctx.branch = targetId === prompt.id ? [prompt] : [prompt, response];
      return { cancelled: false };
    };
    const hashA = checkpointNamespace("left-a");
    try {
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = response.id;
      ctx.branch = [prompt, response];
      ctx.entries = [prompt, response];
      await pi.emit("agent_end", ctx);
      expect(heartbeatTick()).toContain(hashA);

      // Same-id reload keeps the session live.
      await pi.emit("session_before_switch", ctx);
      await pi.emit("session_switch", ctx);
      expect(heartbeatTick()).toContain(hashA);

      await pi.emit("session_before_switch", ctx);
      liveId = "new-b";
      await pi.emit("session_switch", ctx);
      expect(heartbeatTick()).not.toContain(hashA);

      // Resume A: its turn survived the release and is undoable again.
      await pi.emit("session_before_switch", ctx);
      liveId = "left-a";
      await pi.emit("session_switch", ctx);
      await pi.runCommand("undo", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toMatch(/^Undid/);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      expect(heartbeatTick()).toContain(hashA);
      await pi.emit("session_shutdown", ctx);
    } finally {
      await rmRetry(cwd, 10);
    }
  });
});

describe("entering a session", () => {
  // A resumed session without file history whose first turn here is recorded
  // once: either the switch built its navigation before the turn, or the
  // finalize builds it from the branch as it stood when the turn started.
  it.each(["session_switch", "first finalize"] as const)(
    "records the first turn once when the navigation is built on %s",
    async (entry) => {
      const cwd = await makeRepository();
      const message = (id: string, parentId: string | null, role: string): TestEntry => ({
        id,
        parentId,
        type: "message",
        message: { role },
      });
      const entries = [
        message("p0", null, "user"),
        message("r0", "p0", "assistant"),
        message("p1", "r0", "user"),
        message("r1", "p1", "assistant"),
      ];
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "enter-a");
      let liveId = "enter-a";
      ctx.sessionManager.getSessionId = () => liveId;
      // Follows parent links like the host, so the bound matters.
      ctx.sessionManager.getBranch = ((fromId?: string) => {
        const path: TestEntry[] = [];
        let current = ctx.entries.find((item) => item.id === (fromId ?? ctx.leaf));
        while (current) {
          path.unshift(current);
          current = ctx.entries.find((item) => item.id === current?.parentId);
        }
        return path;
      }) as () => TestEntry[];
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      try {
        if (entry === "session_switch") {
          await pi.emit("session_start", ctx);
          await pi.emit("session_before_switch", ctx);
        }
        liveId = "enter-b";
        ctx.entries = entries.slice(0, 2);
        ctx.leaf = "r0";
        if (entry === "session_switch") await pi.emit("session_switch", ctx);

        await pi.emit("before_agent_start", ctx);
        await writeFile(join(cwd, "tracked.txt"), "changed\n");
        ctx.entries = entries;
        ctx.leaf = "r1";
        await pi.emit("agent_end", ctx);

        await pi.runCommand("undo", ctx);
        expect(ctx.leaf).toBe("r0");
        expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
        // The earlier, conversation-only turn — not a second copy of this one.
        await pi.runCommand("undo", ctx);
        expect(ctx.leaf).toBe("p0");
        await pi.emit("session_shutdown", ctx);
      } finally {
        await rmRetry(cwd, 10);
      }
    },
  );

  it("drops a resumed session's stored redo when /tree moves before any turn", async () => {
    const cwd = await makeRepository();
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
    const other: TestEntry = {
      id: "other",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const live = { id: "tree-a" };
    const start = () => {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "");
      ctx.sessionManager.getSessionId = () => live.id;
      ctx.entries = [prompt, response, other];
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      return { pi, ctx };
    };
    try {
      // First process: a turn, undone. Shutdown keeps its redo in the stored history.
      const first = start();
      first.ctx.leaf = prompt.id;
      await first.pi.emit("session_start", first.ctx);
      await first.pi.emit("before_agent_start", first.ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      first.ctx.leaf = response.id;
      await first.pi.emit("agent_end", first.ctx);
      await first.pi.runCommand("undo", first.ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      await first.pi.emit("session_shutdown", first.ctx);

      // Second process starts elsewhere, then resumes A and moves with /tree.
      const { pi, ctx } = start();
      live.id = "tree-b";
      ctx.leaf = other.id;
      await pi.emit("session_start", ctx);
      await pi.emit("session_before_switch", ctx);
      live.id = "tree-a";
      ctx.leaf = prompt.id;
      await pi.emit("session_switch", ctx);
      ctx.leaf = other.id;
      await pi.emit("session_tree", ctx, { oldLeafId: prompt.id, newLeafId: other.id });

      await pi.runCommand("redo", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toBe("Nothing to redo in this session.");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      await pi.emit("session_shutdown", ctx);
    } finally {
      await rmRetry(cwd, 10);
    }
  });
});
