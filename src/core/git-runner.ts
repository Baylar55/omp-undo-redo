import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import type { GitRunner } from "./types.js";

const execFileAsync = promisify(execFile);
const TERMINATION_GRACE_MS = 250;

type ChildResult = {
  stdout: string;
  stderr: string;
  code: number;
  error?: "unavailable" | "timeout";
};

export interface GitRunnerDependencies {
  spawnGit?: typeof spawn;
  terminationGraceMs?: number;
}

async function runExec(
  cwd: string,
  args: string[],
  options: NonNullable<Parameters<GitRunner>[1]> | undefined,
  env: Record<string, string | undefined>,
): Promise<ChildResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      timeout: options?.timeoutMs,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number;
      killed?: boolean;
    };
    const timedOut = options?.timeoutMs !== undefined && failure.killed === true;
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: typeof failure.code === "number" ? failure.code : 1,
      ...(timedOut
        ? { error: "timeout" as const }
        : typeof failure.code === "number"
          ? {}
          : { error: "unavailable" as const }),
    };
  }
}

function runStdinCommand(
  cwd: string,
  args: string[],
  options: NonNullable<Parameters<GitRunner>[1]>,
  dependencies: GitRunnerDependencies,
): Promise<ChildResult> {
  let resolve!: (value: ChildResult) => void;
  const promise = new Promise<ChildResult>((complete) => {
    resolve = complete;
  });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (dependencies.spawnGit ?? spawn)("git", args, {
      cwd,
      env: { ...process.env, ...options.env },
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
  child.stdin.end(options.stdin);
  if (options.timeoutMs !== undefined) {
    deadlineTimer = setTimeout(terminate, Math.max(1, options.timeoutMs));
  }
  return promise;
}

export function createGitRunner(cwd: string, dependencies: GitRunnerDependencies = {}): GitRunner {
  const runner: GitRunner = async (args, options) => {
    if (options?.stdin !== undefined) return runStdinCommand(cwd, args, options, dependencies);
    return runExec(cwd, args, options, options?.env ?? {});
  };
  runner.cwd = cwd;
  return runner;
}

/** A git runner whose every invocation merges `env` after `process.env` (and
 *  before per-invocation options.env), so the fixed env overrides the process
 *  environment. Used for private per-workspace repositories where GIT_DIR must
 *  be present on every command. The runner exposes `env` so callers can detect
 *  which fixed variables it carries. */
export function createEnvGitRunner(
  cwd: string,
  env: Record<string, string>,
  dependencies: GitRunnerDependencies = {},
): GitRunner {
  const runner: GitRunner = async (args, options) => {
    const mergedEnv = { ...env, ...options?.env };
    if (options?.stdin !== undefined) {
      return runStdinCommand(cwd, args, { ...options, env: mergedEnv }, dependencies);
    }
    return runExec(cwd, args, options, mergedEnv);
  };
  runner.cwd = cwd;
  runner.env = env;
  return runner;
}
