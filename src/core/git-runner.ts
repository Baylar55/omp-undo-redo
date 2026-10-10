import "./compat.js";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { GitRunner } from "./types.js";

const TERMINATION_GRACE_MS = 250;

/** On Windows, spawning a bare name (libuv `search_path`) tries the child's
 *  cwd before PATH, so `taskkill`/`git` would run an exe planted in the
 *  workspace. Both are spawned by absolute path instead. */
const TASKKILL = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");

/** libuv's lookup without its cwd step and relative PATH entries: each
 *  absolute PATH directory in order, `git.com` before `git.exe`. Runs only
 *  when the direct git.exe probe failed; not cached, so a moved or
 *  reinstalled git is found again like a bare `spawn("git")` would. */
async function findGitOnPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  for (const entry of ((pathKey && env[pathKey]) || "").split(";")) {
    const dir = entry.replaceAll('"', "");
    if (!isAbsolute(dir)) continue;
    for (const name of ["git.com", "git.exe"]) {
      const file = join(dir, name);
      if ((await stat(file).catch(() => null))?.isFile()) return file;
    }
  }
  return null;
}

/** Ceiling for any invocation that does not ask for a shorter one. A git child
 *  that never exits (stalled SMB/NFS mount, AV holding a handle, a `.git` lock
 *  contended by a wedged sibling) would otherwise leave its capture promise
 *  unsettled forever, which permanently blocks `/undo`//`redo` ("still being
 *  captured") and makes every later turn skip its capture. Generous on
 *  purpose: a timeout degrades the turn to session-only, so it must only fire
 *  when the child is genuinely wedged, never on a merely slow workspace. */
export const DEFAULT_TIMEOUT_MS = 120_000;

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

/** The real git.exe and the environment Git for Windows' launcher
 *  (`Git\cmd\git.exe`) would hand it. */
type DirectGit = { exe: string; pathPrefix: string; env: Record<string, string> };

/** Variables the launcher sets before starting the real git.exe
 *  (git-wrapper.c: `setup_environment`, `maybe_read_config`). */
const LAUNCHER_ENV = ["PATH", "HOME", "MSYSTEM", "PLINK_PROTOCOL", "MSYS"];

let directGit: Promise<DirectGit | null> | undefined;

/** On Windows `git` on PATH is usually a launcher that starts the real
 *  git.exe, so every invocation costs two processes. One probe through the
 *  launcher learns, via trace2, the environment the real git.exe received;
 *  later invocations start `<exec-path>\git.exe` (the binary git itself runs
 *  for its own subcommands) with that environment. Any surprise in the probe
 *  keeps the launcher. */
async function probeDirectGit(): Promise<DirectGit | null> {
  const probe = await runGit(
    tmpdir(),
    ["--exec-path"],
    {
      env: { GIT_TRACE2_EVENT: "2", GIT_TRACE2_ENV_VARS: LAUNCHER_ENV.join(",") },
      timeoutMs: 10_000,
    },
    {},
    null,
  );
  if (probe.code !== 0 || probe.error) return null;
  const traced = new Map<string, string>();
  for (const line of probe.stderr.split("\n")) {
    try {
      const event = JSON.parse(line) as { event?: unknown; param?: unknown; value?: unknown };
      if (
        event.event === "def_param" &&
        typeof event.param === "string" &&
        typeof event.value === "string"
      ) {
        traced.set(event.param, event.value);
      }
    } catch {
      // Not a trace2 event line.
    }
  }
  // `--exec-path` exits before git prepends its exec-path, so the traced PATH
  // is the launcher's: its own entries, then the inherited PATH.
  const execPath = probe.stdout.trim();
  const path = traced.get("PATH");
  const inherited = process.env.PATH ?? "";
  if (!execPath || path === undefined || !path.endsWith(inherited)) return null;
  const exe = join(execPath, "git.exe");
  if (!(await stat(exe).catch(() => null))?.isFile()) return null;
  const env: Record<string, string> = {};
  for (const name of LAUNCHER_ENV) {
    const value = traced.get(name);
    if (name !== "PATH" && value !== undefined && value !== process.env[name]) env[name] = value;
  }
  return { exe, pathPrefix: path.slice(0, path.length - inherited.length), env };
}

function resolveDirectGit(): Promise<DirectGit | null> {
  directGit ??= process.platform === "win32" ? probeDirectGit() : Promise.resolve(null);
  return directGit;
}

/** Every git invocation goes through `spawn`: it handles the stdin-fed
 *  `update-ref --stdin` batches and, unlike `execFile`, imposes no output
 *  buffer cap on large `for-each-ref`/`status` reads. Output that grows with
 *  the whole tree (`ls-tree -r`) is streamed through `onStdout` instead. */
async function runGit(
  cwd: string,
  args: string[],
  options: Parameters<GitRunner>[1],
  dependencies: GitRunnerDependencies,
  direct: DirectGit | null,
): Promise<ChildResult> {
  const { promise, resolve } = Promise.withResolvers<ChildResult>();
  const env: NodeJS.ProcessEnv = { ...process.env, ...direct?.env, ...options?.env };
  if (direct) {
    // Windows env names are case-insensitive; extend the existing key
    // (often `Path`) rather than adding a second one.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = direct.pathPrefix + (env[pathKey] ?? "");
  }
  // An injected spawn is a test double; give it the plain command.
  const command =
    direct?.exe ??
    (process.platform === "win32" && !dependencies.spawnGit ? await findGitOnPath(env) : "git");
  if (command === null) {
    return { stdout: "", stderr: "spawn git ENOENT", code: 1, error: "unavailable" };
  }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = (dependencies.spawnGit ?? spawn)(command, args, {
      cwd,
      env,
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
  let exited = false;
  let forced = false;
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
  /** Destroying the pipes lets Node emit `close` even when a descendant that
   *  survived the kill (hook, alias shell, orphaned real git.exe) still holds
   *  them open; without this a timeout would wait on that descendant forever. */
  const releaseStdio = () => {
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const terminate = () => {
    if (settled) return;
    timedOut = true;
    // Kill the tree: the child may be the launcher (Git\cmd\git.exe), which
    // starts the real git.exe with inherited pipes, and git itself may run
    // hooks or alias shells; `kill()` would end only the direct child. /T
    // must walk the tree while that child is alive.
    if (process.platform === "win32" && child.pid !== undefined && !exited) {
      spawn(TASKKILL, ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).once("error", () => {});
    } else {
      child.kill();
    }
    graceTimer = setTimeout(() => {
      if (settled) return;
      forced = true;
      child.kill("SIGKILL");
      if (exited) releaseStdio();
    }, dependencies.terminationGraceMs ?? TERMINATION_GRACE_MS);
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const onStdout = options?.onStdout;
  child.stdout.on("data", (chunk: string) => {
    if (onStdout) onStdout(chunk);
    else stdout += chunk;
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
  child.once("exit", () => {
    exited = true;
    if (forced) releaseStdio();
  });
  child.once("close", (code: number | null) => {
    settle({ stdout, stderr, code: typeof code === "number" ? code : 1 });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(options?.stdin);
  deadlineTimer = setTimeout(terminate, Math.max(1, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  return promise;
}

export function createGitRunner(cwd: string, dependencies: GitRunnerDependencies = {}): GitRunner {
  const { env } = dependencies;
  const runner: GitRunner = async (args, options) =>
    runGit(
      cwd,
      args,
      { ...options, env: { ...env, ...options?.env } },
      dependencies,
      // An injected spawn is a test double; give it the plain command.
      dependencies.spawnGit ? null : await resolveDirectGit(),
    );
  runner.cwd = cwd;
  if (env) runner.env = env;
  return runner;
}
