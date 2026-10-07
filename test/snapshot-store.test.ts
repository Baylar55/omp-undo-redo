import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkpointNamespace,
  historyRefPrefix,
  resolveRepository,
} from "../src/core/checkpoints.js";
import { createGitRunner } from "../src/core/git-runner.js";
import { historyDirectory } from "../src/core/history-store.js";
import { activeHeartbeatPath } from "../src/core/history-liveness.js";
import type { GitRepository, GitRunner } from "../src/core/types.js";
import ompUndoRedo, { type OmpUndoRedoDependencies } from "../src/index.js";
import {
  context,
  FakeExtensionApi,
  git,
  gitRepository,
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

/** Runner factory that counts the finished gcs of `repository`'s store. */
function countingStoreGcs(repository: GitRepository): {
  dependencies: OmpUndoRedoDependencies;
  finished: () => number;
} {
  let finished = 0;
  return {
    finished: () => finished,
    dependencies: {
      gitRunnerFactory: (cwd: string, env?: Record<string, string>): GitRunner => {
        const inner = createGitRunner(cwd, env ? { env } : undefined);
        // Basename: the sweep's GIT_DIR may spell the root differently (8.3).
        const counted = basename(env?.GIT_DIR ?? "") === basename(repository.storeDir);
        const wrapped: GitRunner = async (args, options) => {
          try {
            return await inner(args, options);
          } finally {
            if (counted && args[0] === "gc") finished += 1;
          }
        };
        wrapped.cwd = cwd;
        if (env) wrapped.env = env;
        return wrapped;
      },
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/** Whether the store holds `object` itself, not through the user's objects. */
async function storeHolds(repository: GitRepository, object: string): Promise<boolean> {
  const local = createGitRunner(repository.worktree, {
    env: { GIT_DIR: repository.storeDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
  });
  return (await local(["cat-file", "-e", object])).code === 0;
}

/** A turn whose before-snapshot holds `draft\n`, a version of tracked.txt
 *  only a commit the user reset away reaches (packed in the user's objects,
 *  so the capture copies it into the store), followed by the shutdown's
 *  store gc. Returns that blob once the gc has finished. */
async function turnOverResetCommit(cwd: string, sessionId: string): Promise<string> {
  await writeFile(join(cwd, "tracked.txt"), "draft\n");
  await git(cwd, ["commit", "-qam", "draft"]);
  const draft = await git(cwd, ["rev-parse", "HEAD:tracked.txt"]);
  await git(cwd, ["gc", "-q"]);
  await git(cwd, ["reset", "-q", "HEAD~"]);

  const repository = await gitRepository(cwd);
  const gcs = countingStoreGcs(repository);
  const pi = new FakeExtensionApi();
  ompUndoRedo(pi as never, gcs.dependencies);
  const ctx = resumedContext(cwd, sessionId);
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
  expect(await storeHolds(repository, draft)).toBe(true);
  await pi.emit("session_shutdown", ctx);
  expect(await waitFor(() => gcs.finished() > 0)).toBe(true);
  return draft;
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

  it("keeps a checkpoint restorable through a store gc and the user's aggressive prune", async () => {
    // Regression (#104): the store's gc dropped its copy of content the user's
    // repository still held (`repack -l`, prune of packed duplicates), so the
    // user's next aggressive prune deleted the only one left.
    const cwd = await makeRepository();
    const sessionId = "pinned-session";
    try {
      const draft = await turnOverResetCommit(cwd, sessionId);
      expect(await storeHolds(await gitRepository(cwd), draft)).toBe(true);
      await git(cwd, ["reflog", "expire", "--expire=now", "--all"]);
      await git(cwd, ["gc", "-q", "--prune=now"]);
      await expect(git(cwd, ["cat-file", "-e", draft])).rejects.toThrow();

      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never);
      const ctx = resumedContext(cwd, sessionId);
      await pi.emit("session_start", ctx);
      await pi.runCommand("undo", ctx);
      expect(ctx.leaf).toBe(prompt.id);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("draft\n");
      expect(ctx.ui.notifications.at(-1)?.message).toBe(
        "Undid last turn: session moved back and file snapshot restored.",
      );
      await pi.emit("session_shutdown", ctx);
    } finally {
      await rmRetry(cwd);
    }
  }, 60000);

  it("reclaims an expired session's pinned content at the next store gc", async () => {
    const cwd = await makeRepository();
    const sessionId = "expiring-pinned-session";
    try {
      const draft = await turnOverResetCommit(cwd, sessionId);
      const repository = await gitRepository(cwd);
      const packDir = join(repository.storeDir, "objects", "pack");
      expect((await readdir(packDir)).some((name) => name.endsWith(".keep"))).toBe(true);
      // Dormant past retention, and packed before the gc's prune window.
      const hash = checkpointNamespace(sessionId);
      const historyFile = join(historyDirectory(repository), `${hash}.json`);
      const history = JSON.parse(await readFile(historyFile, "utf8")) as Record<string, unknown>;
      history.lastAccessedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await writeFile(historyFile, JSON.stringify(history));
      await rm(activeHeartbeatPath(historyDirectory(repository), hash), { force: true });
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      for (const name of await readdir(packDir)) await utimes(join(packDir, name), old, old);

      const gcs = countingStoreGcs(repository);
      const pi = new FakeExtensionApi();
      ompUndoRedo(pi as never, gcs.dependencies);
      const ctx = context(cwd, "expiring-pinned-current");
      await pi.emit("session_start", ctx);
      expect(await waitFor(() => gcs.finished() > 0)).toBe(true);
      expect(await privateRefs(cwd)).toEqual([]);
      expect(await storeHolds(repository, draft)).toBe(false);
      expect((await readdir(packDir)).some((name) => name.endsWith(".keep"))).toBe(false);
      await pi.emit("session_shutdown", ctx);
    } finally {
      await rmRetry(cwd);
    }
  }, 60000);
});
