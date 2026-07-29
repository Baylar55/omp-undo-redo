import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import ompUndoRedo from "../src/index.js";

const execFileAsync = promisify(execFile);
type Handler = (...args: unknown[]) => unknown;

type TestContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string;
    getBranch(): [];
    getEntry(): undefined;
  };
};

class FakeExtensionApi {
  private readonly handlers = new Map<string, Handler>();

  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }

  registerCommand(): void {
    // Commands are not part of these lifecycle tests.
  }

  async emit(event: string, context: TestContext): Promise<void> {
    const handler = this.handlers.get(event);
    if (!handler) throw new Error(`No handler registered for ${event}`);
    await handler({ type: event }, context);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, { cwd, windowsHide: true });
  return result.stdout.trim();
}

async function makeRepository(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-lifecycle-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "base"]);
  return cwd;
}

function context(cwd: string, sessionId: string): TestContext {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
      getLeafId: () => "leaf",
      getBranch: () => [],
      getEntry: () => undefined,
    },
  };
}

async function privateRefs(cwd: string): Promise<string[]> {
  const output = await git(cwd, ["for-each-ref", "--format=%(refname)", "refs/omp-undo-redo/"]);
  return output ? output.split("\n") : [];
}

describe("extension lifecycle cleanup", () => {
  it("releases completed checkpoints, pending checkpoints, and unrelated refs survive", async () => {
    const cwd = await makeRepository();
    try {
      await git(cwd, ["update-ref", "refs/keep", "HEAD"]);
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "session-one");

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      await pi.emit("agent_end", ctx);
      expect(await privateRefs(cwd)).toHaveLength(2);

      await pi.emit("session_shutdown", ctx);
      await pi.emit("session_shutdown", ctx);
      expect(await privateRefs(cwd)).toEqual([]);
      expect(await git(cwd, ["rev-parse", "refs/keep"])).toBe(
        await git(cwd, ["rev-parse", "HEAD"]),
      );

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await pi.emit("session_shutdown", ctx);
      expect(await privateRefs(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drains pending checkpoints when shutdown interrupts a turn", async () => {
    const cwd = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = context(cwd, "pending-session");

      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      expect(await privateRefs(cwd)).toHaveLength(1);
      await pi.emit("session_shutdown", ctx);
      expect(await privateRefs(cwd)).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("drains every in-memory session and repository", async () => {
    const first = await makeRepository();
    const second = await makeRepository();
    try {
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const firstContext = context(first, "first-session");
      const secondContext = context(second, "second-session");

      await pi.emit("session_start", firstContext);
      await pi.emit("before_agent_start", firstContext);
      await writeFile(join(first, "tracked.txt"), "first change\n");
      await pi.emit("agent_end", firstContext);
      await pi.emit("session_start", secondContext);
      await pi.emit("before_agent_start", secondContext);
      await writeFile(join(second, "tracked.txt"), "second change\n");
      await pi.emit("agent_end", secondContext);
      expect(await privateRefs(first)).toHaveLength(2);
      expect(await privateRefs(second)).toHaveLength(2);

      await pi.emit("session_shutdown", secondContext);
      expect(await privateRefs(first)).toEqual([]);
      expect(await privateRefs(second)).toEqual([]);
    } finally {
      await Promise.all([
        rm(first, { recursive: true, force: true }),
        rm(second, { recursive: true, force: true }),
      ]);
    }
  });
});
