import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as Services from "../../src/session/services.js";
import { createGitRunner } from "../../src/infra/git-runner.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../../src/index.js";
import type { GitRunner } from "../../src/types.js";
import {
  context,
  FakeExtensionApi,
  makeRepository,
  rmRetry,
  type TestContext,
  type TestEntry,
} from "../helpers/index.js";

const created = vi.hoisted(() => [] as Services.ExtensionServices[]);
vi.mock("../../src/session/services.js", async (importOriginal) => {
  const actual = await importOriginal<typeof Services>();
  return {
    ...actual,
    createServices: (deps: Parameters<typeof actual.createServices>[0]) => {
      const services = actual.createServices(deps);
      created.push(services);
      return services;
    },
  };
});

// OMP 18.20+ moves a session it cannot keep writing to a new id, with no
// event; the new header's `continuationOf` names the old id.

const entry = (id: string, parentId: string | null, role: string): TestEntry => ({
  id,
  parentId,
  type: "message",
  message: { role },
});

type Movable = {
  /** The host moves the live session to `id`, with no event. */
  moveTo(id: string): void;
  /** The manager now holds `id`, a copy of `continues` if given (a switch). */
  open(id: string, continues?: string): void;
};

function movable(ctx: TestContext, sessionId: string): Movable {
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
    open(id, continues) {
      header = continues === undefined ? {} : { continuationOf: continues };
      current = id;
    },
  };
}

/** Session "original": turn 1 recorded, turn 2's finalize parked on `gate`. */
async function parkedSecondTurn(cwd: string) {
  const turns = [
    entry("p1", null, "user"),
    entry("r1", "p1", "assistant"),
    entry("p2", "r1", "user"),
    entry("r2", "p2", "assistant"),
  ] as const;
  const [p1, r1, p2, r2] = turns;
  const gate = Promise.withResolvers<void>();
  const parked = Promise.withResolvers<void>();
  let parkNextAdd = false;
  const runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]> = (workCwd, env) => {
    const inner = env ? createGitRunner(workCwd, { env }) : createGitRunner(workCwd);
    const gated: GitRunner = async (args, options) => {
      if (parkNextAdd && args.includes("add")) {
        parkNextAdd = false;
        parked.resolve();
        await gate.promise;
      }
      return inner(args, options);
    };
    gated.cwd = workCwd;
    return gated;
  };
  const pi = new FakeExtensionApi();
  // Long enough for turn 1's finalize; turn 2's, parked, outlives it.
  ompUndoRedo(pi as never, { gitRunnerFactory: runner, finalizeDeadlineMs: 2_000 });
  const ctx = context(cwd, "original");
  const session = movable(ctx, "original");
  navigable(ctx, [...turns]);
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
  await writeFile(join(cwd, "other.txt"), "original only\n");
  ctx.leaf = r2.id;
  ctx.branch = ctx.entries = [p1, r1, p2, r2];
  parkNextAdd = true;
  const agentEnd = pi.emit("agent_end", ctx);
  await parked.promise;
  await agentEnd;
  return { pi, ctx, session, gate, turns };
}

/** `/undo`, retried while the finalizes it waits on are still running. */
async function undoSettled(pi: FakeExtensionApi, ctx: TestContext): Promise<string> {
  let message = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await pi.runCommand("undo", ctx);
    message = ctx.ui.notifications.at(-1)?.message ?? "";
    if (!message.includes("still being")) break;
  }
  return message;
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

  // `/resume` of a copy from (or after) the session it continues is a switch,
  // not a move: the old session's record (held by its deferred finalize) must
  // not be refiled under the copy, or its release would clear the copy's.
  it.each([
    ["directly", false],
    ["after switching to another session", true],
  ])("keeps the copy's own history when resumed %s mid-finalize", async (_, viaOther) => {
    const cwd = await makeRepository();
    let release = () => {};
    try {
      const { pi, ctx, session, gate, turns } = await parkedSecondTurn(cwd);
      release = gate.resolve;
      const [p1, r1] = turns;
      if (viaOther) {
        await pi.emit("session_before_switch", ctx);
        session.open("elsewhere");
        ctx.leaf = "e1";
        ctx.branch = ctx.entries = [entry("e1", null, "user")];
        await pi.emit("session_switch", ctx);
      }
      // `/resume` of the copy another process made of "original".
      await pi.emit("session_before_switch", ctx);
      session.open("copy", "original");
      ctx.leaf = r1.id;
      ctx.branch = ctx.entries = [p1, r1];
      await pi.emit("session_switch", ctx);
      gate.resolve();

      expect(await undoSettled(pi, ctx)).toMatch(/^Undid last turn/);
      expect([ctx.leaf, await tracked(cwd)]).toEqual([p1.id, "base\n"]);
      expect(await readFile(join(cwd, "other.txt"), "utf8")).toBe("original only\n");
      await pi.emit("session_shutdown", ctx);
    } finally {
      release();
      await rmRetry(cwd);
    }
  });

  it("follows a move of a session resumed while its release is still running", async () => {
    const cwd = await makeRepository();
    let release = () => {};
    try {
      const { pi, ctx, session, gate, turns } = await parkedSecondTurn(cwd);
      release = gate.resolve;
      const r2 = turns[3];
      await pi.emit("session_before_switch", ctx);
      session.open("elsewhere");
      ctx.leaf = "e1";
      ctx.branch = ctx.entries = [entry("e1", null, "user")];
      await pi.emit("session_switch", ctx);
      // Back to "original" itself; the host moves it while its turn runs.
      await pi.emit("session_before_switch", ctx);
      session.open("original");
      ctx.leaf = r2.id;
      ctx.branch = ctx.entries = [...turns];
      await pi.emit("session_switch", ctx);
      const p3 = entry("p3", r2.id, "user");
      const r3 = entry("r3", p3.id, "assistant");
      navigable(ctx, [...turns, p3, r3]);
      ctx.leaf = p3.id;
      ctx.branch = ctx.entries = [...turns, p3];
      await pi.emit("before_agent_start", ctx);
      session.moveTo("original-continuation");
      // The parked release wakes before any handler noticed the move.
      gate.resolve();
      await Promise.allSettled([...created.at(-1)!.activeOperations]);
      await writeFile(join(cwd, "tracked.txt"), "t3\n");
      ctx.leaf = r3.id;
      ctx.branch = ctx.entries = [...turns, p3, r3];
      await pi.emit("agent_end", ctx);

      expect(await undoSettled(pi, ctx)).toMatch(/^Undid last turn/);
      expect([ctx.leaf, await tracked(cwd)]).toEqual([p3.id, "t1\n"]);
      await pi.emit("session_shutdown", ctx);
    } finally {
      release();
      await rmRetry(cwd);
    }
  });

  it("still follows a move after a cancelled switch", async () => {
    const cwd = await makeRepository();
    const [p1, r1] = [entry("p1", null, "user"), entry("r1", "p1", "assistant")];
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "stays");
      const session = movable(ctx, "stays");
      navigable(ctx, [p1, r1]);
      ctx.leaf = p1.id;
      ctx.branch = ctx.entries = [p1];
      await pi.emit("session_start", ctx);
      // Another extension cancels it: no `session_switch` follows.
      await pi.emit("session_before_switch", ctx);
      await pi.emit("before_agent_start", ctx);
      session.moveTo("stays-continuation");
      await writeFile(join(cwd, "tracked.txt"), "t1\n");
      ctx.leaf = r1.id;
      ctx.branch = ctx.entries = [p1, r1];
      await pi.emit("agent_end", ctx);

      await pi.runCommand("undo", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toMatch(/^Undid last turn/);
      expect([ctx.leaf, await tracked(cwd)]).toEqual([p1.id, "base\n"]);
      await pi.emit("session_shutdown", ctx);
    } finally {
      await rmRetry(cwd);
    }
  });
});
