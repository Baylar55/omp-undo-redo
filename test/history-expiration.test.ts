import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  expireGitSessionHistories,
  historyPath,
  tombstonePath,
} from "../src/core/history-store.js";
import type { GitRepository, GitRunner } from "../src/core/types.js";

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
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
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
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
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
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
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

  it("skips malformed history JSON without deleting or crashing", async () => {
    const gitDir = await temporaryDirectory("git-expire-malformed-");
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
    const sessionId = "malformed-session";
    const historyFile = historyPath(repository, sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(historyFile, "{ invalid json...");

    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });

    await expireGitSessionHistories(repository, dummyGit, 30, new Set());

    const metadata = await stat(historyFile);
    expect(metadata.isFile()).toBe(true);
  });

  it("falls back to file mtime when lastAccessedAt is missing (v1 schema)", async () => {
    const gitDir = await temporaryDirectory("git-expire-v1-fallback-");
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
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
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
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

  it("skips age expiration when retentionDays=0", async () => {
    const gitDir = await temporaryDirectory("git-expire-zero-retention-");
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
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

  it("returns status expired when tombstone file exists for Git store load", async () => {
    const gitDir = await temporaryDirectory("git-load-tombstone-");
    const repository: GitRepository = { worktree: gitDir, gitDir, commonDir: gitDir };
    const sessionId = "git-tombstone-session";
    const hash = sessionHash(sessionId);

    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(
      tombstonePath(repository, sessionId),
      JSON.stringify({
        expired: true,
        sessionHash: hash,
        expiredAt: new Date().toISOString(),
        reason: "storage_cap",
      }),
    );

    const { SessionHistoryStore } = await import("../src/core/history-store.js");
    const dummyGit: GitRunner = async () => ({ stdout: "", stderr: "", code: 0 });
    const store = new SessionHistoryStore(sessionId, repository, dummyGit);

    const dummyReader = {
      getLeafId: () => null,
      getBranch: () => [],
      getEntry: () => undefined,
    };

    await expect(store.load(dummyReader)).resolves.toEqual({
      status: "expired",
      reason: "storage_cap",
    });
  });
});
