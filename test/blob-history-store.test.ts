import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobHistoryStore } from "../src/core/blob-history-store.js";
import { BlobStore } from "../src/core/blob-store/index.js";
import { checkpointNamespace } from "../src/core/checkpoints.js";
import type { BlobCheckpoint, SessionEntryLike, SessionReader } from "../src/core/types.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function reader(): SessionReader {
  const entries: SessionEntryLike[] = [
    { id: "prompt", parentId: null, type: "message", message: { role: "user" } },
    { id: "response", parentId: "prompt", type: "message", message: { role: "assistant" } },
  ];
  return {
    getLeafId: () => "response",
    getBranch: () => entries,
    getEntry: (id) => entries.find((entry) => entry.id === id),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("blob history store", () => {
  it("round-trips retained checkpoints across store instances", async () => {
    const workspace = await temporaryDirectory("omp-blob-history-workspace-");
    const storage = await temporaryDirectory("omp-blob-history-storage-");
    const sessionId = "blob-history-session";
    const sessionHash = checkpointNamespace(sessionId);
    const checkpointId = randomUUID();
    const firstStore = new BlobStore(storage);
    await writeFile(join(workspace, "file.txt"), "before");
    const before = await firstStore.captureSnapshot(workspace, sessionHash, checkpointId, "before");
    await writeFile(join(workspace, "file.txt"), "after");
    const after = await firstStore.captureSnapshot(workspace, sessionHash, checkpointId, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(await firstStore.retainCheckpointForResume(sessionHash, checkpointId)).toBe(true);
    const checkpoint: BlobCheckpoint = {
      kind: "blob",
      workspaceRoot: await realpath(workspace),
      sessionHash,
      checkpointId,
      beforeTreeId: before.treeId,
      afterTreeId: after.treeId,
      parentLeafId: "prompt",
      leafId: "response",
    };
    await new BlobHistoryStore(sessionId, workspace, firstStore).save({
      checkpoints: [checkpoint],
      currentIndex: 0,
    });
    await firstStore.shutdown();

    const secondStore = new BlobStore(storage);
    expect(await secondStore.refMatches(sessionHash, checkpointId, "before", before.treeId)).toBe(
      true,
    );
    expect(await secondStore.refMatches(sessionHash, checkpointId, "after", after.treeId)).toBe(
      true,
    );
    expect(await secondStore.treeUsable(before.treeId)).toBe(true);
    expect(await secondStore.treeUsable(after.treeId)).toBe(true);
    await expect(
      new BlobHistoryStore(sessionId, workspace, secondStore).load(reader()),
    ).resolves.toEqual({
      status: "loaded",
      state: {
        checkpoints: [checkpoint],
        currentIndex: 0,
      },
    });
    await secondStore.shutdown();
  });

  it("validates a shared tree only once per load", async () => {
    const workspace = await temporaryDirectory("omp-blob-shared-tree-workspace-");
    const storage = await temporaryDirectory("omp-blob-shared-tree-storage-");
    const sessionId = "blob-shared-tree-session";
    const sessionHash = checkpointNamespace(sessionId);
    const checkpointId = randomUUID();
    const store = new BlobStore(storage);
    await writeFile(join(workspace, "file.txt"), "unchanged");
    const before = await store.captureSnapshot(workspace, sessionHash, checkpointId, "before");
    const after = await store.captureSnapshot(workspace, sessionHash, checkpointId, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(after.treeId).toBe(before.treeId);
    await store.retainCheckpointForResume(sessionHash, checkpointId);
    const checkpoint: BlobCheckpoint = {
      kind: "blob",
      workspaceRoot: await realpath(workspace),
      sessionHash,
      checkpointId,
      beforeTreeId: before.treeId,
      afterTreeId: after.treeId,
      parentLeafId: "prompt",
      leafId: "response",
    };
    const history = new BlobHistoryStore(sessionId, workspace, store);
    await history.save({ checkpoints: [checkpoint], currentIndex: 0 });
    const treeUsable = vi.spyOn(store, "treeUsable");

    await expect(history.load(reader())).resolves.toEqual({
      status: "loaded",
      state: {
        checkpoints: [checkpoint],
        currentIndex: 0,
      },
    });
    expect(treeUsable).toHaveBeenCalledTimes(1);
    await store.shutdown();
  });

  it("downgrades a checkpoint when a retained tree is missing", async () => {
    const workspace = await temporaryDirectory("omp-blob-missing-workspace-");
    const storage = await temporaryDirectory("omp-blob-missing-storage-");
    const sessionId = "blob-missing-session";
    const sessionHash = checkpointNamespace(sessionId);
    const checkpointId = randomUUID();
    const store = new BlobStore(storage);
    await writeFile(join(workspace, "file.txt"), "before");
    const before = await store.captureSnapshot(workspace, sessionHash, checkpointId, "before");
    await writeFile(join(workspace, "file.txt"), "after");
    const after = await store.captureSnapshot(workspace, sessionHash, checkpointId, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(sessionHash, checkpointId);
    const checkpoint: BlobCheckpoint = {
      kind: "blob",
      workspaceRoot: await realpath(workspace),
      sessionHash,
      checkpointId,
      beforeTreeId: before.treeId,
      afterTreeId: after.treeId,
      parentLeafId: "prompt",
      leafId: "response",
    };
    const history = new BlobHistoryStore(sessionId, workspace, store);
    await history.save({ checkpoints: [checkpoint], currentIndex: 0 });
    await rm(join(storage, "trees", `${before.treeId}.json`), { force: true });

    await expect(history.load(reader())).resolves.toEqual({
      status: "loaded",
      state: {
        checkpoints: [
          {
            kind: "session",
            reason: "resumed_checkpoint_unavailable",
            parentLeafId: "prompt",
            leafId: "response",
          },
        ],
        currentIndex: 0,
      },
    });
    await store.shutdown();
  });

  it("returns status expired when tombstone file exists", async () => {
    const workspace = await temporaryDirectory("omp-blob-tombstone-workspace-");
    const storage = await temporaryDirectory("omp-blob-tombstone-storage-");
    const sessionId = "tombstone-session";
    const sessionHash = checkpointNamespace(sessionId);
    const store = new BlobStore(storage);

    const historyDir = join(storage, "history");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(historyDir, { recursive: true });

    await writeFile(
      join(historyDir, `${sessionHash}.expired.json`),
      JSON.stringify({
        expired: true,
        sessionHash,
        expiredAt: new Date().toISOString(),
        reason: "age",
      }),
    );

    const history = new BlobHistoryStore(sessionId, workspace, store);
    await expect(history.load(reader())).resolves.toEqual({
      status: "expired",
      reason: "age",
    });

    await store.shutdown();
  });
});
