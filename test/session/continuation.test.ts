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

// OMP 18.20+ moves a session it cannot keep writing to a new id, with no
// event; the new header's `continuationOf` names the old id.

const entry = (id: string, parentId: string | null, role: string): TestEntry => ({
  id,
  parentId,
  type: "message",
  message: { role },
});

function movable(ctx: TestContext, sessionId: string): { moveTo(id: string): void } {
  let current = sessionId;
  let header: { continuationOf?: string } = {};
  Object.assign(ctx.sessionManager, {
    getSessionId: () => current,
    getHeader: () => header,
  });
  return {
    moveTo(id) {
      header = { continuationOf: current };
      current = id;
    },
  };
}

function navigable(ctx: TestContext, all: TestEntry[]): void {
  ctx.navigateTree = async (target) => {
    ctx.leaf = target;
    ctx.branch = all.slice(0, all.findIndex((e) => e.id === target) + 1);
    return { cancelled: false };
  };
}

const tracked = (cwd: string) => readFile(join(cwd, "tracked.txt"), "utf8");

describe("a session the host moved to a new id", () => {
  it("keeps file undo and redo for the turns before the move and the turn it interrupted", async () => {
    const cwd = await makeRepository();
    const [p1, r1] = [entry("p1", null, "user"), entry("r1", "p1", "assistant")];
    const [p2, r2] = [entry("p2", "r1", "user"), entry("r2", "p2", "assistant")];
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "moved");
      const session = movable(ctx, "moved");
      navigable(ctx, [p1, r1, p2, r2]);
      ctx.leaf = p1.id;
      ctx.branch = ctx.entries = [p1];
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "t1\n");
      ctx.leaf = r1.id;
      ctx.branch = ctx.entries = [p1, r1];
      await pi.emit("agent_end", ctx);

      ctx.leaf = p2.id;
      ctx.branch = ctx.entries = [p1, r1, p2];
      await pi.emit("before_agent_start", ctx);
      // Writing the prompt finds the file held elsewhere: the host moves on.
      session.moveTo("moved-continuation");
      await writeFile(join(cwd, "tracked.txt"), "t2\n");
      ctx.leaf = r2.id;
      ctx.branch = ctx.entries = [p1, r1, p2, r2];
      await pi.emit("agent_end", ctx);

      await pi.runCommand("undo", ctx);
      expect([ctx.leaf, await tracked(cwd)]).toEqual([p2.id, "t1\n"]);
      await pi.runCommand("undo", ctx);
      expect([ctx.leaf, await tracked(cwd)]).toEqual([p1.id, "base\n"]);
      await pi.runCommand("redo", ctx);
      await pi.runCommand("redo", ctx);
      expect([ctx.leaf, await tracked(cwd)]).toEqual([r2.id, "t2\n"]);
      await pi.emit("session_shutdown", ctx);

      // The next process resumes the new id with its own history.
      const next = new FakeExtensionApi();
      ompUndoRedo(next as never);
      const resumed = context(cwd, "moved-continuation");
      navigable(resumed, [p1, r1, p2, r2]);
      resumed.leaf = r2.id;
      resumed.branch = resumed.entries = [p1, r1, p2, r2];
      await next.emit("session_start", resumed);
      await next.runCommand("undo", resumed);
      expect([resumed.leaf, await tracked(cwd)]).toEqual([p2.id, "t1\n"]);
      await next.emit("session_shutdown", resumed);
    } finally {
      await rmRetry(cwd);
    }
  });

  it("adopts the old id's history on resume, up to the turns its copy holds", async () => {
    const cwd = await makeRepository();
    const [p1, r1] = [entry("p1", null, "user"), entry("r1", "p1", "assistant")];
    const [p2, r2] = [entry("p2", "r1", "user"), entry("r2", "p2", "assistant")];
    try {
      // The old session's process records a turn after the copy was made.
      const first = new FakeExtensionApi();
      ompUndoRedo(first as never);
      const old = context(cwd, "original");
      old.leaf = p1.id;
      old.branch = old.entries = [p1];
      await first.emit("session_start", old);
      await first.emit("before_agent_start", old);
      await writeFile(join(cwd, "tracked.txt"), "t1\n");
      old.leaf = r1.id;
      old.branch = old.entries = [p1, r1];
      await first.emit("agent_end", old);
      old.leaf = p2.id;
      old.branch = old.entries = [p1, r1, p2];
      await first.emit("before_agent_start", old);
      await writeFile(join(cwd, "other.txt"), "original only\n");
      old.leaf = r2.id;
      old.branch = old.entries = [p1, r1, p2, r2];
      await first.emit("agent_end", old);
      await first.emit("session_shutdown", old);

      const second = new FakeExtensionApi();
      ompUndoRedo(second as never);
      const copy = context(cwd, "copy");
      movable(copy, "original").moveTo("copy");
      navigable(copy, [p1, r1]);
      copy.leaf = r1.id;
      copy.branch = copy.entries = [p1, r1];
      await second.emit("session_switch", copy);
      await second.runCommand("undo", copy);
      expect([copy.leaf, await tracked(cwd)]).toEqual([p1.id, "base\n"]);
      expect(await readFile(join(cwd, "other.txt"), "utf8")).toBe("original only\n");
      expect(copy.ui.notifications.at(-1)?.message).toMatch(/^Undid last turn/);
      await second.emit("session_shutdown", copy);
    } finally {
      await rmRetry(cwd);
    }
  });
});
