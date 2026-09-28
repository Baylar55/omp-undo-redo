import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, describe, expect, it } from "vitest";
import { createGitRunner } from "../src/core/git-runner.js";
import type { GitRunner } from "../src/core/types.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../src/index.js";
import {
  context,
  FakeExtensionApi,
  makeRepository,
  privateRefs,
  rmRetry,
  type TestContext,
} from "./helpers.js";

const testStoreRoot = join(tmpdir(), `omp-undo-redo-test-store-${process.pid}`);
process.env.OMP_UNDO_REDO_STORE_DIR = testStoreRoot;

afterAll(async () => {
  await rm(testStoreRoot, { recursive: true, force: true });
});

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
    const inner = env ? createGitRunner(cwd, { env }) : createGitRunner(cwd);
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
    const inner = env ? createGitRunner(cwd, { env }) : createGitRunner(cwd);
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
        if (
          message.includes("Nothing to undo") ||
          message.includes("still being captured") ||
          message.includes("still being finalized")
        ) {
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

  it("records a session-only boundary for a turn the in-flight-capture guard skipped", async () => {
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
      // Both turns must be navigable. N+1's boundary is session-only (its
      // capture was skipped), and recording it marks the file history as
      // gapped, so neither undo restores files: N's after-snapshot was taken
      // after N+1's edits, so restoring from it would revert two turns of file
      // changes while moving one session boundary.
      // Real-time polling is deliberate: finalizes settle on their own
      // schedule behind the handler deadline, with no observable signal.
      const messages: string[] = [];
      for (let undos = 0; undos < 2; undos += 1) {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await pi.runCommand("undo", ctx);
          const message = ctx.ui.notifications.at(-1)?.message ?? "";
          if (
            message.includes("Nothing to undo") ||
            message.includes("still being captured") ||
            message.includes("still being finalized")
          ) {
            await new Promise((resolve) => setTimeout(resolve, 100));
            continue;
          }
          messages.push(message);
          break;
        }
      }
      expect(messages).toHaveLength(2);
      for (const message of messages) expect(message).toContain("files were not restored");
      // Two boundaries, no more: the third undo finds an empty history.
      await pi.runCommand("undo", ctx);
      expect(ctx.ui.notifications.at(-1)?.message).toContain("Nothing to undo");
      expect(ctx.leaf).toBe("leafN");
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("changed-again\n");
    } finally {
      await waitForAdds(3).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      await rmRetry(cwd);
    }
  });

  /** git-add waits `delayMs` BEFORE reading the worktree, so a write landing
   *  in that window leaks into the snapshot (the slow-cold-capture case).
   *  Real delays: the race is between real git children and the handlers'
   *  wall-clock deadlines, which fake timers cannot drive. */
  function lateReadRunnerFactory(delayMs: number): {
    runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]>;
    adds: () => number;
  } {
    let count = 0;
    const runner = (cwd: string, env?: Record<string, string>): GitRunner => {
      const inner = env ? createGitRunner(cwd, { env }) : createGitRunner(cwd);
      const slow: GitRunner = async (args, options) => {
        if (!args.includes("add")) return inner(args, options);
        await sleep(delayMs);
        const result = await inner(args, options);
        count += 1;
        return result;
      };
      slow.cwd = cwd;
      return slow;
    };
    return { runner, adds: () => count };
  }

  async function undoWhenSettled(pi: FakeExtensionApi, ctx: TestContext) {
    ctx.navigateTree = async (targetId) => {
      ctx.leaf = targetId;
      return { cancelled: false };
    };
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await pi.runCommand("undo", ctx);
      const message = ctx.ui.notifications.at(-1)?.message ?? "";
      if (!/Nothing to undo|still being captured|still being finalized/.test(message))
        return message;
      await sleep(100);
    }
    throw new Error("undo never settled");
  }

  it("holds the first tool call until an overrunning before-snapshot finishes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-late-"));
    const { runner, adds } = lateReadRunnerFactory(800);
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, {
        gitRunnerFactory: runner,
        captureDeadlineMs: 200,
        toolCallDeadlineMs: 10_000,
      });
      const ctx = context(cwd, "late-session");
      await pi.emit("session_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await pi.emit("before_agent_start", ctx);
      expect(adds()).toBe(0);
      await pi.emit("tool_call", ctx);
      expect(adds()).toBe(1);
      await writeFile(join(cwd, "tracked.txt"), "agent-edit\n");
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);
      expect(await undoWhenSettled(pi, ctx)).toContain("file snapshot restored");
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("base\n");
    } finally {
      await rmRetry(cwd);
    }
  });

  it("records a session-only turn when a tool call outwaits the before-snapshot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-late-"));
    const { runner } = lateReadRunnerFactory(1_000);
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, {
        gitRunnerFactory: runner,
        captureDeadlineMs: 200,
        toolCallDeadlineMs: 200,
      });
      const ctx = context(cwd, "late-session");
      await pi.emit("session_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await pi.emit("before_agent_start", ctx);
      await pi.emit("tool_call", ctx);
      // The tool runs while git has not read the worktree yet.
      await writeFile(join(cwd, "tracked.txt"), "agent-edit\n");
      ctx.leaf = "turn";
      await pi.emit("agent_end", ctx);
      expect(await undoWhenSettled(pi, ctx)).toContain("files were not restored");
      expect(ctx.leaf).toBe("leaf");
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("agent-edit\n");
    } finally {
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
      // The add count gates only the git-add phase; the subsequent
      // write-tree/commit-tree/update-ref chain is still async. Give it a
      // brief window to settle so the navigation has a checkpoint before undo.
      // On Windows the full commit chain can be >200ms under load, so wait
      // longer than the capture deadline to ensure the turn is recorded.
      await new Promise((resolve) => setTimeout(resolve, 800));
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      // Retry once if the finalize is still in flight (Windows Git can be
      // slower under parallel load); the synchronous path should succeed on
      // the second attempt without the "still being captured" warning.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await pi.runCommand("undo", ctx);
        const message = ctx.ui.notifications.at(-1)?.message ?? "";
        if (message.includes("still being captured")) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          continue;
        }
        if (message.includes("file snapshot restored")) break;
        // Empty or other: wait a bit and retry, finalize may still be in flight
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await expect(readFile(join(cwd, "tracked.txt"))).rejects.toThrow();
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
      await pi.runCommand("redo", ctx);
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("changed\n");
    } finally {
      await rmRetry(cwd);
    }
  });

  it("waits for an in-flight finalize instead of undoing an empty history", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-finalize-"));
    let releaseUpdateRef: (() => void) | undefined;
    const updateRefGate = new Promise<void>((resolve) => {
      releaseUpdateRef = resolve;
    });
    let updateRefCount = 0;
    let finalizeAtGate = false;
    const runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]> = (workCwd, env) => {
      const inner = env ? createGitRunner(workCwd, { env }) : createGitRunner(workCwd);
      const gated: GitRunner = async (args, options) => {
        if (args[0] === "update-ref") {
          updateRefCount += 1;
          // The second update-ref belongs to the turn's after-snapshot: park
          // finalizeTurn there so recordTurnEnd has not run yet.
          if (updateRefCount >= 2) {
            finalizeAtGate = true;
            await updateRefGate;
          }
        }
        return inner(args, options);
      };
      gated.cwd = workCwd;
      return gated;
    };
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 5_000 });
      const ctx = context(cwd, "finalize-window-session");
      await pi.emit("session_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await pi.emit("before_agent_start", ctx);
      for (let attempt = 0; attempt < 200 && updateRefCount < 1; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(updateRefCount).toBeGreaterThanOrEqual(1);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn";
      const agentEndSettled = pi.emit("agent_end", ctx);
      for (let attempt = 0; attempt < 200 && !finalizeAtGate; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(finalizeAtGate).toBe(true);

      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      let undoSettled = false;
      const undoRun = pi.runCommand("undo", ctx).then(() => {
        undoSettled = true;
      });
      // The undo must be blocked by the in-flight finalize, not run early.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(undoSettled).toBe(false);

      releaseUpdateRef!();
      await undoRun;
      await agentEndSettled;
      await expect(readFile(join(cwd, "tracked.txt"), "utf8")).resolves.toBe("base\n");
      expect(ctx.ui.notifications.at(-1)?.message).toContain("file snapshot restored");
    } finally {
      releaseUpdateRef?.();
      await rmRetry(cwd);
    }
  });

  it("reads the finalize guard after the idle wait when undo is issued mid-stream", async () => {
    // The host runs commands during streaming and stops waiting on an
    // agent_end handler after its cap, while the finalize keeps running.
    // A guard snapshotted before the idle wait misses that finalize and undoes
    // against a history that does not contain the turn yet.
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-midstream-"));
    const gate = Promise.withResolvers<void>();
    const beforeSnapshot = Promise.withResolvers<void>();
    const finalizeParked = Promise.withResolvers<void>();
    let updateRefCount = 0;
    const runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]> = (workCwd, env) => {
      const inner = env ? createGitRunner(workCwd, { env }) : createGitRunner(workCwd);
      const gated: GitRunner = async (args, options) => {
        if (args[0] !== "update-ref") return inner(args, options);
        updateRefCount += 1;
        // Park the after-snapshot so the finalize outlives the host's wait.
        if (updateRefCount >= 2) {
          finalizeParked.resolve();
          await gate.promise;
        }
        const result = await inner(args, options);
        if (updateRefCount === 1) beforeSnapshot.resolve();
        return result;
      };
      gated.cwd = workCwd;
      return gated;
    };
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "midstream-session");
      await pi.emit("session_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await pi.emit("before_agent_start", ctx);
      await beforeSnapshot.promise;
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = "turn";
      const idle = Promise.withResolvers<void>();
      ctx.waitForIdle = () => idle.promise;

      // Issued mid-stream: no finalize is registered yet.
      const undoRun = pi.runCommand("undo", ctx);
      const agentEnd = pi.emit("agent_end", ctx);
      // Host cap elapsed: idle resolves while the finalize is still parked.
      await finalizeParked.promise;
      idle.resolve();
      await undoRun;
      expect(ctx.ui.notifications.at(-1)?.message).toContain("still being finalized");
      expect(ctx.leaf).toBe("turn");
      gate.resolve();
      await agentEnd;
    } finally {
      gate.resolve();
      await rmRetry(cwd);
    }
  });

  it("drops only the deferred turn whose after-snapshot raced the next turn", async () => {
    // Regression: a finalize waiting behind the previous turn's finalize left
    // its checkpoint in the pending slot, and the next before_agent_start
    // released it — deleting the before-ref of a checkpoint that was then
    // recorded anyway, leaving an unreferenced (gc-prunable) before-commit.
    // Turn 2's after-snapshot here is taken after turn 3 started, so it also
    // holds turn 3's edits: that turn is recorded session-only and both of
    // its refs go together, while turn 1's checkpoint survives intact.
    const cwd = await makeRepository("omp-undo-redo-defer-");
    const gate = Promise.withResolvers<void>();
    let retainSeen = 0;
    let parked = false;
    let addSeen = 0;
    const addListeners = new Set<() => void>();
    const waitForAdds = (n: number): Promise<void> =>
      new Promise((resolve) => {
        const check = () => {
          if (addSeen >= n) resolve();
        };
        addListeners.add(check);
        check();
      });
    const runner: NonNullable<OmpUndoRedoDependencies["gitRunnerFactory"]> = (workCwd, env) => {
      const inner = env ? createGitRunner(workCwd, { env }) : createGitRunner(workCwd);
      const gated: GitRunner = async (args, options) => {
        if (args.includes("add")) {
          const result = await inner(args, options);
          addSeen += 1;
          addListeners.forEach((l) => l());
          return result;
        }
        // The retain of the FIRST turn: park its finalize so the second
        // turn's finalize has to queue behind it.
        if (args[0] === "update-ref" && args.includes("--stdin")) {
          retainSeen += 1;
          if (retainSeen === 1) {
            parked = true;
            await gate.promise;
          }
        }
        return inner(args, options);
      };
      gated.cwd = workCwd;
      if (env) gated.env = env;
      return gated;
    };
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, { gitRunnerFactory: runner, captureDeadlineMs: 200 });
      const ctx = context(cwd, "defer-session");
      await pi.emit("session_start", ctx);

      ctx.leaf = "leaf0";
      await pi.emit("before_agent_start", ctx);
      await waitForAdds(1);
      await writeFile(join(cwd, "t1.txt"), "t1\n");
      ctx.leaf = "leaf1";
      const end1 = pi.emit("agent_end", ctx);
      for (let attempt = 0; attempt < 200 && !parked; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(parked).toBe(true);

      // Turn 2 captures normally, but its finalize must queue behind turn 1's.
      await pi.emit("before_agent_start", ctx);
      await waitForAdds(3);
      await writeFile(join(cwd, "t2.txt"), "t2\n");
      ctx.leaf = "leaf2";
      await pi.emit("agent_end", ctx);
      // Turn 3 starts before turn 2's finalize got to record anything.
      await pi.emit("before_agent_start", ctx);

      gate.resolve();
      await end1;
      ctx.navigateTree = async (targetId) => {
        ctx.leaf = targetId;
        return { cancelled: false };
      };
      // Undo retries until no finalize is outstanding, which is the only
      // observable "everything settled" signal.
      const messages: string[] = [];
      for (let undos = 0; undos < 2; undos += 1) {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          await pi.runCommand("undo", ctx);
          const message = ctx.ui.notifications.at(-1)?.message ?? "";
          if (
            message.includes("Nothing to undo") ||
            message.includes("still being captured") ||
            message.includes("still being finalized")
          ) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            continue;
          }
          messages.push(message);
          break;
        }
      }
      expect(messages[0]).toContain("files were not restored");
      // Turn 1 kept its file checkpoint: only the turn whose snapshot raced
      // the next turn is dropped.
      expect(messages[1]).toContain("file snapshot restored");
      // Exactly turn 1's retained pair: turn 2's released checkpoint leaves
      // neither a half-released ref nor an unreachable snapshot commit.
      const refs = await privateRefs(cwd);
      expect(refs.filter((ref) => ref.includes("/history/"))).toHaveLength(2);
    } finally {
      gate.resolve();
      await rmRetry(cwd);
    }
  });
});
