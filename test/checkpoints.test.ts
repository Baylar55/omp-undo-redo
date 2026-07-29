import { execFile } from "node:child_process";
import {
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
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SessionNavigation } from "../src/core/session-navigation.js";
import {
  applyCheckpoint,
  checkpointNamespace,
  finishAfterTurn,
  prepareBeforeTurn,
  previousCheckpoint,
  releaseCheckpoint,
} from "../src/core/checkpoints.js";
import type {
  GitCheckpoint,
  GitRunner,
  NavigationPort,
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
  return async (args, options) => {
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

async function text(git: GitRunner, args: string[]): Promise<string> {
  const result = await git(args);
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

function checkpointWithRepository(
  beforeHash: string,
  afterHash: string,
  repository: GitCheckpoint["repository"],
): GitCheckpoint {
  return {
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
      const before = await prepareBeforeTurn(git, "intervening-commit");
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
      const after = await finishAfterTurn(git, before, null, null);
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

  it("keeps symbolic HEAD and both branch tips unchanged across a branch switch", async () => {
    const { cwd, git } = await makeRepo();
    try {
      await initializeBranch(git, cwd);
      const before = await prepareBeforeTurn(git, "branch-switch");
      expect(before).not.toBeNull();
      if (!before) return;
      await git(["switch", "-c", "B"]);
      const branchATip = await text(git, ["rev-parse", "A"]);
      const branchBTip = await text(git, ["rev-parse", "B"]);
      const refsAfterSwitch = await branchRefs(git);
      await writeFile(join(cwd, "tracked.txt"), "branch B after\n");
      const after = await finishAfterTurn(git, before, null, null);
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
      const before = await prepareBeforeTurn(git, "index-preservation");
      expect(before).not.toBeNull();
      if (!before) return;
      expect(await indexState(git, cwd)).toEqual(saved);
      expect(await text(git, ["status", "--porcelain=v2"])).toBe(beforeStatus);

      await writeFile(join(cwd, "staged.txt"), "after turn\n");
      await writeFile(join(cwd, "after-only.txt"), "after only\n");
      const after = await finishAfterTurn(git, before, null, null);
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
      const before = await prepareBeforeTurn(git, "ref-invariant");
      expect(before).not.toBeNull();
      if (!before) return;
      expect(await branchRefs(git)).toBe(refs);
      await writeFile(join(cwd, "tracked.txt"), "changed\n");
      const after = await finishAfterTurn(git, before, null, null);
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
      const before = await prepareBeforeTurn(git, "restoration-matrix");
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
      const after = await finishAfterTurn(git, before, null, null);
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
      const before = await prepareBeforeTurn(git, "conflict");
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      const after = await finishAfterTurn(git, before, null, null);
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

      expect(await navigation.undo()).toBe("git_failed");
      expect(navigation.getLastGitFailure()).toBe("conflict");
      expect(await readFile(join(cwd, "tracked.txt"))).toEqual(savedContent);
      expect(await indexState(git, cwd)).toEqual(savedIndex);
      expect(await branchRefs(git)).toBe(savedRefs);
      expect(await navigation.undo()).toBe("git_failed");
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

      const before = await prepareBeforeTurn(git, "gc");
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      await writeFile(join(cwd, "untracked.txt"), "after-only\n");
      const checkpoint = await finishAfterTurn(git, before, null, null);
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
});
