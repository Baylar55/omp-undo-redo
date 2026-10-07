import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expireGitSessionHistories,
  historyPath,
  SessionHistoryStore,
  tombstonePath,
} from "../src/core/history-store.js";
import { createGitRunner } from "../src/core/git-runner.js";
import type { GitRepository, GitRunner } from "../src/core/types.js";
import { readRetentionDays } from "../src/index.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sessionHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("expireGitSessionHistories", () => {
  it("cleans up an expired session (refs deleted, history JSON deleted, tombstone written)", async () => {
    const gitDir = await temporaryDirectory("git-expire-1-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "expired-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: oldDate,
      }),
    );

    const deletedRefs: string[] = [];
    const dummyGit: GitRunner = async (args, options) => {
      if (args[0] === "for-each-ref") {
        return {
          stdout: `refs/omp-undo-redo/history/${hash}/chk1/before\0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n`,
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "update-ref" && args[1] === "--stdin") {
        deletedRefs.push(options?.stdin ?? "");
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    // Verify history file is deleted
    await expect(stat(historyFile)).rejects.toThrow();

    // Verify tombstone is written
    const tombFile = tombstonePath(repository, sessionId);
    const tombstoneContent = JSON.parse(await readFile(tombFile, "utf8"));
    expect(tombstoneContent).toEqual({
      expired: true,
      sessionHash: hash,
      expiredAt: expect.any(String),
      reason: "age",
    });

    // Verify ref deletion command was sent with expected hash
    expect(
      deletedRefs.some((line) =>
        line.includes(
          `delete refs/omp-undo-redo/history/${hash}/chk1/before a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0`,
        ),
      ),
    ).toBe(true);
  });

  it("preserves active sessions", async () => {
    const gitDir = await temporaryDirectory("git-expire-active-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "active-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: oldDate,
      }),
    );

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

    await expireGitSessionHistories(repository, dummyGit, 30, new Set([hash]));

    const metadata = await stat(historyFile);
    expect(metadata.isFile()).toBe(true);
  });

  it("preserves recent sessions", async () => {
    const gitDir = await temporaryDirectory("git-expire-recent-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "recent-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: recentDate,
      }),
    );

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    const metadata = await stat(historyFile);
    expect(metadata.isFile()).toBe(true);
  });

  it("keeps a recent malformed history JSON without crashing", async () => {
    const gitDir = await temporaryDirectory("git-expire-malformed-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "malformed-session";
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(historyFile, "{ invalid json...");

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    const metadata = await stat(historyFile);
    expect(metadata.isFile()).toBe(true);
  });

  it.each([
    ["invalid JSON", "{ invalid json..."],
    ["non-object JSON", "null"],
    ["unparseable lastAccessedAt", JSON.stringify({ lastAccessedAt: "not-a-date" })],
  ])("expires %s by file mtime once stale", async (_name, content) => {
    const gitDir = await temporaryDirectory("git-expire-stale-corrupt-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const historyFile = historyPath(repository, "stale-corrupt");
    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(historyFile, content);
    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

    // Fresh mtime: kept.
    await expireGitSessionHistories(repository, dummyGit, 30, new Set());
    expect((await stat(historyFile)).isFile()).toBe(true);

    // Stale mtime: expired with tombstone.
    const fortyDaysAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(historyFile, fortyDaysAgo, fortyDaysAgo);
    await expireGitSessionHistories(repository, dummyGit, 30, new Set());
    await expect(stat(historyFile)).rejects.toThrow();
    expect((await stat(tombstonePath(repository, "stale-corrupt"))).isFile()).toBe(true);
  });

  it("falls back to file mtime when lastAccessedAt is missing (v1 schema)", async () => {
    const gitDir = await temporaryDirectory("git-expire-v1-fallback-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "v1-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 1,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
      }),
    );

    // Set mtime to 40 days ago
    const fortyDaysAgo = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(historyFile, fortyDaysAgo, fortyDaysAgo);

    const dummyGit: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") return { stdout: "", stderr: "", code: 0 };
      if (args[0] === "update-ref") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    await expect(stat(historyFile)).rejects.toThrow();
  });

  it("preserves history JSON if ref deletion fails (fail closed)", async () => {
    const gitDir = await temporaryDirectory("git-expire-ref-fail-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "ref-fail-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: oldDate,
      }),
    );

    const dummyGit: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") {
        return {
          stdout: `refs/omp-undo-redo/history/${hash}/chk1/before\0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n`,
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "update-ref") {
        return { stdout: "", stderr: "fatal: ref deletion error", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    const metadata = await stat(historyFile);
    expect(metadata.isFile()).toBe(true);
  });

  it("reads OMP_UNDO_REDO_RETENTION_DAYS as a number, falling back to 2 days", () => {
    // parseInt read "0.5" as 0, which switched retention off.
    expect(readRetentionDays("0.5")).toBe(0.5);
    expect(readRetentionDays("1.5")).toBe(1.5);
    expect(readRetentionDays(" 7 ")).toBe(7);
    expect(readRetentionDays("0")).toBe(0);
    for (const invalid of ["", " ", "7days", "-1", "abc", "Infinity"]) {
      expect(readRetentionDays(invalid)).toBe(2);
    }
  });

  it("skips age expiration when retentionDays=0", async () => {
    const gitDir = await temporaryDirectory("git-expire-zero-retention-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "zero-retention-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: oldDate,
      }),
    );

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

    await expireGitSessionHistories(repository, dummyGit, 0, new Set());

    const metadata = await stat(historyFile);
    expect(metadata.isFile()).toBe(true);
  });

  it("preserves sessions with a fresh cross-process heartbeat marker", async () => {
    const gitDir = await temporaryDirectory("git-expire-heartbeat-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "heartbeat-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: oldDate,
      }),
    );
    // A foreign process holds this session open and beats the marker.
    const markerPath = join(gitDir, "omp-undo-redo", "history", `.active.${hash}`);
    await writeFile(markerPath, "");

    const deletedRefCommands: string[] = [];
    const dummyGit: GitRunner = async (args, options) => {
      if (args[0] === "for-each-ref") {
        return {
          stdout: `refs/omp-undo-redo/history/${hash}/chk1/before\0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0\n`,
          stderr: "",
          code: 0,
        };
      }
      if (args[0] === "update-ref" && args[1] === "--stdin") {
        deletedRefCommands.push(options?.stdin ?? "");
        return { stdout: "", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    expect((await stat(historyFile)).isFile()).toBe(true);
    await expect(stat(tombstonePath(repository, sessionId))).rejects.toThrow();
    expect(deletedRefCommands).toEqual([]);
  });

  it("expires sessions once their cross-process heartbeat goes stale", async () => {
    const gitDir = await temporaryDirectory("git-expire-beat-stale-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "stale-heartbeat-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: oldDate,
      }),
    );
    const markerPath = join(gitDir, "omp-undo-redo", "history", `.active.${hash}`);
    await writeFile(markerPath, "");
    const stale = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
    await utimes(markerPath, stale, stale);

    const dummyGit: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    await expect(stat(historyFile)).rejects.toThrow();
    const tombstone = JSON.parse(await readFile(tombstonePath(repository, sessionId), "utf8"));
    expect(tombstone.reason).toBe("age");
    // The sweep prunes the marker whose owner stopped beating.
    await expect(stat(markerPath)).rejects.toThrow();
  });

  it("keeps original git checkpoint coordinates on disk when refs are missing at resume", async () => {
    const gitDir = await temporaryDirectory("git-resume-nopersist-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "nopersist-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const refPrefix = `refs/omp-undo-redo/history/${hash}/`;
    const beforeHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const afterHash = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1";
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [
          {
            kind: "git",
            repository,
            beforeHash,
            afterHash,
            beforeRef: `${refPrefix}chk1/before`,
            afterRef: `${refPrefix}chk1/after`,
            parentLeafId: "prompt",
            leafId: "response",
          },
        ],
        currentIndex: 0,
      }),
    );

    // Refs are gone (concurrent expiration deleted them mid-resume).
    const dummyGit: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const dummyReader = {
      getLeafId: () => "response",
      getBranch: () => [
        { id: "prompt", parentId: null, type: "message", message: { role: "user" } },
        { id: "response", parentId: "prompt", type: "message", message: { role: "assistant" } },
      ],
      getEntry: (id: string) =>
        id === "prompt" || id === "response"
          ? { id, parentId: id === "prompt" ? null : "prompt", type: "message" }
          : undefined,
    };

    const { SessionHistoryStore } = await import("../src/core/history-store.js");
    const store = new SessionHistoryStore(sessionId, repository, dummyGit);

    const result = await store.load(dummyReader);
    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    // Runtime view degrades gracefully to navigation-only checkpoints...
    expect(result.state.checkpoints).toEqual([
      {
        kind: "session",
        reason: "resumed_checkpoint_unavailable",
        parentLeafId: "prompt",
        leafId: "response",
      },
    ]);

    // ...but the stored document keeps the original coordinates (minus the
    // per-row repository, which load always supplies) so the loss
    // never becomes durable through load itself.
    const raw = JSON.parse(await readFile(historyFile, "utf8"));
    expect(raw.schemaVersion).toBe(3);
    expect(typeof raw.lastAccessedAt).toBe("string");
    expect(raw.checkpoints).toEqual([
      {
        kind: "git",
        beforeHash,
        afterHash,
        beforeRef: `${refPrefix}chk1/before`,
        afterRef: `${refPrefix}chk1/after`,
        parentLeafId: "prompt",
        leafId: "response",
      },
    ]);

    // Loading also left a cross-process heartbeat for this session.
    const markerPath = join(gitDir, "omp-undo-redo", "history", `.active.${hash}`);
    expect((await stat(markerPath)).isFile()).toBe(true);
  });

  it("removes a history JSON that coexists with its tombstone (residue cleanup)", async () => {
    const gitDir = await temporaryDirectory("git-residue-cleanup-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "residue-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    // A concurrent load rewrote the file after the sweep completed: fresh
    // timestamp, no owner. The tombstone must stay authoritative regardless
    // of the JSON's age.
    await writeFile(
      historyFile,
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [],
        currentIndex: -1,
        lastAccessedAt: new Date().toISOString(),
      }),
    );
    const tombstoneFile = tombstonePath(repository, sessionId);
    await writeFile(
      tombstoneFile,
      JSON.stringify({
        expired: true,
        sessionHash: hash,
        expiredAt: new Date().toISOString(),
        reason: "age",
      }),
    );

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });
    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    await expect(stat(historyFile)).rejects.toThrow();
    expect((await stat(tombstoneFile)).isFile()).toBe(true);
  });

  it("keeps a tombstoned history JSON while its owner has a fresh heartbeat", async () => {
    const gitDir = await temporaryDirectory("git-residue-live-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "residue-live-session";
    const hash = sessionHash(sessionId);
    const historyFile = historyPath(repository, sessionId);
    const dir = join(gitDir, "omp-undo-redo", "history");

    await mkdir(dir, { recursive: true });
    await writeFile(historyFile, JSON.stringify({ schemaVersion: 2, sessionHash: hash }));
    await writeFile(join(dir, `.active.${hash}`), "");
    await writeFile(
      tombstonePath(repository, sessionId),
      JSON.stringify({
        expired: true,
        sessionHash: hash,
        expiredAt: new Date().toISOString(),
        reason: "age",
      }),
    );

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });
    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    expect((await stat(historyFile)).isFile()).toBe(true);
  });

  it("first save leaves a heartbeat so a sweep cannot expire the new history", async () => {
    const gitDir = await temporaryDirectory("git-save-heartbeat-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "save-heartbeat-session";
    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });
    await new SessionHistoryStore(sessionId, repository, dummyGit).save({
      checkpoints: [
        {
          kind: "session",
          reason: "resumed_checkpoint_unavailable",
          parentLeafId: null,
          leafId: null,
        },
      ],
      currentIndex: 0,
    });
    const marker = join(gitDir, "omp-undo-redo", "history", `.active.${sessionHash(sessionId)}`);
    expect((await stat(marker)).isFile()).toBe(true);
  });

  it("clears a superseded tombstone when the session saves again", async () => {
    const gitDir = await temporaryDirectory("git-tombstone-clear-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "revived-session";
    const hash = sessionHash(sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    const tombstoneFile = tombstonePath(repository, sessionId);
    await writeFile(
      tombstoneFile,
      JSON.stringify({
        expired: true,
        sessionHash: hash,
        expiredAt: new Date().toISOString(),
        reason: "age",
      }),
    );

    const dummyGit: GitRunner = async (args) => {
      if (args[0] === "for-each-ref") return { stdout: "", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };
    const { SessionHistoryStore } = await import("../src/core/history-store.js");
    const store = new SessionHistoryStore(sessionId, repository, dummyGit);

    // A live owner saving new history supersedes the earlier expiration.
    await store.save({
      checkpoints: [
        {
          kind: "session",
          reason: "resumed_checkpoint_unavailable",
          parentLeafId: null,
          leafId: null,
        },
      ],
      currentIndex: 0,
    });
    await expect(stat(tombstoneFile)).rejects.toThrow();

    // The next resume loads the new history instead of reporting expired.
    const dummyReader = {
      getLeafId: () => null,
      getBranch: () => [],
      getEntry: () => undefined,
    };
    await expect(store.load(dummyReader)).resolves.toEqual({
      status: "loaded",
      state: {
        checkpoints: [
          {
            kind: "session",
            reason: "resumed_checkpoint_unavailable",
            parentLeafId: null,
            leafId: null,
          },
        ],
        currentIndex: 0,
      },
    });
  });

  it("prunes tombstones older than 2x retentionDays", async () => {
    const gitDir = await temporaryDirectory("git-prune-tombstone-");
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const historyDir = join(gitDir, "omp-undo-redo", "history");
    await mkdir(historyDir, { recursive: true });

    const sessionId = "old-tombstone";
    const hash = sessionHash(sessionId);
    const tombFile = join(historyDir, `${hash}.expired.json`);
    const expiredAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(
      tombFile,
      JSON.stringify({ expired: true, sessionHash: hash, expiredAt, reason: "age" }),
    );

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });
    await expireGitSessionHistories(repository, dummyGit, 2, () => new Set());
    await expect(stat(tombFile)).rejects.toThrow();
  });

  describe("refs with no history JSON", () => {
    const OLD = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const day = 24 * 60 * 60;

    async function setup(prefix: string) {
      const gitDir = await temporaryDirectory(prefix);
      const repository: GitRepository = {
        worktree: gitDir,
        gitDir,
        commonDir: gitDir,
        storeDir: gitDir,
      };
      const deleted: string[] = [];
      const run =
        (refs: string[]): GitRunner =>
        async (args, options) => {
          if (args[0] === "for-each-ref") return { stdout: refs.join("\n"), stderr: "", code: 0 };
          if (args[0] === "update-ref") deleted.push(options?.stdin ?? "");
          return { stdout: "", stderr: "", code: 0 };
        };
      return { repository, deleted, run };
    }

    const line = (hash: string, ageDays: number) =>
      `refs/omp-undo-redo/history/${hash}/c1/before\0${OLD}\0${Math.floor(Date.now() / 1000 - ageDays * day)} +0000`;

    it("deletes refs whose newest commit is past retention, even with no history directory", async () => {
      const { repository, deleted, run } = await setup("orphan-old-");
      const hash = sessionHash("orphan");
      const removed = await expireGitSessionHistories(
        repository,
        run([line(hash, 40), line(hash, 35)]),
        30,
        new Set(),
      );
      expect(removed).toBe(1);
      expect(deleted.join("")).toContain(
        `delete refs/omp-undo-redo/history/${hash}/c1/before ${OLD}`,
      );
    });

    it("keeps a set with any recent ref, an unknown date, a live heartbeat or an active session", async () => {
      const { repository, deleted, run } = await setup("orphan-keep-");
      const recent = sessionHash("recent");
      const undated = sessionHash("undated");
      const beating = sessionHash("beating");
      const active = sessionHash("active");
      const historyDir = join(repository.storeDir, "omp-undo-redo", "history");
      await mkdir(historyDir, { recursive: true });
      await writeFile(join(historyDir, `.active.${beating}`), "");
      const removed = await expireGitSessionHistories(
        repository,
        run([
          line(recent, 40),
          line(recent, 1),
          `refs/omp-undo-redo/history/${undated}/c1/before\0${OLD}\0`,
          line(beating, 40),
          line(active, 40),
        ]),
        30,
        new Set([active]),
      );
      expect(removed).toBe(0);
      expect(deleted).toEqual([]);
    });

    it("leaves refs alone when a history JSON exists", async () => {
      const { repository, deleted, run } = await setup("orphan-json-");
      const hash = sessionHash("has-json");
      const historyDir = join(repository.storeDir, "omp-undo-redo", "history");
      await mkdir(historyDir, { recursive: true });
      // Unparseable JSON with a fresh mtime: not yet expired, and its refs are not orphans.
      await writeFile(join(historyDir, `${hash}.json`), "{");
      await expireGitSessionHistories(repository, run([line(hash, 40)]), 30, new Set());
      expect(deleted).toEqual([]);
    });

    it("deletes nothing when any listing entry is malformed, even for an otherwise old session", async () => {
      const { repository, deleted, run } = await setup("orphan-malformed-");
      const hash = sessionHash("malformed");
      const prefix = `refs/omp-undo-redo/history/${hash}/c2/before`;
      const date = `${Math.floor(Date.now() / 1000 - 40 * day)} +0000`;
      for (const bad of [
        `${prefix}`, // no object name field
        `${prefix}\0\0${date}`, // empty object name
        `${prefix}\0not-a-hash\0${date}`,
        `${prefix}\0${OLD}\0${date}\0extra`,
      ]) {
        const removed = await expireGitSessionHistories(
          repository,
          run([line(hash, 40), bad]),
          30,
          new Set(),
        );
        expect(removed).toBe(0);
      }
      expect(deleted).toEqual([]);
    });

    it("works against real git: old snapshot commit swept, fresh one kept", async () => {
      const gitDir = await temporaryDirectory("orphan-real-");
      const repository: GitRepository = {
        worktree: gitDir,
        gitDir,
        commonDir: gitDir,
        storeDir: gitDir,
      };
      execFileSync("git", ["init", "--bare", "-q", gitDir]);
      const git = createGitRunner(gitDir, { env: { GIT_DIR: gitDir } });
      const commit = async (message: string, ageDays: number) => {
        const date = `${Math.floor(Date.now() / 1000 - ageDays * day)} +0000`;
        return execFileSync(
          "git",
          [
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit-tree",
            "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
            "-m",
            message,
          ],
          {
            env: {
              ...process.env,
              GIT_DIR: gitDir,
              GIT_COMMITTER_DATE: date,
              GIT_AUTHOR_DATE: date,
            },
          },
        )
          .toString()
          .trim();
      };
      const stale = sessionHash("real-stale");
      const fresh = sessionHash("real-fresh");
      await git([
        "update-ref",
        `refs/omp-undo-redo/history/${stale}/c1/before`,
        await commit("s", 40),
      ]);
      await git([
        "update-ref",
        `refs/omp-undo-redo/history/${fresh}/c1/before`,
        await commit("f", 1),
      ]);

      expect(await expireGitSessionHistories(repository, git, 30, new Set())).toBe(1);
      const left = (await git(["for-each-ref", "--format=%(refname)"])).stdout;
      expect(left).not.toContain(stale);
      expect(left).toContain(fresh);
    });
  });
});

describe("SessionHistoryStore size bound and checkpoint shape", () => {
  const entry = (id: string) => ({ id, parentId: null, type: "message" });
  const reader = (ids: string[]) => ({
    getLeafId: () => ids.at(-1) ?? null,
    getBranch: () => [],
    getEntry: (id: string) => (ids.includes(id) ? entry(id) : undefined),
  });
  const noGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

  async function setup(prefix: string, sessionId: string) {
    const gitDir = await temporaryDirectory(prefix);
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    return { repository, hash: sessionHash(sessionId) };
  }

  it("saves git checkpoints without a repository and load supplies the live one", async () => {
    const sessionId = "shape-session";
    const { repository, hash } = await setup("git-shape-", sessionId);
    const refPrefix = `refs/omp-undo-redo/history/${hash}/`;
    const beforeHash = "a".repeat(40);
    const afterHash = "b".repeat(40);
    const git: GitRunner = async (args) => ({
      stdout:
        args[0] === "for-each-ref"
          ? `${refPrefix}c/before\0${beforeHash}\n${refPrefix}c/after\0${afterHash}\n`
          : "",
      stderr: "",
      code: 0,
    });
    const store = new SessionHistoryStore(sessionId, repository, git);
    const checkpoint = {
      kind: "git" as const,
      repository,
      beforeHash,
      afterHash,
      beforeRef: `${refPrefix}c/before`,
      afterRef: `${refPrefix}c/after`,
      parentLeafId: null,
      leafId: "r",
    };
    await store.save({ checkpoints: [checkpoint], currentIndex: 0 });

    const raw = JSON.parse(await readFile(historyPath(repository, sessionId), "utf8"));
    expect(raw.checkpoints[0]).not.toHaveProperty("repository");
    const loaded = await store.load(reader(["r"]));
    expect(loaded).toEqual({
      status: "loaded",
      state: { checkpoints: [checkpoint], currentIndex: 0 },
    });
  });

  it.each([-1, 0, 50, 99])(
    "trims to the cap and keeps the current checkpoint loadable (currentIndex %i)",
    async (currentIndex) => {
      const sessionId = `cap-session-${currentIndex}`;
      const { repository } = await setup("git-cap-", sessionId);
      const store = new SessionHistoryStore(sessionId, repository, noGit);
      // ~100 KB per row: only about 40 of the 100 fit under the 4 MiB cap.
      const padding = "x".repeat(50_000);
      const checkpoints = Array.from({ length: 100 }, (_, index) => ({
        kind: "session" as const,
        reason: "resumed_checkpoint_unavailable" as const,
        parentLeafId: `p${index}-${padding}`,
        leafId: `l${index}-${padding}`,
      }));
      await store.save({ checkpoints, currentIndex });

      expect((await stat(historyPath(repository, sessionId))).size).toBeLessThanOrEqual(
        4 * 1024 * 1024,
      );
      const loaded = await store.load(
        reader(checkpoints.flatMap((checkpoint) => [checkpoint.parentLeafId, checkpoint.leafId])),
      );
      expect(loaded.status).toBe("loaded");
      if (loaded.status !== "loaded") return;
      const { checkpoints: kept, currentIndex: keptIndex } = loaded.state;
      expect(kept.length).toBeLessThan(checkpoints.length);
      // The kept rows are one contiguous run of the originals...
      const offset = checkpoints.findIndex((checkpoint) => checkpoint.leafId === kept[0].leafId);
      expect(kept).toEqual(checkpoints.slice(offset, offset + kept.length));
      // ...whose index still names the same current checkpoint (or "all undone").
      expect(offset + keptIndex).toBe(currentIndex);
      if (currentIndex >= 0) expect(kept[keptIndex]).toEqual(checkpoints[currentIndex]);
    },
  );

  it("does not adopt a legacy checkpoint recorded for another repository", async () => {
    const sessionId = "legacy-foreign-session";
    const { repository, hash } = await setup("git-legacy-foreign-", sessionId);
    const refPrefix = `refs/omp-undo-redo/history/${hash}/`;
    const beforeHash = "a".repeat(40);
    const afterHash = "b".repeat(40);
    const git: GitRunner = async (args) => ({
      stdout:
        args[0] === "for-each-ref"
          ? `${refPrefix}c/before\0${beforeHash}\n${refPrefix}c/after\0${afterHash}\n`
          : "",
      stderr: "",
      code: 0,
    });
    await mkdir(join(repository.storeDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(
      historyPath(repository, sessionId),
      JSON.stringify({
        schemaVersion: 2,
        sessionHash: hash,
        repository,
        checkpoints: [
          {
            kind: "git",
            repository: { ...repository, worktree: join(repository.worktree, "other") },
            beforeHash,
            afterHash,
            beforeRef: `${refPrefix}c/before`,
            afterRef: `${refPrefix}c/after`,
            parentLeafId: null,
            leafId: "r",
          },
        ],
        currentIndex: 0,
      }),
    );
    const store = new SessionHistoryStore(sessionId, repository, git);
    for (let pass = 0; pass < 2; pass++) {
      const loaded = await store.load(reader(["r"]));
      expect(loaded).toMatchObject({
        status: "loaded",
        state: { checkpoints: [{ kind: "session" }] },
      });
    }
  });
});
