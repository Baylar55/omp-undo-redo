import { once } from "node:events";
import { execFile, spawn } from "node:child_process";
import {
  mkdir,
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionNavigation } from "../src/core/session-navigation.js";
import {
  applyCheckpoint,
  checkpointNamespace,
  finishAfterTurn,
  prepareBeforeTurn,
  releaseAllPersistentSnapshotIndices,
  releaseCheckpoint,
  previousCheckpoint,
  releaseRefs,
  releasePendingCheckpoint,
} from "../src/core/checkpoints.js";
import type {
  GitCheckpoint,
  GitRunner,
  NavigationPort,
  PendingGitCheckpoint,
  SessionEntryLike,
  SessionReader,
} from "../src/core/types.js";

const execFileAsync = promisify(execFile);

function reader(entries: SessionEntryLike[], leafId: string | null): SessionReader {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId,
    getEntry: (id) => byId.get(id),
    getBranch: (fromId) => {
      const result: SessionEntryLike[] = [];
      let current = fromId ? byId.get(fromId) : undefined;
      while (current) {
        result.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return result;
    },
  };
}

const entries: SessionEntryLike[] = [
  { id: "u1", parentId: null, type: "message", message: { role: "user" } },
  { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
  { id: "u2", parentId: "a1", type: "message", message: { role: "user" } },
  { id: "a2", parentId: "u2", type: "message", message: { role: "assistant" } },
];

function gitRunner(cwd: string): GitRunner {
  const runner: GitRunner = async (args, options) => {
    if (options?.stdin !== undefined) {
      const child = spawn("git", args, {
        cwd,
        env: { ...process.env, ...options.env },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
      try {
        const [code] = (await once(child, "close")) as [number | null];
        return { stdout, stderr, code: typeof code === "number" ? code : 1 };
      } catch (error) {
        return { stdout, stderr: `${stderr}${String(error)}`, code: 1 };
      }
    }
    try {
      const result = await execFileAsync("git", args, {
        cwd,
        env: { ...process.env, ...options?.env },
        windowsHide: true,
      });
      return { stdout: result.stdout, stderr: result.stderr, code: 0 };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? "",
        code: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  };
  runner.cwd = cwd;
  return runner;
}

async function makeRepo(): Promise<{ cwd: string; git: GitRunner }> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-repo-"));
  const git = gitRunner(cwd);
  await git(["init", "-q"]);
  await git(["config", "user.name", "test"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "core.autocrlf", "false"]);
  return { cwd, git };
}

async function initializeBranch(git: GitRunner, cwd: string): Promise<void> {
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "base"]);
  await git(["branch", "-M", "A"]);
}

async function text(
  git: GitRunner,
  args: string[],
  options?: Parameters<GitRunner>[1],
): Promise<string> {
  const result = await git(args, options);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

async function branchRefs(git: GitRunner): Promise<string> {
  return text(git, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]);
}

async function indexPath(git: GitRunner, cwd: string): Promise<string> {
  const value = await text(git, ["rev-parse", "--git-path", "index"]);
  return isAbsolute(value) ? value : resolve(cwd, value);
}

async function indexState(
  git: GitRunner,
  cwd: string,
): Promise<{
  tree: string;
  raw: Buffer;
}> {
  const path = await indexPath(git, cwd);
  return { tree: await text(git, ["write-tree"]), raw: await readFile(path) };
}

function pendingCheckpoint(
  result: Awaited<ReturnType<typeof prepareBeforeTurn>>,
): PendingGitCheckpoint {
  expect(result.status).toBe("git");
  if (result.status !== "git") throw new Error(`Expected Git checkpoint, got ${result.reason}`);
  return result.checkpoint;
}

function completedCheckpoint(result: Awaited<ReturnType<typeof finishAfterTurn>>): GitCheckpoint {
  expect(result.status).toBe("git");
  if (result.status !== "git") throw new Error(`Expected Git checkpoint, got ${result.reason}`);
  return result.checkpoint;
}

function checkpointWithRepository(
  beforeHash: string,
  afterHash: string,
  repository: GitCheckpoint["repository"],
): GitCheckpoint {
  return {
    kind: "git",
    repository,
    beforeHash,
    beforeRef: "refs/omp-undo-redo/test/before",
    afterHash,
    afterRef: "refs/omp-undo-redo/test/after",
    parentLeafId: null,
    leafId: null,
  };
}

describe("previousCheckpoint", () => {
  it("selects the first prompt boundary so the first interaction is undoable", () => {
    expect(previousCheckpoint(reader(entries.slice(0, 2), "a1"))).toBe("u1");
    expect(previousCheckpoint(reader(entries.slice(0, 1), "u1"))).toBeNull();
  });

  it("selects the latest prompt boundary", () => {
    expect(previousCheckpoint(reader(entries, "a2"))).toBe("u2");
  });
});

describe("checkpoint namespaces", () => {
  it("hashes session IDs and keeps refs in the private namespace", () => {
    const namespace = checkpointNamespace("session/raw id");
    expect(namespace).toMatch(/^[0-9a-f]{64}$/);
    expect(namespace).not.toContain("session");
  });
});

describe("history-safe Git checkpoints", () => {
  it("keeps an intervening agent commit and preserves refs, index, undo, and redo", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const beforeIndex = await indexState(git, cwd);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "intervening-commit"));
      expect(before).not.toBeNull();
      if (!before) return;
      expect(await indexState(git, cwd)).toEqual(beforeIndex);

      await writeFile(join(cwd, "agent.txt"), "agent commit\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "agent change"]);
      const agentCommit = await text(git, ["rev-parse", "HEAD"]);
      const branchTip = await text(git, ["rev-parse", "refs/heads/A"]);
      const afterAgentIndex = await indexState(git, cwd);
      await writeFile(join(cwd, "turn.txt"), "uncommitted turn change\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;

      expect(await text(git, ["rev-parse", "HEAD"])).toBe(agentCommit);
      expect(await text(git, ["rev-parse", "refs/heads/A"])).toBe(branchTip);
      expect(await text(git, ["log", "--first-parent", "--format=%H"])).toContain(agentCommit);
      expect(await indexState(git, cwd)).toEqual(afterAgentIndex);
      expect(await text(git, ["rev-parse", `${after.beforeRef}^{commit}`])).toBe(after.beforeHash);
      expect(await text(git, ["rev-parse", `${after.afterRef}^{commit}`])).toBe(after.afterHash);

      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      expect(await text(git, ["rev-parse", "HEAD"])).toBe(agentCommit);
      await expect(readFile(join(cwd, "agent.txt"))).rejects.toThrow();
      await expect(readFile(join(cwd, "turn.txt"))).rejects.toThrow();
      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await text(git, ["rev-parse", "HEAD"])).toBe(agentCommit);
      expect(await readFile(join(cwd, "agent.txt"), "utf8")).toBe("agent commit\n");
      expect(await readFile(join(cwd, "turn.txt"), "utf8")).toBe("uncommitted turn change\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves staged turn state while undoing and redoing the worktree", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "staged-turn-divergence"));
      expect(before).not.toBeNull();
      if (!before) return;

      await writeFile(join(cwd, "tracked.txt"), "turn\n");
      await git(["add", "tracked.txt"]);
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;

      const savedIndexPath = await indexPath(git, cwd);
      const savedIndex = await indexState(git, cwd);
      expect(await text(git, ["status", "--short"], { env: { GIT_OPTIONAL_LOCKS: "0" } })).toBe(
        "M  tracked.txt",
      );

      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");
      expect(await readFile(savedIndexPath)).toEqual(savedIndex.raw);
      expect(await text(git, ["write-tree"])).toBe(savedIndex.tree);
      expect(await text(git, ["status", "--short"], { env: { GIT_OPTIONAL_LOCKS: "0" } })).toBe(
        "MM tracked.txt",
      );
      expect(
        await text(git, ["diff", "--cached", "--", "tracked.txt"], {
          env: { GIT_OPTIONAL_LOCKS: "0" },
        }),
      ).toContain("-base\n+turn");
      expect(
        await text(git, ["diff", "--", "tracked.txt"], { env: { GIT_OPTIONAL_LOCKS: "0" } }),
      ).toContain("-turn\n+base");
      const indexBeforeRedo = await readFile(savedIndexPath);

      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("turn\n");
      expect(await readFile(savedIndexPath)).toEqual(indexBeforeRedo);
      expect(await text(git, ["write-tree"])).toBe(savedIndex.tree);
      expect(await text(git, ["status", "--short"], { env: { GIT_OPTIONAL_LOCKS: "0" } })).toBe(
        "M  tracked.txt",
      );
      expect(
        await text(git, ["diff", "--cached", "--", "tracked.txt"], {
          env: { GIT_OPTIONAL_LOCKS: "0" },
        }),
      ).toContain("-base\n+turn");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("navigates a completed turn with no file changes", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const beforeHead = await text(git, ["rev-parse", "HEAD"]);
      const beforeRefs = await branchRefs(git);
      const beforeIndex = await indexState(git, cwd);
      const beforeContents = await readFile(join(cwd, "tracked.txt"), "utf8");

      const pending = pendingCheckpoint(await prepareBeforeTurn(git, "empty-turn"));
      expect(pending).not.toBeNull();
      if (!pending) return;
      const checkpoint = completedCheckpoint(await finishAfterTurn(git, pending, "u1", "a1"));
      expect(checkpoint).not.toBeNull();
      if (!checkpoint) return;
      expect(await text(git, ["rev-parse", `${checkpoint.beforeHash}^{tree}`])).toBe(
        await text(git, ["rev-parse", `${checkpoint.afterHash}^{tree}`]),
      );

      const navigated: string[] = [];
      const navigationPort: NavigationPort = {
        getLeafId: () => "a1",
        getBranch: () => [],
        getEntry: () => undefined,
        navigateTree: async (targetId) => {
          navigated.push(targetId);
          return { cancelled: false };
        },
      };
      const navigation = new SessionNavigation(navigationPort, git);
      await navigation.recordTurnEnd(checkpoint);

      expect((await navigation.undo()).status).toBe("moved");
      expect(navigated).toEqual(["u1"]);
      expect((await navigation.redo()).status).toBe("moved");
      expect(navigated).toEqual(["u1", "a1"]);

      expect(await text(git, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(await branchRefs(git)).toBe(beforeRefs);
      expect(await indexState(git, cwd)).toEqual(beforeIndex);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe(beforeContents);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("navigates a turn that changes only ignored files", async () => {
    const { cwd, git } = await makeRepo();
    const ignoredPath = join(cwd, "ignored.txt");
    try {
      await initializeBranch(git, cwd);
      await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
      await git(["add", ".gitignore"]);
      await git(["commit", "-qm", "ignore fixture"]);
      const beforeHead = await text(git, ["rev-parse", "HEAD"]);
      const beforeRefs = await branchRefs(git);
      const beforeIndex = await indexState(git, cwd);
      const beforeContents = await readFile(join(cwd, "tracked.txt"), "utf8");

      const pending = pendingCheckpoint(await prepareBeforeTurn(git, "ignored-turn"));
      expect(pending).not.toBeNull();
      if (!pending) return;
      await writeFile(ignoredPath, "ignored after turn\n");
      const checkpoint = completedCheckpoint(await finishAfterTurn(git, pending, "u1", "a1"));
      expect(checkpoint).not.toBeNull();
      if (!checkpoint) return;
      expect(await text(git, ["rev-parse", `${checkpoint.beforeHash}^{tree}`])).toBe(
        await text(git, ["rev-parse", `${checkpoint.afterHash}^{tree}`]),
      );

      const navigated: string[] = [];
      const navigationPort: NavigationPort = {
        getLeafId: () => "a1",
        getBranch: () => [],
        getEntry: () => undefined,
        navigateTree: async (targetId) => {
          navigated.push(targetId);
          return { cancelled: false };
        },
      };
      const navigation = new SessionNavigation(navigationPort, git);
      await navigation.recordTurnEnd(checkpoint);

      expect((await navigation.undo()).status).toBe("moved");
      expect(navigated).toEqual(["u1"]);
      expect((await navigation.redo()).status).toBe("moved");
      expect(navigated).toEqual(["u1", "a1"]);

      expect(await text(git, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(await branchRefs(git)).toBe(beforeRefs);
      expect(await indexState(git, cwd)).toEqual(beforeIndex);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe(beforeContents);
      expect(await readFile(ignoredPath, "utf8")).toBe("ignored after turn\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reuses and normalizes the alternate index without changing fresh snapshot semantics", async () => {
    const { cwd, git: baseGit } = await makeRepo();
    try {
      await initializeBranch(baseGit, cwd);
      await writeFile(join(cwd, "headonly.txt"), "tracked before deletion\n");
      await baseGit(["add", "headonly.txt"]);
      await baseGit(["commit", "-qm", "tracked deletion fixture"]);
      await rm(join(cwd, "headonly.txt"));
      await writeFile(join(cwd, "candidate.txt"), "untracked before turn\n");

      const commands: string[][] = [];
      const git = Object.assign(
        async (args: string[], options?: Parameters<GitRunner>[1]) => {
          commands.push(args);
          return baseGit(args, options);
        },
        { cwd },
      ) satisfies GitRunner;
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "normalized-index"));
      const leaseDirectory = before.snapshotIndexLease?.directory;
      expect(leaseDirectory).toBeDefined();
      if (!leaseDirectory) return;
      await expect(stat(leaseDirectory)).resolves.toBeDefined();

      await writeFile(join(cwd, ".gitignore"), "candidate.txt\nheadonly.txt\n");
      await writeFile(join(cwd, "headonly.txt"), "tracked after recreation\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));

      expect(commands.some((args) => args[0] === "diff-index")).toBe(true);
      // With cross-turn index reuse the lease is retained after the after-snapshot
      // (not deleted) so the next turn can reuse it for a cheap before snapshot.
      await expect(stat(leaseDirectory)).resolves.toBeDefined();
      const fresh = pendingCheckpoint(await prepareBeforeTurn(baseGit, "fresh-ground-truth"));
      expect(await text(baseGit, ["rev-parse", `${after.afterHash}^{tree}`])).toBe(
        await text(baseGit, ["rev-parse", `${fresh.beforeHash}^{tree}`]),
      );
      expect(await text(baseGit, ["ls-tree", "-r", "--name-only", after.afterHash])).toContain(
        "headonly.txt",
      );
      expect(await text(baseGit, ["ls-tree", "-r", "--name-only", after.afterHash])).not.toContain(
        "candidate.txt",
      );

      const freshLeaseDirectory = fresh.snapshotIndexLease?.directory;
      await releasePendingCheckpoint(baseGit, fresh);
      if (freshLeaseDirectory) await expect(stat(freshLeaseDirectory)).rejects.toThrow();
      await releaseCheckpoint(baseGit, after);
      // Clean up the persisted lease from this test's session.
      await releaseAllPersistentSnapshotIndices();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("skips index reset when retained membership already matches HEAD", async () => {
    const { cwd, git: baseGit } = await makeRepo();
    try {
      await initializeBranch(baseGit, cwd);
      const commands: string[][] = [];
      const git = Object.assign(
        async (args: string[], options?: Parameters<GitRunner>[1]) => {
          commands.push(args);
          return baseGit(args, options);
        },
        { cwd },
      ) satisfies GitRunner;

      const before = pendingCheckpoint(await prepareBeforeTurn(git, "empty-normalization"));
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));

      expect(commands.some((args) => args[0] === "diff-index")).toBe(true);
      expect(commands.some((args) => args.includes("reset"))).toBe(false);
      await releaseCheckpoint(baseGit, after);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("reuses the persisted alternate index across consecutive turns to avoid a full re-hash", async () => {
    const { cwd, git: baseGit } = await makeRepo();
    const sessionId = "cross-turn-reuse";
    try {
      await initializeBranch(baseGit, cwd);
      await writeFile(join(cwd, "tracked.txt"), "initial\n");
      await baseGit(["add", "tracked.txt"]);
      await baseGit(["commit", "-qm", "initial"]);

      // First turn: seeds the persistent index (full add -A) and retains it.
      const before1 = pendingCheckpoint(await prepareBeforeTurn(baseGit, sessionId));
      const after1 = completedCheckpoint(await finishAfterTurn(baseGit, before1, null, null));
      const leaseDirectory1 = before1.snapshotIndexLease?.directory;
      expect(leaseDirectory1).toBeDefined();
      if (!leaseDirectory1) return;
      await expect(stat(leaseDirectory1)).resolves.toBeDefined();

      // Second turn, same session, no file changes: the before snapshot must
      // reuse the same index (no fresh read-tree seeding) and reflect the
      // unchanged worktree, so its tree equals the previous after tree.
      const before2 = pendingCheckpoint(await prepareBeforeTurn(baseGit, sessionId));
      expect(before2.snapshotIndexLease?.directory).toBe(leaseDirectory1);
      // Commit hashes embed the message + timestamp, so compare the captured
      // trees: with an unchanged worktree the reused index must reproduce the
      // previous turn's after-tree exactly.
      const tree = (hash: string) => text(baseGit, ["rev-parse", `${hash}^{tree}`]);
      expect(await tree(before2.beforeHash)).toBe(await tree(after1.afterHash));
      const after2 = completedCheckpoint(await finishAfterTurn(baseGit, before2, null, null));
      expect(await tree(after2.afterHash)).toBe(await tree(after1.afterHash));

      // A change made between turns is still captured on the next before pass.
      await writeFile(join(cwd, "tracked.txt"), "mutated between turns\n");
      const before3 = pendingCheckpoint(await prepareBeforeTurn(baseGit, sessionId));
      expect(before3.snapshotIndexLease?.directory).toBe(leaseDirectory1);
      const after3 = completedCheckpoint(await finishAfterTurn(baseGit, before3, null, null));
      expect(await text(baseGit, ["show", `${after3.afterHash}:tracked.txt`])).toBe(
        "mutated between turns",
      );

      await releaseCheckpoint(baseGit, after1);
      await releaseCheckpoint(baseGit, after2);
      await releaseCheckpoint(baseGit, after3);
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await releaseAllPersistentSnapshotIndices();
    }
  });

  it.skipIf(process.platform === "win32")(
    "matches fresh snapshots across regular-file and symlink transitions",
    async () => {
      const { cwd, git } = await makeRepo();
      try {
        await initializeBranch(git, cwd);
        await writeFile(join(cwd, "target.txt"), "target\n");
        await writeFile(join(cwd, "node"), "regular\n");
        await git(["add", "."]);
        await git(["commit", "-qm", "type transition fixture"]);

        const regularBefore = pendingCheckpoint(await prepareBeforeTurn(git, "regular-before"));
        await rm(join(cwd, "node"));
        await symlink("target.txt", join(cwd, "node"));
        const symlinkAfter = completedCheckpoint(
          await finishAfterTurn(git, regularBefore, null, null),
        );
        const symlinkFresh = pendingCheckpoint(
          await prepareBeforeTurn(git, "symlink-fresh-ground-truth"),
        );
        expect(await text(git, ["rev-parse", `${symlinkAfter.afterHash}^{tree}`])).toBe(
          await text(git, ["rev-parse", `${symlinkFresh.beforeHash}^{tree}`]),
        );

        await rm(join(cwd, "node"));
        await writeFile(join(cwd, "node"), "regular again\n");
        const regularAfter = completedCheckpoint(
          await finishAfterTurn(git, symlinkFresh, null, null),
        );
        const regularFresh = pendingCheckpoint(
          await prepareBeforeTurn(git, "regular-fresh-ground-truth"),
        );
        expect(await text(git, ["rev-parse", `${regularAfter.afterHash}^{tree}`])).toBe(
          await text(git, ["rev-parse", `${regularFresh.beforeHash}^{tree}`]),
        );

        await releasePendingCheckpoint(git, regularFresh);
        await releaseCheckpoint(git, symlinkAfter);
        await releaseCheckpoint(git, regularAfter);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves literal and non-UTF-8 paths while normalizing the retained index",
    async () => {
      const { cwd, git } = await makeRepo();
      try {
        await initializeBranch(git, cwd);
        await writeFile(join(cwd, ":(top)-literal\tline\n.txt"), "literal path\n");
        const nonUtf8Path = Buffer.concat([
          Buffer.from(cwd),
          Buffer.from(sep),
          Buffer.from([0x6e, 0x6f, 0x6e, 0x2d, 0x75, 0x74, 0x66, 0x38, 0x2d, 0x80]),
        ]);
        await writeFile(nonUtf8Path, "raw path\n");

        const before = pendingCheckpoint(await prepareBeforeTurn(git, "raw-paths"));
        const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
        const fresh = pendingCheckpoint(await prepareBeforeTurn(git, "raw-paths-fresh"));

        expect(await text(git, ["rev-parse", `${after.afterHash}^{tree}`])).toBe(
          await text(git, ["rev-parse", `${fresh.beforeHash}^{tree}`]),
        );
        await releasePendingCheckpoint(git, fresh);
        await releaseCheckpoint(git, after);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it("preserves pre-existing changes outside a subdirectory session across undo and redo", async () => {
    const { cwd, git } = await makeRepo();
    const nested = join(cwd, "nested");
    const nestedGit = gitRunner(nested);
    try {
      await initializeBranch(git, cwd);
      await mkdir(nested);
      await writeFile(join(cwd, "outside-modified.txt"), "outside base\n");
      await writeFile(join(cwd, "outside-deleted.txt"), "outside deleted\n");
      await writeFile(join(nested, "inside.txt"), "inside base\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "nested checkpoint fixtures"]);

      await writeFile(join(cwd, "outside-modified.txt"), "outside modified before\n");
      await rm(join(cwd, "outside-deleted.txt"));
      await writeFile(join(cwd, "outside-untracked.txt"), "outside untracked before\n");

      const beforeStatus = await text(git, ["status", "--porcelain=v2"]);
      expect(beforeStatus).toContain("outside-modified.txt");
      expect(beforeStatus).toContain("outside-deleted.txt");
      expect(beforeStatus).toContain("outside-untracked.txt");
      const beforeIndex = await indexState(git, cwd);
      const head = await text(git, ["rev-parse", "HEAD"]);
      const refs = await branchRefs(git);

      const before = pendingCheckpoint(await prepareBeforeTurn(nestedGit, "subdirectory-scope"));
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(nested, "inside.txt"), "inside after turn\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;

      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      expect(await readFile(join(nested, "inside.txt"), "utf8")).toBe("inside base\n");
      expect(await readFile(join(cwd, "outside-modified.txt"), "utf8")).toBe(
        "outside modified before\n",
      );
      await expect(readFile(join(cwd, "outside-deleted.txt"))).rejects.toThrow();
      expect(await readFile(join(cwd, "outside-untracked.txt"), "utf8")).toBe(
        "outside untracked before\n",
      );
      expect(await text(git, ["rev-parse", "HEAD"])).toBe(head);
      expect(await branchRefs(git)).toBe(refs);
      expect(await readFile(await indexPath(git, cwd))).toEqual(beforeIndex.raw);

      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await readFile(join(nested, "inside.txt"), "utf8")).toBe("inside after turn\n");
      expect(await readFile(join(cwd, "outside-modified.txt"), "utf8")).toBe(
        "outside modified before\n",
      );
      await expect(readFile(join(cwd, "outside-deleted.txt"))).rejects.toThrow();
      expect(await readFile(join(cwd, "outside-untracked.txt"), "utf8")).toBe(
        "outside untracked before\n",
      );
      expect(await text(git, ["rev-parse", "HEAD"])).toBe(head);
      expect(await branchRefs(git)).toBe(refs);
      expect(await readFile(await indexPath(git, cwd))).toEqual(beforeIndex.raw);
      expect(await text(git, ["status", "--porcelain=v2"])).toContain("nested/inside.txt");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates the same snapshot tree regardless of runner cwd", async () => {
    const { cwd, git } = await makeRepo();
    const nested = join(cwd, "nested");
    const nestedGit = gitRunner(nested);
    try {
      await initializeBranch(git, cwd);
      await mkdir(nested);
      await writeFile(join(cwd, "root.txt"), "root\n");
      await writeFile(join(nested, "inside.txt"), "inside\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "tree equivalence fixtures"]);

      const rootCheckpoint = pendingCheckpoint(await prepareBeforeTurn(git, "root-tree"));
      expect(rootCheckpoint).not.toBeNull();
      if (!rootCheckpoint) return;
      const nestedCheckpoint = pendingCheckpoint(await prepareBeforeTurn(nestedGit, "nested-tree"));

      expect(await text(git, ["rev-parse", `${rootCheckpoint.beforeHash}^{tree}`])).toBe(
        await text(git, ["rev-parse", `${nestedCheckpoint.beforeHash}^{tree}`]),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps symbolic HEAD and both branch tips unchanged across a branch switch", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "branch-switch"));
      expect(before).not.toBeNull();
      if (!before) return;
      await git(["switch", "-c", "B"]);
      const branchATip = await text(git, ["rev-parse", "A"]);
      const branchBTip = await text(git, ["rev-parse", "B"]);
      const refsAfterSwitch = await branchRefs(git);
      await writeFile(join(cwd, "tracked.txt"), "branch B after\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;

      expect(await text(git, ["symbolic-ref", "--short", "HEAD"])).toBe("B");
      expect(await text(git, ["rev-parse", "A"])).toBe(branchATip);
      expect(await text(git, ["rev-parse", "B"])).toBe(branchBTip);
      expect(await branchRefs(git)).toBe(refsAfterSwitch);
      expect(refsAfterSwitch).not.toContain(after.beforeHash);

      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      await git(["switch", "A"]);
      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await text(git, ["symbolic-ref", "--short", "HEAD"])).toBe("A");
      expect(await branchRefs(git)).toBe(refsAfterSwitch);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to a fresh index when the HEAD tree changes during the turn", async () => {
    const { cwd, git: baseGit } = await makeRepo();
    try {
      await initializeBranch(baseGit, cwd);
      const before = pendingCheckpoint(await prepareBeforeTurn(baseGit, "head-tree-change"));
      await writeFile(join(cwd, "committed.txt"), "committed during turn\n");
      await baseGit(["add", "committed.txt"]);
      await baseGit(["commit", "-qm", "move HEAD tree"]);
      await writeFile(join(cwd, "tracked.txt"), "uncommitted after HEAD move\n");

      const commands: string[][] = [];
      const git = Object.assign(
        async (args: string[], options?: Parameters<GitRunner>[1]) => {
          commands.push(args);
          return baseGit(args, options);
        },
        { cwd },
      ) satisfies GitRunner;
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));

      expect(commands.some((args) => args[0] === "diff-index")).toBe(false);
      expect(commands.some((args) => args[0] === "read-tree")).toBe(true);
      const fresh = pendingCheckpoint(await prepareBeforeTurn(baseGit, "head-change-fresh"));
      expect(await text(baseGit, ["rev-parse", `${after.afterHash}^{tree}`])).toBe(
        await text(baseGit, ["rev-parse", `${fresh.beforeHash}^{tree}`]),
      );
      await releasePendingCheckpoint(baseGit, fresh);
      await releaseCheckpoint(baseGit, after);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("does not mutate a mixed real index during capture, restoration, or cleanup", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      await writeFile(join(cwd, "staged.txt"), "base\n");
      await writeFile(join(cwd, "unstaged.txt"), "base\n");
      await writeFile(join(cwd, "mixed.txt"), "base\n");
      await writeFile(join(cwd, "deleted.txt"), "base\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "index fixtures"]);
      await writeFile(join(cwd, "staged.txt"), "staged\n");
      await git(["add", "staged.txt"]);
      await writeFile(join(cwd, "unstaged.txt"), "unstaged\n");
      await writeFile(join(cwd, "mixed.txt"), "staged mixed\n");
      await git(["add", "mixed.txt"]);
      await writeFile(join(cwd, "mixed.txt"), "unstaged mixed\n");
      await git(["rm", "-q", "deleted.txt"]);
      await writeFile(join(cwd, "intent-to-add.txt"), "ita\n");
      await git(["add", "-N", "intent-to-add.txt"]);
      await writeFile(join(cwd, "untracked.txt"), "untracked\n");

      const saved = await indexState(git, cwd);
      const beforeStatus = await text(git, ["status", "--porcelain=v2"]);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "index-preservation"));
      expect(before).not.toBeNull();
      if (!before) return;
      expect(await indexState(git, cwd)).toEqual(saved);
      expect(await text(git, ["status", "--porcelain=v2"])).toBe(beforeStatus);

      await writeFile(join(cwd, "staged.txt"), "after turn\n");
      await writeFile(join(cwd, "after-only.txt"), "after only\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;
      expect(await indexState(git, cwd)).toEqual(saved);
      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      expect(await indexState(git, cwd)).toEqual(saved);
      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await indexState(git, cwd)).toEqual(saved);
      expect(await releaseCheckpoint(git, after)).toBe(true);
      expect(await indexState(git, cwd)).toEqual(saved);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("changes only private refs through the complete checkpoint lifecycle", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const refs = await branchRefs(git);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "ref-invariant"));
      expect(before).not.toBeNull();
      if (!before) return;
      expect(await branchRefs(git)).toBe(refs);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;
      expect(await branchRefs(git)).toBe(refs);
      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      expect(await branchRefs(git)).toBe(refs);
      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await branchRefs(git)).toBe(refs);
      expect(await releaseCheckpoint(git, after)).toBe(true);
      expect(await branchRefs(git)).toBe(refs);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("restores additions, deletions, rename-as-delete/add, binary data, and Unicode names", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      await writeFile(join(cwd, "old name.txt"), "old\n");
      await writeFile(join(cwd, "delete me.txt"), "delete\n");
      await writeFile(join(cwd, "binary.bin"), Buffer.from([0, 1, 2, 3]));
      await writeFile(join(cwd, "executable.sh"), "#!/bin/sh\n");
      let symlinkSupported = false;
      try {
        await symlink("old name.txt", join(cwd, "link to old.txt"));
        symlinkSupported = true;
      } catch {
        // Windows may deny symlink creation without developer mode.
      }
      await git(["add", "."]);
      await git(["update-index", "--chmod=+x", "executable.sh"]);
      await git(["commit", "-qm", "matrix fixtures"]);
      const symlinkMode = (await text(git, ["ls-files", "-s", "link to old.txt"])).startsWith(
        "120000 ",
      );
      const symlinkConfig = await git(["config", "--get", "core.symlinks"]);
      symlinkSupported =
        symlinkMode && symlinkConfig.code === 0 && symlinkConfig.stdout.trim() === "true";
      await writeFile(join(cwd, "before-only.txt"), "before only\n");
      const executableBefore = (await stat(join(cwd, "executable.sh"))).mode & 0o111;
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "restoration-matrix"));
      expect(before).not.toBeNull();
      if (!before) return;
      await rm(join(cwd, "old name.txt"));
      await rm(join(cwd, "delete me.txt"));
      await writeFile(join(cwd, "new name.txt"), "renamed\n");
      await writeFile(join(cwd, "binary.bin"), Buffer.from([255, 254, 253, 252]));
      await chmod(join(cwd, "executable.sh"), 0o644);
      if (symlinkSupported) {
        await rm(join(cwd, "link to old.txt"));
        await writeFile(join(cwd, "link to old.txt"), "regular file\n");
      }
      await writeFile(join(cwd, "after-only Ω.txt"), "after only\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;

      expect(await applyCheckpoint(git, after.afterHash, after.beforeHash)).toBe("applied");
      expect(await readFile(join(cwd, "old name.txt"), "utf8")).toBe("old\n");
      expect(await readFile(join(cwd, "delete me.txt"), "utf8")).toBe("delete\n");
      await expect(readFile(join(cwd, "new name.txt"))).rejects.toThrow();
      expect(await readFile(join(cwd, "binary.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
      expect(await readFile(join(cwd, "before-only.txt"), "utf8")).toBe("before only\n");
      await expect(readFile(join(cwd, "after-only Ω.txt"))).rejects.toThrow();
      if (executableBefore) {
        expect((await stat(join(cwd, "executable.sh"))).mode & 0o111).toBe(executableBefore);
      }
      if (symlinkSupported) {
        expect((await lstat(join(cwd, "link to old.txt"))).isSymbolicLink()).toBe(true);
        expect(await readlink(join(cwd, "link to old.txt"))).toBe("old name.txt");
      }

      expect(await applyCheckpoint(git, after.beforeHash, after.afterHash)).toBe("applied");
      expect(await readFile(join(cwd, "new name.txt"), "utf8")).toBe("renamed\n");
      expect(await readFile(join(cwd, "binary.bin"))).toEqual(Buffer.from([255, 254, 253, 252]));
      await expect(readFile(join(cwd, "old name.txt"))).rejects.toThrow();
      await expect(readFile(join(cwd, "delete me.txt"))).rejects.toThrow();
      expect(await readFile(join(cwd, "after-only Ω.txt"), "utf8")).toBe("after only\n");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("fails safely on a conflicting reverse patch and leaves navigation unchanged", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "conflict"));
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      const after = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(after).not.toBeNull();
      if (!after) return;
      const checkpoint = checkpointWithRepository(
        after.beforeHash,
        after.afterHash,
        after.repository,
      );
      await writeFile(join(cwd, "tracked.txt"), "manual conflict\n");
      const savedContent = await readFile(join(cwd, "tracked.txt"));
      const savedIndex = await indexState(git, cwd);
      const savedRefs = await branchRefs(git);
      const navigationPort: NavigationPort = {
        getLeafId: () => "leaf",
        getBranch: () => [],
        getEntry: () => undefined,
        navigateTree: async () => ({ cancelled: false }),
      };
      const navigation = new SessionNavigation(navigationPort, git);
      await navigation.recordTurnEnd(checkpoint);

      expect(await navigation.undo()).toEqual({ status: "git_failed", failure: "conflict" });
      expect(await readFile(join(cwd, "tracked.txt"))).toEqual(savedContent);
      expect(await indexState(git, cwd)).toEqual(savedIndex);
      expect(await branchRefs(git)).toBe(savedRefs);
      expect((await navigation.undo()).status).toBe("git_failed");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps active checkpoints reachable after reflog expiry and aggressive GC", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      await writeFile(join(cwd, "tracked.txt"), "before\n");
      await writeFile(join(cwd, "deleted.txt"), "remove\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "setup"]);
      await git(["reset", "--mixed", "HEAD^"]);
      await writeFile(join(cwd, "untracked.txt"), "before-only\n");

      const before = pendingCheckpoint(await prepareBeforeTurn(git, "gc"));
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      await writeFile(join(cwd, "untracked.txt"), "after-only\n");
      const checkpoint = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(checkpoint).not.toBeNull();
      if (!checkpoint) return;
      await git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
      await git(["gc", "--prune=now"]);
      expect((await git(["cat-file", "-e", `${checkpoint.beforeHash}^{commit}`])).code).toBe(0);
      expect((await git(["cat-file", "-e", `${checkpoint.afterHash}^{commit}`])).code).toBe(0);
      expect(await releaseCheckpoint(git, checkpoint)).toBe(true);
      await git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
      await git(["gc", "--prune=now"]);
      expect((await git(["cat-file", "-e", `${checkpoint.beforeHash}^{commit}`])).code).not.toBe(0);
      expect((await git(["cat-file", "-e", `${checkpoint.afterHash}^{commit}`])).code).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("isolates a changed private ref without blocking valid cleanup", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const before = pendingCheckpoint(await prepareBeforeTurn(git, "batch"));
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      const checkpoint = completedCheckpoint(await finishAfterTurn(git, before, null, null));
      expect(checkpoint).not.toBeNull();
      if (!checkpoint) return;
      await git(["update-ref", "refs/keep", "HEAD"]);
      await git(["update-ref", checkpoint.afterRef, checkpoint.beforeHash]);

      const released = await releaseRefs(
        () => git,
        [
          {
            repository: checkpoint.repository,
            ref: checkpoint.beforeRef,
            expectedHash: checkpoint.beforeHash,
          },
          {
            repository: checkpoint.repository,
            ref: checkpoint.afterRef,
            expectedHash: checkpoint.afterHash,
          },
        ],
      );

      expect(released).toBe(false);
      expect((await git(["show-ref", "--verify", checkpoint.beforeRef])).code).not.toBe(0);
      expect((await git(["rev-parse", checkpoint.afterRef])).stdout.trim()).toBe(
        checkpoint.beforeHash,
      );
      expect((await git(["rev-parse", "refs/keep"])).stdout.trim()).toBe(
        (await git(["rev-parse", "HEAD"])).stdout.trim(),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("supports full checkpoints in an unborn repository", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await writeFile(join(cwd, "before.txt"), "before\n");
      const prepared = await prepareBeforeTurn(git, "unborn");
      expect(prepared.status).toBe("git");
      if (prepared.status !== "git") return;
      expect(prepared.checkpoint.snapshotIndexLease).toBeUndefined();

      await rm(join(cwd, "before.txt"));
      await writeFile(join(cwd, "after.txt"), "after\n");
      const finished = await finishAfterTurn(git, prepared.checkpoint, "u1", "a1");
      expect(finished.status).toBe("git");
      if (finished.status !== "git") return;

      expect(
        await applyCheckpoint(git, finished.checkpoint.afterHash, finished.checkpoint.beforeHash),
      ).toBe("applied");
      await expect(readFile(join(cwd, "before.txt"), "utf8")).resolves.toBe("before\n");
      await expect(readFile(join(cwd, "after.txt"))).rejects.toThrow();

      expect(
        await applyCheckpoint(git, finished.checkpoint.beforeHash, finished.checkpoint.afterHash),
      ).toBe("applied");
      await expect(readFile(join(cwd, "after.txt"), "utf8")).resolves.toBe("after\n");
      expect((await git(["rev-parse", "HEAD"])).code).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("creates valid empty snapshots in an unborn repository", async () => {
    const { cwd, git } = await makeRepo();
    try {
      const prepared = await prepareBeforeTurn(git, "empty-unborn");
      expect(prepared.status).toBe("git");
      if (prepared.status !== "git") return;
      const finished = await finishAfterTurn(git, prepared.checkpoint, null, null);
      expect(finished.status).toBe("git");
      if (finished.status !== "git") return;
      expect(await text(git, ["rev-parse", `${finished.checkpoint.beforeHash}^{tree}`])).toMatch(
        /^[0-9a-f]{40}$/,
      );
      expect(await text(git, ["rev-parse", `${finished.checkpoint.afterHash}^{tree}`])).toMatch(
        /^[0-9a-f]{40}$/,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns a stable reason when the cwd is not a repository", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-non-repo-"));
    try {
      const result = await prepareBeforeTurn(gitRunner(cwd), "non-repo");
      expect(result).toEqual({ status: "session_only", reason: "not_repository" });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies a malformed HEAD instead of treating it as unborn", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      await writeFile(join(cwd, ".git", "HEAD"), "not-a-head\n");
      expect(await prepareBeforeTurn(git, "invalid-head")).toEqual({
        status: "session_only",
        reason: "invalid_head",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("handles HistoryLoadResult, tombstone detection, and schema v1 to v2 upgrade in SessionHistoryStore", async () => {
    const { cwd, git } = await makeRepo();
    const repository = {
      worktree: cwd,
      gitDir: join(cwd, ".git"),
      commonDir: join(cwd, ".git"),
    };
    const sessionId = "chk-schema-session";
    const prompt: SessionEntryLike = {
      id: "p1",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const response: SessionEntryLike = {
      id: "r1",
      parentId: "p1",
      type: "message",
      message: { role: "assistant" },
    };

    try {
      await initializeBranch(git, cwd);
      const { SessionHistoryStore, historyPath, tombstonePath } =
        await import("../src/core/history-store.js");
      const store = new SessionHistoryStore(sessionId, repository, git);
      const r = reader([prompt, response], "r1");

      // 1. Load empty -> returns status: "unavailable"
      await expect(store.load(r)).resolves.toEqual({ status: "unavailable" });

      // 2. Write schema v1 file without lastAccessedAt
      const hPath = historyPath(repository, sessionId);
      await mkdir(join(repository.commonDir, "omp-undo-redo", "history"), { recursive: true });
      await writeFile(
        hPath,
        JSON.stringify({
          schemaVersion: 1,
          sessionHash: checkpointNamespace(sessionId),
          repository,
          checkpoints: [
            {
              kind: "session",
              reason: "resumed_checkpoint_unavailable",
              parentLeafId: "p1",
              leafId: "r1",
            },
          ],
          currentIndex: 0,
        }),
      );

      // 3. Load accepts schema v1, returns status: "loaded", and re-saves as v2 with lastAccessedAt
      const loaded = await store.load(r);
      expect(loaded).toMatchObject({
        status: "loaded",
        state: {
          currentIndex: 0,
          checkpoints: [
            {
              kind: "session",
              reason: "resumed_checkpoint_unavailable",
              parentLeafId: "p1",
              leafId: "r1",
            },
          ],
        },
      });

      // Verify JSON was upgraded to schemaVersion 2 with lastAccessedAt
      const upgradedContent = JSON.parse(await readFile(hPath, "utf8"));
      expect(upgradedContent.schemaVersion).toBe(2);
      expect(typeof upgradedContent.lastAccessedAt).toBe("string");

      // 4. Tombstone detection -> load() returns status: "expired"
      await writeFile(
        tombstonePath(repository, sessionId),
        JSON.stringify({
          expired: true,
          sessionHash: checkpointNamespace(sessionId),
          expiredAt: new Date().toISOString(),
          reason: "age",
        }),
      );

      await expect(store.load(r)).resolves.toEqual({
        status: "expired",
        reason: "age",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("loads multi-turn Git session history when active leaf is at undone prompt boundary", async () => {
    const { cwd, git } = await makeRepo();
    const repository = {
      worktree: cwd,
      gitDir: join(cwd, ".git"),
      commonDir: join(cwd, ".git"),
    };
    const sessionId = "chk-multi-undo-session";
    const sessionHash = checkpointNamespace(sessionId);

    const p1: SessionEntryLike = {
      id: "p1",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const r1: SessionEntryLike = {
      id: "r1",
      parentId: "p1",
      type: "message",
      message: { role: "assistant" },
    };
    const p2: SessionEntryLike = {
      id: "p2",
      parentId: "r1",
      type: "message",
      message: { role: "user" },
    };
    const r2: SessionEntryLike = {
      id: "r2",
      parentId: "p2",
      type: "message",
      message: { role: "assistant" },
    };

    try {
      await initializeBranch(git, cwd);
      const { SessionHistoryStore } = await import("../src/core/history-store.js");
      const store = new SessionHistoryStore(sessionId, repository, git);

      // Create valid refs for two checkpoints
      const head = (await git(["rev-parse", "HEAD"])).stdout.trim();
      const refPrefix = `refs/omp-undo-redo/history/${sessionHash}/`;
      await git(["update-ref", `${refPrefix}c1/before`, head]);
      await git(["update-ref", `${refPrefix}c1/after`, head]);
      await git(["update-ref", `${refPrefix}c2/before`, head]);
      await git(["update-ref", `${refPrefix}c2/after`, head]);

      const c1: TurnCheckpoint = {
        kind: "git",
        repository,
        beforeRef: `${refPrefix}c1/before`,
        beforeHash: head,
        afterRef: `${refPrefix}c1/after`,
        afterHash: head,
        parentLeafId: "p1",
        leafId: "r1",
      };
      const c2: TurnCheckpoint = {
        kind: "git",
        repository,
        beforeRef: `${refPrefix}c2/before`,
        beforeHash: head,
        afterRef: `${refPrefix}c2/after`,
        afterHash: head,
        parentLeafId: "p2",
        leafId: "r2",
      };

      // State saved after undoing Turn 2 (currentIndex = 0, sitting at p2)
      await store.save({
        checkpoints: [c1, c2],
        currentIndex: 0,
      });

      // Reader is sitting at p2 (undone prompt)
      const multiReader: SessionReader = {
        getLeafId: () => "p2",
        getBranch: () => [p1, r1, p2],
        getEntry: (id) => [p1, r1, p2, r2].find((e) => e.id === id),
      };

      const loaded = await store.load(multiReader);
      expect(loaded).toEqual({
        status: "loaded",
        state: {
          checkpoints: [c1, c2],
          currentIndex: 0,
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
