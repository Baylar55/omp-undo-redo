import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CheckpointOwnerRegistry,
  classifyCheckpointOwner,
  parseCheckpointOwnerLease,
  parseCheckpointOwnerRef,
  resolvePersistentHostId,
  resolveRuntimeScope,
} from "../src/core/checkpoint-owners.js";
import { createGitRunner } from "../src/core/git-runner.js";
import {
  finishAfterTurn,
  prepareBeforeTurn,
  releasePendingCheckpoint,
} from "../src/core/checkpoints.js";
import { SessionNavigation } from "../src/core/session-navigation.js";
import type { GitRepository, GitRunner, NavigationPort } from "../src/core/types.js";

const ownerA = "11111111-1111-4111-8111-111111111111";
const ownerB = "22222222-2222-4222-8222-222222222222";
const hostA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sessionHash = "a".repeat(64);
const runtimeScope = "c".repeat(64);
const checkpointId = "33333333-3333-4333-8333-333333333333";
const objectHash = "b".repeat(40);

function lease(ownerId: string, hostId = hostA, pid = 1234): string {
  return JSON.stringify({
    schemaVersion: 1,
    ownerId,
    hostId,
    hostname: "test-host",
    runtimeScope,
    pid,
    startedAt: "2026-07-31T00:00:00.000Z",
  });
}

async function makeRepository(): Promise<{
  cwd: string;
  commonDir: string;
  git: GitRunner;
  repository: GitRepository;
}> {
  const cwd = await mkdtemp(join(tmpdir(), "omp-owner-repo-"));
  const git = createGitRunner(cwd);
  expect((await git(["init", "-q"])).code).toBe(0);
  expect((await git(["config", "core.autocrlf", "false"])).code).toBe(0);
  await writeFile(join(cwd, "tracked.txt"), "before\n");
  expect((await git(["add", "tracked.txt"])).code).toBe(0);
  expect(
    (
      await git([
        "-c",
        "user.name=owner-test",
        "-c",
        "user.email=owner-test@local",
        "commit",
        "-qm",
        "base",
      ])
    ).code,
  ).toBe(0);
  const commonDirResult = await git(["rev-parse", "--git-common-dir"]);
  expect(commonDirResult.code).toBe(0);
  const commonDir = resolve(cwd, commonDirResult.stdout.trim());
  return {
    cwd,
    commonDir,
    git,
    repository: { commonDir, gitDir: commonDir, worktree: cwd },
  };
}

describe("checkpoint owner boundaries", () => {
  it("accepts only canonical v2 refs and full object IDs", () => {
    expect(
      parseCheckpointOwnerRef(
        `refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/before`,
      ),
    ).toEqual({ ownerId: ownerA, sessionHash, checkpointId, phase: "before" });
    expect(
      parseCheckpointOwnerRef(`refs/omp-undo-redo/${sessionHash}/${checkpointId}/before`),
    ).toBeNull();
    expect(
      parseCheckpointOwnerRef(
        `refs/omp-undo-redo/v3/${ownerA}/${sessionHash}/${checkpointId}/before`,
      ),
    ).toBeNull();
    expect(
      parseCheckpointOwnerRef(`refs/omp-undo-redo/v2/${ownerA}/../${checkpointId}/before`),
    ).toBeNull();
  });

  it("rejects malformed or mismatched lease metadata", () => {
    expect(parseCheckpointOwnerLease(`${ownerA}.json`, lease(ownerB))).toBeNull();
    expect(
      parseCheckpointOwnerLease(
        `${ownerA}.json`,
        JSON.stringify({ ...JSON.parse(lease(ownerA)), extra: true }),
      ),
    ).toBeNull();
    expect(
      parseCheckpointOwnerLease(
        `${ownerA}.json`,
        JSON.stringify({ ...JSON.parse(lease(ownerA)), pid: 0 }),
      ),
    ).toBeNull();
  });

  it("deletes only a provably stale owner prefix", async () => {
    const commonDir = await mkdtemp(join(tmpdir(), "omp-owner-test-"));
    const repository: GitRepository = { commonDir, gitDir: commonDir, worktree: commonDir };
    const ownersDir = join(commonDir, "omp-undo-redo", "owners");
    await mkdir(ownersDir, { recursive: true });
    await writeFile(join(ownersDir, `${ownerA}.json`), lease(ownerA, hostA, 9999));
    await writeFile(join(ownersDir, `${ownerB}.json`), lease(ownerB, hostA, process.pid));
    const refs = new Set([`refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/before`]);
    const git: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") {
        return {
          stdout: [...refs].map((ref) => `${ref}\0${objectHash}`).join("\n"),
          stderr: "",
          code: 0,
        };
      }
      for (const ref of refs) refs.delete(ref);
      return { stdout: "", stderr: "", code: 0 };
    };
    const registry = new CheckpointOwnerRegistry({
      ownerId: ownerB,
      hostIdentity: { id: hostA, persistent: true },
      hostname: "test-host",
      runtimeScope,
      probePid: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      shutdownWaitMs: 50,
    });
    expect(await registry.ensureInitialized(repository, git)).toBe("v2");
    await registry.shutdown();
    expect(refs.size).toBe(0);
    await expect(readFile(join(ownersDir, `${ownerA}.json`), "utf8")).rejects.toThrow();
    await expect(readFile(join(ownersDir, `${ownerB}.json`), "utf8")).rejects.toThrow();
    expect(await readdir(ownersDir)).not.toContain(`${ownerB}.json`);
  });

  it("preserves a live foreign owner with real Git", async () => {
    const { cwd, commonDir, git, repository } = await makeRepository();
    const ownersDir = join(commonDir, "omp-undo-redo", "owners");
    const liveRef = `refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/before`;
    try {
      await mkdir(ownersDir, { recursive: true });
      await writeFile(join(ownersDir, `${ownerA}.json`), lease(ownerA, hostA, process.pid));
      expect((await git(["update-ref", liveRef, "HEAD"])).code).toBe(0);
      const registry = new CheckpointOwnerRegistry({
        ownerId: ownerB,
        hostIdentity: { id: hostA, persistent: true },
        hostname: "test-host",
        runtimeScope,
        shutdownWaitMs: 1_000,
      });

      expect(await registry.ensureInitialized(repository, git)).toBe("v2");
      await registry.shutdown();

      expect((await git(["show-ref", "--verify", liveRef])).code).toBe(0);
      expect(await readFile(join(ownersDir, `${ownerA}.json`), "utf8")).toContain(ownerA);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("preserves changed refs and their stale-owner lease", async () => {
    const commonDir = await mkdtemp(join(tmpdir(), "omp-owner-mismatch-"));
    const repository: GitRepository = { commonDir, gitDir: commonDir, worktree: commonDir };
    const ownersDir = join(commonDir, "omp-undo-redo", "owners");
    const changedRef = `refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/before`;
    await mkdir(ownersDir, { recursive: true });
    await writeFile(join(ownersDir, `${ownerA}.json`), lease(ownerA, hostA, 9999));
    const git: GitRunner = async (args) =>
      args[0] === "for-each-ref"
        ? { stdout: `${changedRef}\0${objectHash}\n`, stderr: "", code: 0 }
        : { stdout: "", stderr: "compare failed", code: 1 };
    const registry = new CheckpointOwnerRegistry({
      ownerId: ownerB,
      hostIdentity: { id: hostA, persistent: true },
      hostname: "test-host",
      runtimeScope,
      probePid: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      shutdownWaitMs: 1_000,
    });

    expect(await registry.ensureInitialized(repository, git)).toBe("v2");
    await registry.shutdown();

    expect(await readFile(join(ownersDir, `${ownerA}.json`), "utf8")).toContain(ownerA);
    await rm(commonDir, { recursive: true, force: true });
  });

  it("does not split or retry a timed-out stale deletion", async () => {
    const commonDir = await mkdtemp(join(tmpdir(), "omp-owner-timeout-"));
    const repository: GitRepository = { commonDir, gitDir: commonDir, worktree: commonDir };
    const ownersDir = join(commonDir, "omp-undo-redo", "owners");
    const refs = [
      `refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/before`,
      `refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/after`,
    ];
    await mkdir(ownersDir, { recursive: true });
    await writeFile(join(ownersDir, `${ownerA}.json`), lease(ownerA, hostA, 9999));
    let updateCalls = 0;
    const git: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") {
        return {
          stdout: refs.map((ref) => `${ref}\0${objectHash}`).join("\n"),
          stderr: "",
          code: 0,
        };
      }
      updateCalls++;
      return { stdout: "", stderr: "timed out", code: 1, error: "timeout" };
    };
    const registry = new CheckpointOwnerRegistry({
      ownerId: ownerB,
      hostIdentity: { id: hostA, persistent: true },
      hostname: "test-host",
      runtimeScope,
      probePid: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      shutdownWaitMs: 1_000,
    });

    expect(await registry.ensureInitialized(repository, git)).toBe("v2");
    await registry.shutdown();

    expect(updateCalls).toBe(1);
    expect(await readFile(join(ownersDir, `${ownerA}.json`), "utf8")).toContain(ownerA);
    await rm(commonDir, { recursive: true, force: true });
  });

  it("reaps only v2 owner refs and preserves legacy and future versions", async () => {
    const { cwd, commonDir, git, repository } = await makeRepository();
    const ownersDir = join(commonDir, "omp-undo-redo", "owners");
    const staleV2 = `refs/omp-undo-redo/v2/${ownerA}/${sessionHash}/${checkpointId}/before`;
    const legacy = `refs/omp-undo-redo/${sessionHash}/${checkpointId}/before`;
    const future = `refs/omp-undo-redo/v3/${ownerA}/${sessionHash}/${checkpointId}/before`;
    try {
      await mkdir(ownersDir, { recursive: true });
      await writeFile(join(ownersDir, `${ownerA}.json`), lease(ownerA, hostA, 9999));
      for (const ref of [staleV2, legacy, future]) {
        expect((await git(["update-ref", ref, "HEAD"])).code).toBe(0);
      }
      const registry = new CheckpointOwnerRegistry({
        ownerId: ownerB,
        hostIdentity: { id: hostA, persistent: true },
        hostname: "test-host",
        runtimeScope,
        probePid: () => {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        },
        shutdownWaitMs: 1_000,
      });

      expect(await registry.ensureInitialized(repository, git)).toBe("v2");
      await registry.shutdown();

      expect((await git(["show-ref", "--verify", staleV2])).code).not.toBe(0);
      expect((await git(["show-ref", "--verify", legacy])).code).toBe(0);
      expect((await git(["show-ref", "--verify", future])).code).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
  it("falls back to legacy refs when lease publication fails", async () => {
    const { cwd, commonDir, git } = await makeRepository();
    try {
      await writeFile(join(commonDir, "omp-undo-redo"), "block owner directory");
      const registry = new CheckpointOwnerRegistry({
        ownerId: ownerB,
        hostIdentity: { id: hostA, persistent: true },
        hostname: "test-host",
        runtimeScope,
      });

      const prepared = await prepareBeforeTurn(git, "legacy-fallback", registry);
      expect(prepared.status).toBe("git");
      if (prepared.status !== "git") return;
      expect(prepared.checkpoint.beforeRef).not.toContain("/v2/");
      expect(await releasePendingCheckpoint(git, prepared.checkpoint)).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("keeps a live owner's checkpoints usable for undo and redo during another scan", async () => {
    const { cwd, git, repository } = await makeRepository();
    const ownerRegistry = new CheckpointOwnerRegistry({
      ownerId: ownerA,
      hostIdentity: { id: hostA, persistent: true },
      hostname: "test-host",
      runtimeScope,
    });
    try {
      const prepared = await prepareBeforeTurn(git, "live-navigation", ownerRegistry);
      expect(prepared.status).toBe("git");
      if (prepared.status !== "git") return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      const finished = await finishAfterTurn(git, prepared.checkpoint, "parent", "leaf");
      expect(finished.status).toBe("git");
      if (finished.status !== "git") return;

      const scanner = new CheckpointOwnerRegistry({
        ownerId: ownerB,
        hostIdentity: { id: hostA, persistent: true },
        hostname: "test-host",
        runtimeScope,
        shutdownWaitMs: 1_000,
      });
      expect(await scanner.ensureInitialized(repository, git)).toBe("v2");
      await scanner.shutdown();

      let leaf = "leaf";
      const port: NavigationPort = {
        getLeafId: () => leaf,
        getBranch: () => [],
        getEntry: () => undefined,
        navigateTree: async (targetId) => {
          leaf = targetId;
          return { cancelled: false };
        },
      };
      const navigation = new SessionNavigation(port, git);
      await navigation.recordTurnEnd(finished.checkpoint);

      expect(await navigation.undo()).toEqual({ status: "moved", files: "restored" });
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("before\n");
      expect(await navigation.redo()).toEqual({ status: "moved", files: "restored" });
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("after\n");
      await navigation.dispose();
    } finally {
      await ownerRegistry.shutdown();
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("owner liveness", () => {
  it("preserves current, remote, and uncertain owners", () => {
    const current = parseCheckpointOwnerLease(`${ownerA}.json`, lease(ownerA));
    const remote = parseCheckpointOwnerLease(
      `${ownerB}.json`,
      lease(ownerB, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
    );
    const otherScope = parseCheckpointOwnerLease(
      `${ownerB}.json`,
      JSON.stringify({ ...JSON.parse(lease(ownerB)), runtimeScope: "d".repeat(64) }),
    );
    expect(
      current &&
        classifyCheckpointOwner(current, {
          currentOwnerId: ownerA,
          currentHostId: hostA,
          currentHostname: "test-host",
          currentRuntimeScope: runtimeScope,
        }),
    ).toBe("alive");
    expect(
      remote &&
        classifyCheckpointOwner(remote, {
          currentOwnerId: ownerA,
          currentHostId: hostA,
          currentHostname: "test-host",
          currentRuntimeScope: runtimeScope,
        }),
    ).toBe("remote");
    expect(
      otherScope &&
        classifyCheckpointOwner(otherScope, {
          currentOwnerId: ownerA,
          currentHostId: hostA,
          currentHostname: "test-host",
          currentRuntimeScope: runtimeScope,
          probePid: () => {
            throw new Error("a foreign runtime scope must not be probed");
          },
        }),
    ).toBe("remote");
    expect(
      remote &&
        classifyCheckpointOwner(remote, {
          currentOwnerId: ownerA,
          currentHostId: hostA,
          currentHostname: "test-host",
          currentRuntimeScope: null,
        }),
    ).toBe("unknown");
  });

  it("reuses a persistent host ID and does not overwrite malformed state", async () => {
    const home = await mkdtemp(join(tmpdir(), "omp-host-test-"));
    const first = await resolvePersistentHostId({
      platform: "linux",
      homeDirectory: home,
      randomId: () => hostA,
    });
    const second = await resolvePersistentHostId({
      platform: "linux",
      homeDirectory: home,
      randomId: () => ownerA,
    });
    expect(first).toEqual({ id: hostA, persistent: true });
    expect(second).toEqual(first);
  });

  it("binds Linux cleanup to both boot and PID namespace identity", async () => {
    const first = await resolveRuntimeScope({
      platform: "linux",
      readFile: async () => "11111111-1111-4111-8111-111111111111\n",
      readlink: async () => "pid:[4026531836]",
    });
    const otherNamespace = await resolveRuntimeScope({
      platform: "linux",
      readFile: async () => "11111111-1111-4111-8111-111111111111\n",
      readlink: async () => "pid:[4026532999]",
    });
    const unavailable = await resolveRuntimeScope({
      platform: "linux",
      readFile: async () => {
        throw new Error("unavailable");
      },
      readlink: async () => "pid:[4026531836]",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(otherNamespace).not.toBe(first);
    expect(unavailable).toBeNull();
  });
});
