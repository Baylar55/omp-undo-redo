import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlobHistoryStore } from "../src/core/blob-history-store.js";
import { BlobStore } from "../src/core/blob-store/index.js";
import { checkpointNamespace } from "../src/core/checkpoints.js";
import {
  blobNavigationApplier,
  blobNavigationReleaser,
  SessionNavigation,
} from "../src/core/session-navigation.js";
import type {
  BlobCheckpoint,
  NavigationPort,
  SessionEntryLike,
  SessionReader,
} from "../src/core/types.js";

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
  it("distinguishes missing from unusable history files on load", async () => {
    const workspace = await temporaryDirectory("omp-blob-history-workspace-");
    const storage = await temporaryDirectory("omp-blob-history-storage-");
    const sessionId = "blob-missing-vs-unusable";
    const store = new BlobStore(storage);
    const history = new BlobHistoryStore(sessionId, workspace, store);

    await expect(history.load(reader())).resolves.toEqual({
      status: "unavailable",
      reason: "missing",
    });

    const historyPath = join(
      store.rootDirectory,
      "history",
      `${checkpointNamespace(sessionId)}.json`,
    );
    await mkdir(dirname(historyPath), { recursive: true });
    await writeFile(historyPath, "{corrupted history");
    await expect(history.load(reader())).resolves.toEqual({
      status: "unavailable",
      reason: "unusable",
    });
    await store.shutdown();
  });

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

  it("does not persist downgraded checkpoints to disk on load", async () => {
    const workspace = await temporaryDirectory("omp-blob-nopersist-ws-");
    const storage = await temporaryDirectory("omp-blob-nopersist-store-");
    const sessionId = "blob-nopersist-session";
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

    // The save left a cross-process heartbeat marker for this session.
    const markerPath = join(storage, "history", `.active.${sessionHash}`);
    expect((await stat(markerPath)).isFile()).toBe(true);

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

    // The runtime downgrade must stay in memory only: the stored document
    // keeps the original blob coordinates (plus a refreshed timestamp), so a
    // concurrent expiration can never turn a transient race into permanent
    // data loss.
    const raw = JSON.parse(await readFile(join(storage, "history", `${sessionHash}.json`), "utf8"));
    expect(raw.schemaVersion).toBe(2);
    expect(typeof raw.lastAccessedAt).toBe("string");
    expect(raw.checkpoints).toEqual([checkpoint]);

    await store.shutdown();
  });

  it("clears a superseded tombstone when the session saves again", async () => {
    const workspace = await temporaryDirectory("omp-blob-revive-ws-");
    const storage = await temporaryDirectory("omp-blob-revive-store-");
    const sessionId = "blob-revived-session";
    const sessionHash = checkpointNamespace(sessionId);
    const store = new BlobStore(storage);

    const historyDir = join(storage, "history");
    await mkdir(historyDir, { recursive: true });
    const tombstoneFile = join(historyDir, `${sessionHash}.expired.json`);
    await writeFile(
      tombstoneFile,
      JSON.stringify({
        expired: true,
        sessionHash,
        expiredAt: new Date().toISOString(),
        reason: "storage_cap",
      }),
    );

    const history = new BlobHistoryStore(sessionId, workspace, store);
    // A live owner saving new history supersedes the earlier expiration.
    await history.save({
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
    await expect(history.load(reader())).resolves.toEqual({
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

  it("loads multi-turn state when active leaf is at an undone turn prompt boundary", async () => {
    const workspace = await temporaryDirectory("omp-blob-multi-undo-workspace-");
    const storage = await temporaryDirectory("omp-blob-multi-undo-storage-");
    const sessionId = "multi-undo-session";
    const sessionHash = checkpointNamespace(sessionId);
    const store = new BlobStore(storage);

    const c1Id = randomUUID();
    const c2Id = randomUUID();

    await writeFile(join(workspace, "file.txt"), "base");
    const c1Before = await store.captureSnapshot(workspace, sessionHash, c1Id, "before");
    await writeFile(join(workspace, "file.txt"), "turn1");
    const c1After = await store.captureSnapshot(workspace, sessionHash, c1Id, "after");
    await store.retainCheckpointForResume(sessionHash, c1Id);

    const c2Before = await store.captureSnapshot(workspace, sessionHash, c2Id, "before");
    await writeFile(join(workspace, "file.txt"), "turn2");
    const c2After = await store.captureSnapshot(workspace, sessionHash, c2Id, "after");
    await store.retainCheckpointForResume(sessionHash, c2Id);

    if (
      "reason" in c1Before ||
      "reason" in c1After ||
      "reason" in c2Before ||
      "reason" in c2After
    ) {
      throw new Error("snapshot failed");
    }

    const c1: BlobCheckpoint = {
      kind: "blob",
      workspaceRoot: await realpath(workspace),
      sessionHash,
      checkpointId: c1Id,
      beforeTreeId: c1Before.treeId,
      afterTreeId: c1After.treeId,
      parentLeafId: "p1",
      leafId: "r1",
    };
    const c2: BlobCheckpoint = {
      kind: "blob",
      workspaceRoot: await realpath(workspace),
      sessionHash,
      checkpointId: c2Id,
      beforeTreeId: c2Before.treeId,
      afterTreeId: c2After.treeId,
      parentLeafId: "p2",
      leafId: "r2",
    };

    const history = new BlobHistoryStore(sessionId, workspace, store);
    // State saved after undoing Turn 2 (currentIndex = 0, active leaf is p2)
    await history.save({
      checkpoints: [c1, c2],
      currentIndex: 0,
    });

    const multiReader: SessionReader = {
      getLeafId: () => "p2",
      getBranch: () => [
        { id: "p1", parentId: null, type: "message", message: { role: "user" } },
        { id: "r1", parentId: "p1", type: "message", message: { role: "assistant" } },
        { id: "p2", parentId: "r1", type: "message", message: { role: "user" } },
      ],
      getEntry: (id) => {
        const all: SessionEntryLike[] = [
          { id: "p1", parentId: null, type: "message", message: { role: "user" } },
          { id: "r1", parentId: "p1", type: "message", message: { role: "assistant" } },
          { id: "p2", parentId: "r1", type: "message", message: { role: "user" } },
          { id: "r2", parentId: "p2", type: "message", message: { role: "assistant" } },
        ];
        return all.find((e) => e.id === id);
      },
    };

    const loaded = await history.load(multiReader);
    expect(loaded).toEqual({
      status: "loaded",
      state: {
        checkpoints: [c1, c2],
        currentIndex: 0,
      },
    });

    await store.shutdown();
  });

  it("keeps the persisted cursor and full chain when resuming at a checkpoint browsed backward past the cursor", async () => {
    const workspace = await temporaryDirectory("omp-blob-browse-back-workspace-");
    const storage = await temporaryDirectory("omp-blob-browse-back-storage-");
    const sessionId = "browse-back-session";
    const sessionHash = checkpointNamespace(sessionId);
    const store = new BlobStore(storage);

    const entries: SessionEntryLike[] = [
      { id: "p1", parentId: null, type: "message", message: { role: "user" } },
      { id: "r1", parentId: "p1", type: "message", message: { role: "assistant" } },
      { id: "p2", parentId: "r1", type: "message", message: { role: "user" } },
      { id: "r2", parentId: "p2", type: "message", message: { role: "assistant" } },
      { id: "p3", parentId: "r2", type: "message", message: { role: "user" } },
      { id: "r3", parentId: "p3", type: "message", message: { role: "assistant" } },
    ];

    const checkpoints: BlobCheckpoint[] = [];
    const turnFiles = ["base", "turn1", "turn2", "turn3"];
    for (let turn = 1; turn <= 3; turn++) {
      const checkpointId = randomUUID();
      await writeFile(join(workspace, "file.txt"), turnFiles[turn - 1]);
      const before = await store.captureSnapshot(workspace, sessionHash, checkpointId, "before");
      await writeFile(join(workspace, "file.txt"), turnFiles[turn]);
      const after = await store.captureSnapshot(workspace, sessionHash, checkpointId, "after");
      if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
      await store.retainCheckpointForResume(sessionHash, checkpointId);
      checkpoints.push({
        kind: "blob",
        workspaceRoot: await realpath(workspace),
        sessionHash,
        checkpointId,
        beforeTreeId: before.treeId,
        afterTreeId: after.treeId,
        parentLeafId: `p${turn}`,
        leafId: `r${turn}`,
      });
    }

    const history = new BlobHistoryStore(sessionId, workspace, store);
    // State saved after completing all three turns at r3 (currentIndex = 2).
    // The user then browsed the tree back to p1 without touching files, so
    // the workspace still holds the turn-3 content at shutdown.
    await history.save({ checkpoints, currentIndex: 2 });

    const resumed: NavigationPort = {
      leaf: "p1",
      getLeafId() {
        return resumed.leaf;
      },
      getEntry: (id) => entries.find((entry) => entry.id === id),
      getBranch: () => entries,
      async navigateTree(targetId) {
        resumed.leaf = targetId;
        return { cancelled: false };
      },
    };

    // Browsing does not move the cursor or the file state, so the persisted
    // cursor must survive the resume untouched.
    const loaded = await history.load(resumed);
    expect(loaded).toEqual({
      status: "loaded",
      state: { checkpoints, currentIndex: 2 },
    });

    const navigation = new SessionNavigation(
      resumed,
      async () => ({ stdout: "", stderr: "", code: 0 }),
      undefined,
      undefined,
      blobNavigationApplier(store),
      blobNavigationReleaser(store),
    );
    navigation.restoreState(loaded.state);

    for (let turn = 3; turn >= 1; turn--) {
      expect((await navigation.undo()).status).toBe("moved");
      expect(resumed.leaf).toBe(`p${turn}`);
      expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe(turnFiles[turn - 1]);
    }
    expect((await navigation.undo()).status).toBe("empty");

    for (let turn = 1; turn <= 3; turn++) {
      expect((await navigation.redo()).status).toBe("moved");
      expect(resumed.leaf).toBe(`r${turn}`);
      expect(await readFile(join(workspace, "file.txt"), "utf8")).toBe(turnFiles[turn]);
    }
    expect((await navigation.redo()).status).toBe("empty");

    await store.shutdown();
  });

  it("loads persisted history when the active leaf is not on the checkpoint chain", async () => {
    const workspace = await temporaryDirectory("omp-blob-off-chain-workspace-");
    const storage = await temporaryDirectory("omp-blob-off-chain-storage-");
    const sessionId = "off-chain-session";
    const sessionHash = checkpointNamespace(sessionId);
    const store = new BlobStore(storage);

    const c1Id = randomUUID();
    await writeFile(join(workspace, "file.txt"), "base");
    const c1Before = await store.captureSnapshot(workspace, sessionHash, c1Id, "before");
    await writeFile(join(workspace, "file.txt"), "turn1");
    const c1After = await store.captureSnapshot(workspace, sessionHash, c1Id, "after");
    if ("reason" in c1Before || "reason" in c1After) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(sessionHash, c1Id);
    const c1: BlobCheckpoint = {
      kind: "blob",
      workspaceRoot: await realpath(workspace),
      sessionHash,
      checkpointId: c1Id,
      beforeTreeId: c1Before.treeId,
      afterTreeId: c1After.treeId,
      parentLeafId: "p1",
      leafId: "r1",
    };

    const history = new BlobHistoryStore(sessionId, workspace, store);
    await history.save({ checkpoints: [c1], currentIndex: 0 });

    const chainEntries: SessionEntryLike[] = [
      { id: "p1", parentId: null, type: "message", message: { role: "user" } },
      { id: "r1", parentId: "p1", type: "message", message: { role: "assistant" } },
      { id: "p2", parentId: "r1", type: "message", message: { role: "user" } },
      { id: "r2", parentId: "p2", type: "message", message: { role: "assistant" } },
    ];
    const offChainReader: SessionReader = {
      getLeafId: () => "r2",
      getBranch: () => chainEntries,
      getEntry: (id) => chainEntries.find((entry) => entry.id === id),
    };

    expect(await history.load(offChainReader)).toEqual({
      status: "loaded",
      state: { checkpoints: [c1], currentIndex: 0 },
    });

    await store.shutdown();
  });
});
