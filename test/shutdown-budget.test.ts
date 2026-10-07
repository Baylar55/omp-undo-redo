import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HISTORY_REF_ROOT } from "../src/core/checkpoints.js";
import { gcPendingPath } from "../src/core/git-refs.js";
import { createGitRunner } from "../src/core/git-runner.js";
import type { GitRunner } from "../src/core/types.js";
import ompUndoRedo from "../src/index.js";
import { context, FakeExtensionApi, gitRepository, makeRepository, rmRetry } from "./helpers.js";

/** OMP's `session_shutdown` cap (SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS); the
 *  process exits right after it, so nothing past it runs. */
const HOST_SHUTDOWN_CAP_MS = 2_000;

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

type Scenario = {
  /** Git commands held open once armed; released ones fail without running. */
  hang: (args: readonly string[]) => boolean;
  /** `launch`: from the start. `second-turn`: from a second turn's capture,
   *  which then never settles. `shutdown`: from the shutdown, after a second
   *  turn's capture left a pending checkpoint for it to release. */
  arm: "launch" | "second-turn" | "shutdown";
  prepare?: (storeDir: string) => Promise<void>;
};

/** One finished turn in a Git workspace, then a shutdown with the scenario's
 *  git commands held open. Asserts the shutdown fits the host cap and still
 *  removed every index lease and the runtime directory. */
async function shutdownWithHungGit({ hang, arm, prepare }: Scenario): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "omp-undo-redo-shutdown-"));
  const previous = {
    store: process.env.OMP_UNDO_REDO_STORE_DIR,
    runtime: process.env.OMP_UNDO_REDO_RUNTIME_DIR,
  };
  process.env.OMP_UNDO_REDO_STORE_DIR = join(root, "store");
  process.env.OMP_UNDO_REDO_RUNTIME_DIR = join(root, "runtime");
  const cwd = await makeRepository();
  const gate = Promise.withResolvers<void>();
  const reached = Promise.withResolvers<void>();
  const indexDirectories = new Set<string>();
  let armed = arm === "launch";
  try {
    const { storeDir } = await gitRepository(cwd);
    await prepare?.(storeDir);
    const pi = new FakeExtensionApi();
    ompUndoRedo(pi as never, {
      gitRunnerFactory: (runnerCwd, env) => {
        const inner = createGitRunner(runnerCwd, { env });
        const wrapped: GitRunner = async (args, options) => {
          const index = options?.env?.GIT_INDEX_FILE;
          if (index) indexDirectories.add(dirname(index));
          if (armed && hang(args)) {
            reached.resolve();
            await gate.promise;
            return { stdout: "", stderr: "released by test", code: 1 };
          }
          return inner(args, options);
        };
        wrapped.cwd = runnerCwd;
        if (env) wrapped.env = env;
        return wrapped;
      },
    });
    const ctx = context(cwd, "shutdown-budget-session");
    await pi.emit("session_start", ctx);
    await pi.emit("before_agent_start", ctx);
    await writeFile(join(cwd, "tracked.txt"), "changed\n");
    await pi.emit("agent_end", ctx);
    expect(indexDirectories.size).toBeGreaterThan(0);
    if (arm === "second-turn") {
      armed = true;
      ctx.leaf = "leaf2";
      // Not awaited: the capture never settles, and the turn waits on it.
      void pi.emit("before_agent_start", ctx);
      await reached.promise;
    } else if (arm === "shutdown") {
      ctx.leaf = "leaf2";
      await pi.emit("before_agent_start", ctx);
      armed = true;
    }

    const started = Date.now();
    const shutdown = pi.emit("session_shutdown", ctx).then(() => Date.now() - started);
    // Real clock on purpose: the contract is OMP's wall-clock cap over real
    // git children. The race only bounds a shutdown that would never settle.
    const elapsed = await Promise.race([
      shutdown,
      new Promise<number>((resolve) => setTimeout(() => resolve(Infinity), 6_000)),
    ]);
    expect(elapsed).toBeLessThan(HOST_SHUTDOWN_CAP_MS);
    for (const directory of indexDirectories) expect(await exists(directory)).toBe(false);
    expect(await readdir(join(root, "runtime"))).toEqual([]);
  } finally {
    gate.resolve();
    process.env.OMP_UNDO_REDO_STORE_DIR = previous.store;
    process.env.OMP_UNDO_REDO_RUNTIME_DIR = previous.runtime;
    if (previous.store === undefined) delete process.env.OMP_UNDO_REDO_STORE_DIR;
    if (previous.runtime === undefined) delete process.env.OMP_UNDO_REDO_RUNTIME_DIR;
    await rmRetry(cwd);
    await rmRetry(root);
  }
}

describe("session_shutdown budget", () => {
  it("cleans up inside the host cap while a retention expiry hangs", async () => {
    await shutdownWithHungGit({
      arm: "launch",
      hang: (args) => args[0] === "for-each-ref" && args.includes(HISTORY_REF_ROOT),
    });
  }, 30_000);

  it("cleans up inside the host cap while a background gc runs", async () => {
    await shutdownWithHungGit({
      arm: "launch",
      hang: (args) => args[0] === "prune",
      // A pending mark makes the session's own expiry schedule a store gc.
      prepare: async (storeDir) => {
        await mkdir(dirname(gcPendingPath(storeDir)), { recursive: true });
        await writeFile(gcPendingPath(storeDir), "");
      },
    });
  }, 30_000);

  it("removes a checked-out index lease inside the host cap while its capture hangs", async () => {
    await shutdownWithHungGit({ arm: "second-turn", hang: (args) => args[0] === "add" });
  }, 30_000);

  it("removes every index lease inside the host cap while all shutdown git hangs", async () => {
    await shutdownWithHungGit({ arm: "shutdown", hang: () => true });
  }, 30_000);
});
