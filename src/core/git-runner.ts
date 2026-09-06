import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { GitRunner } from "./types.js";

const TERMINATION_GRACE_MS = 250;

type ChildResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: "unavailable" | "timeout";
};

export interface GitRunnerDependencies {
  /** Fixed env merged after `process.env` and before per-invocation
   *  `options.env`, so it overrides the process environment. Used for private
   *  per-workspace repositories where GIT_DIR must be present on every command;
   *  the runner re-exposes it as `runner.env` so callers can detect it. */
  env?: Record<string, string>;
  spawnGit?: typeof spawn;
  terminationGraceMs?: number;
}

/** Every git invocation goes through `spawn`: it handles the stdin-fed
 *  `update-ref --stdin` batches and, unlike `execFile`, imposes no output
 *  buffer cap on large `for-each-ref`/`status` reads. */
function runGit(
  cwd: string,
  args: string[],
  options: Parameters<GitRunner>[1],
  dependencies: GitRunnerDependencies,
): Promise<ChildResult> {
  const { promise, resolve } = Promise.withResolvers<ChildResult>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (dependencies.spawnGit ?? spawn)("git", args, {
      cwd,
      env: { ...process.env, ...options?.env },
      windowsHide: true,
    });
  } catch (error) {
    resolve({
      stdout: "",
      stderr: error instanceof Error ? error.message : "",
      code: 1,
      error: "unavailable",
    });
    return promise;
  }

  let stdout = "";
  let stderr = "";
  let settled = false;
  let timedOut = false;
  let deadlineTimer: NodeJS.Timeout | undefined;
  let graceTimer: NodeJS.Timeout | undefined;

  const clearTimers = () => {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (graceTimer) clearTimeout(graceTimer);
    deadlineTimer = undefined;
    graceTimer = undefined;
  };
  const settle = (result: ChildResult) => {
    if (settled) return;
    settled = true;
    clearTimers();
    resolve(timedOut ? { ...result, error: "timeout" } : result);
  };
  const terminate = () => {
    if (settled) return;
    timedOut = true;
    child.kill();
    graceTimer = setTimeout(() => {
      if (!settled) child.kill("SIGKILL");
    }, dependencies.terminationGraceMs ?? TERMINATION_GRACE_MS);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error: Error) => {
    settle({
      stdout,
      stderr: `${stderr}${error.message}`,
      code: 1,
      error: timedOut ? "timeout" : "unavailable",
    });
  });
  child.once("close", (code: number | null) => {
    settle({ stdout, stderr, code: typeof code === "number" ? code : 1 });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options?.stdin);
  if (options?.timeoutMs !== undefined) {
    deadlineTimer = setTimeout(terminate, Math.max(1, options.timeoutMs));
  }
  return promise;
}

export function createGitRunner(cwd: string, dependencies: GitRunnerDependencies = {}): GitRunner {
  const { env } = dependencies;
  const runner: GitRunner = async (args, options) =>
    runGit(cwd, args, { ...options, env: { ...env, ...options?.env } }, dependencies);
  runner.cwd = cwd;
  if (env) runner.env = env;
  return runner;
}
