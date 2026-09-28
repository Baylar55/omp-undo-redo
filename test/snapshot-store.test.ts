import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkpointNamespace,
  historyRefPrefix,
  resolveRepository,
} from "../src/core/checkpoints.js";
import { createGitRunner } from "../src/core/git-runner.js";
import ompUndoRedo from "../src/index.js";
import {
  context,
  FakeExtensionApi,
  git,
  makeRepository,
  privateRefs,
  rmRetry,
  type TestEntry,
} from "./helpers.js";

const SECRET = "API_KEY=sk-live-SECRET\n";
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

/** Everything `git push --mirror` exports from `cwd`. */
async function mirroredRefs(cwd: string): Promise<{ remote: string; refs: string[] }> {
  const remote = await mkdtemp(join(tmpdir(), "omp-undo-redo-mirror-"));
  await git(remote, ["init", "-q", "--bare"]);
  await git(cwd, ["push", "-q", "--mirror", remote]);
  const refs = await git(remote, ["for-each-ref", "--format=%(refname)"]);
  return { remote, refs: refs.split("\n") };
}

function resumedContext(cwd: string, sessionId: string) {
  const ctx = context(cwd, sessionId);
  ctx.leaf = response.id;
  ctx.branch = [prompt, response];
  ctx.entries = [prompt, response];
  ctx.navigateTree = async (targetId) => {
    ctx.leaf = targetId;
    ctx.branch = targetId === prompt.id ? [prompt] : [prompt, response];
    return { cancelled: false };
  };
  return ctx;
}

async function snapshot(cwd: string, message: string): Promise<string> {
  const index = join(cwd, ".git", "legacy-index");
  const env = { GIT_INDEX_FILE: index };
  const run = (args: string[]) =>
    createGitRunner(cwd)(args, { env }).then((result) => result.stdout.trim());
  await run(["read-tree", "HEAD"]);
  await run(["add", "-A"]);
  const tree = await run(["write-tree"]);
  await rm(index, { force: true });
  return run(["commit-tree", tree, "-m", message]);
}

describe("snapshot storage", () => {
  it("keeps Git-mode snapshots out of everything push --mirror exports", async () => {
    const cwd = await makeRepository();
    let remote: string | undefined;
    try {
      await writeFile(join(cwd, ".env.local"), SECRET);
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = resumedContext(cwd, "mirror-session");
      ctx.leaf = prompt.id;
      ctx.branch = [prompt];
      ctx.entries = [prompt];
      await pi.emit("session_start", ctx);
      await pi.emit("before_agent_start", ctx);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      ctx.leaf = response.id;
      ctx.branch = [prompt, response];
      ctx.entries = [prompt, response];
      await pi.emit("agent_end", ctx);

      expect(await privateRefs(cwd)).toHaveLength(2);
      const secretBlob = await git(cwd, ["hash-object", ".env.local"]);
      await expect(git(cwd, ["cat-file", "-e", secretBlob])).rejects.toThrow();
      const mirrored = await mirroredRefs(cwd);
      remote = mirrored.remote;
      expect(mirrored.refs).toEqual([await git(cwd, ["symbolic-ref", "HEAD"])]);

      await pi.runCommand("undo", ctx);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      await pi.emit("session_shutdown", ctx);
    } finally {
      if (remote) await rmRetry(remote);
      await rmRetry(cwd);
    }
  });

  it("moves snapshots an earlier version left in the user's repository into the store", async () => {
    const cwd = await makeRepository();
    const sessionId = "legacy-session";
    let remote: string | undefined;
    try {
      // The pre-store layout: refs and history inside the user's `.git`.
      await writeFile(join(cwd, ".env.local"), SECRET);
      const beforeHash = await snapshot(cwd, "omp-undo-redo: before turn");
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      const afterHash = await snapshot(cwd, "omp-undo-redo: after turn");
      const prefix = `${historyRefPrefix(checkpointNamespace(sessionId))}0123456789abcdef`;
      await git(cwd, ["update-ref", `${prefix}/before`, beforeHash]);
      await git(cwd, ["update-ref", `${prefix}/after`, afterHash]);
      const resolved = await resolveRepository(createGitRunner(cwd));
      if (!("repository" in resolved)) throw new Error("repository did not resolve");
      const { repository } = resolved;
      const historyDir = join(repository.commonDir, "omp-undo-redo", "history");
      await mkdir(historyDir, { recursive: true });
      await writeFile(
        join(historyDir, `${checkpointNamespace(sessionId)}.json`),
        JSON.stringify({
          schemaVersion: 2,
          sessionHash: checkpointNamespace(sessionId),
          repository,
          checkpoints: [
            {
              kind: "git",
              repository,
              beforeHash,
              beforeRef: `${prefix}/before`,
              afterHash,
              afterRef: `${prefix}/after`,
              parentLeafId: prompt.id,
              leafId: response.id,
            },
          ],
          currentIndex: 0,
          lastAccessedAt: new Date().toISOString(),
        }),
      );

      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = resumedContext(cwd, sessionId);
      await pi.emit("session_start", ctx);

      // privateRefs asserts none remain in the user's repository.
      expect(await privateRefs(cwd)).toEqual([`${prefix}/after`, `${prefix}/before`]);
      await expect(
        readFile(join(historyDir, `${checkpointNamespace(sessionId)}.json`)),
      ).rejects.toThrow();
      const mirrored = await mirroredRefs(cwd);
      remote = mirrored.remote;
      expect(mirrored.refs).toEqual([await git(cwd, ["symbolic-ref", "HEAD"])]);
      // The snapshots' own objects were copied, not borrowed: the user's gc
      // may now drop them without breaking the restore.
      await git(cwd, ["reflog", "expire", "--expire=now", "--all"]);
      await git(cwd, ["gc", "-q", "--prune=now"]);
      await expect(git(cwd, ["cat-file", "-e", beforeHash])).rejects.toThrow();

      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe(prompt.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid last turn: session moved back and file snapshot restored.",
      );
      await pi.emit("session_shutdown", ctx);
    } finally {
      if (remote) await rmRetry(remote);
      await rmRetry(cwd);
    }
  });
});
