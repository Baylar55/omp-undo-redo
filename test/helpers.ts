import "../src/core/compat.js";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type Handler = (...args: unknown[]) => unknown;

export type TestEntry = {
  id: string;
  parentId: string | null;
  type: string;
  message?: { role?: string };
  customType?: string;
};

export type TestContext = {
  cwd: string;
  leaf: string;
  branch: TestEntry[];
  entries: TestEntry[];
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string;
    getBranch(): TestEntry[];
    getEntry(id: string): TestEntry | undefined;
  };
  navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
  waitForIdle(): Promise<void>;
  isIdle(): boolean;
  ui: {
    notifications: Array<{ message: string; level: string }>;
    notify(message: string, level: string): void;
  };
};

/** Records the extension's event/command registrations so tests can drive them
 *  directly. Contexts are forwarded untouched. */
export class FakeExtensionApi {
  private readonly handlers = new Map<string, Handler>();
  private readonly commands = new Map<string, Handler>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  registerCommand(name: string, config: { handler: Handler }): void {
    this.commands.set(name, config.handler);
  }

  async runCommand(name: string, context: TestContext): Promise<void> {
    const handler = this.commands.get(name);
    if (!handler) throw new Error(`No command registered for ${name}`);
    await handler("", context);
  }

  async emit(
    event: string,
    context: TestContext,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for ${event}`);
    await handler(payload ?? { type: event }, context);
  }
}

export function context(cwd: string, sessionId: string): TestContext {
  const value: TestContext = {
    cwd,
    leaf: "leaf",
    branch: [],
    entries: [],
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => value.leaf,
      getBranch: () => value.branch,
      getEntry: (id) => value.entries.find((entry) => entry.id === id),
    },
    navigateTree: async () => ({ cancelled: true }),
    waitForIdle: async () => {},
    isIdle: () => true,
    ui: {
      notifications: [],
      notify(message, level) {
        value.ui.notifications.push({ message, level });
      },
    },
  };
  return value;
}

/** Windows keeps a directory handle until the last git child whose cwd it was
 *  exits, so a teardown rm can race a slow capture/sweep. Suites that tear down
 *  whole workspaces mid-settle should raise `attempts`. */
export async function rmRetry(path: string, attempts = 6): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await sleep(200);
    }
  }
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

/** Temp repository with one committed file, deterministic identity and line
 *  endings. */
export async function makeRepository(prefix = "omp-undo-redo-repo-"): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

export async function privateRefs(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/omp-undo-redo/"]);
  return output ? output.split("\n") : [];
}
