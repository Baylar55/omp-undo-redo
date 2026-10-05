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
