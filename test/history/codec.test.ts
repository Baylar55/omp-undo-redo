import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { historyPath } from "../../src/history/layout.js";
import { SessionHistoryStore } from "../../src/history/store.js";
import type { GitRepository, GitRunner } from "../../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("history codec", () => {
  it("loads a checkpoint reason written by a newer version as unavailable", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "history-codec-"));
    temporaryDirectories.push(gitDir);
    const repository: GitRepository = {
      worktree: gitDir,
      gitDir,
      commonDir: gitDir,
      storeDir: gitDir,
    };
    const sessionId = "future-reason-session";
    const hash = createHash("sha256").update(sessionId).digest("hex");
    const refPrefix = `refs/omp-undo-redo/history/${hash}/`;
    const beforeHash = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const afterHash = "b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0a1";
    const gitRow = {
      kind: "git",
      beforeHash,
      afterHash,
      beforeRef: `${refPrefix}chk1/before`,
      afterRef: `${refPrefix}chk1/after`,
      parentLeafId: "p2",
      leafId: "r2",
    };
    await mkdir(join(gitDir, "omp-undo-redo", "history"), { recursive: true });
    await writeFile(
      historyPath(repository, sessionId),
      JSON.stringify({
        schemaVersion: 3,
        sessionHash: hash,
        repository,
        checkpoints: [
          { kind: "session", reason: "some_future_reason", parentLeafId: "p1", leafId: "r1" },
          gitRow,
        ],
        currentIndex: 1,
      }),
    );
    const git: GitRunner = async (args) =>
      args[0] === "for-each-ref"
        ? {
            stdout: `${gitRow.beforeRef}\0${beforeHash}\n${gitRow.afterRef}\0${afterHash}\n`,
            stderr: "",
            code: 0,
          }
        : { stdout: "", stderr: "", code: 0 };
    const ids = ["p1", "r1", "p2", "r2"];
    const entries = ids.map((id, index) => ({
      id,
      parentId: index === 0 ? null : ids[index - 1]!,
      type: "message",
      message: { role: id.startsWith("p") ? "user" : "assistant" },
    }));
    const reader = {
      getLeafId: () => "r2",
      getBranch: () => entries,
      getEntry: (id: string) => entries.find((entry) => entry.id === id),
    };

    const result = await new SessionHistoryStore(sessionId, repository, git).load(reader);

    expect(result.status).toBe("loaded");
    if (result.status !== "loaded") return;
    expect(result.state.currentIndex).toBe(1);
    expect(result.state.checkpoints).toEqual([
      {
        kind: "session",
        reason: "resumed_checkpoint_unavailable",
        parentLeafId: "p1",
        leafId: "r1",
      },
      { ...gitRow, repository },
    ]);
    // The load's lastAccessedAt write-back keeps the newer version's reason.
    const onDisk = JSON.parse(await readFile(historyPath(repository, sessionId), "utf8"));
    expect(typeof onDisk.lastAccessedAt).toBe("string");
    expect(onDisk.checkpoints).toEqual([
      { kind: "session", reason: "some_future_reason", parentLeafId: "p1", leafId: "r1" },
      gitRow,
    ]);
  });
});
