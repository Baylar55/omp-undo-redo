import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BlobHistoryStore, blobTombstonePath } from "../src/core/blob-history-store.js";
import { BlobStore } from "../src/core/blob-store.js";

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

describe("BlobStore expiration and storage cap", () => {
  it("expires old session histories by age and runs GC", async () => {
    const workspace = await temporaryDirectory("blob-exp-age-ws-");
    const storage = await temporaryDirectory("blob-exp-age-store-");
    const store = new BlobStore(storage);

    const sessionId = "old-session";
    const hash = sessionHash(sessionId);
    const checkpointId = randomUUID();

    await writeFile(join(workspace, "file.txt"), "old content");
    const before = await store.captureSnapshot(workspace, hash, checkpointId, "before");
    const after = await store.captureSnapshot(workspace, hash, checkpointId, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(hash, checkpointId);

    const oldHistoryStore = new BlobHistoryStore(sessionId, workspace, store);
    await oldHistoryStore.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: hash,
          checkpointId,
          beforeTreeId: before.treeId,
          afterTreeId: after.treeId,
          parentLeafId: "prompt",
          leafId: "response",
        },
      ],
      currentIndex: 0,
    });

    // Manually overwrite history file to set lastAccessedAt to 40 days ago
    const historyFilePath = join(storage, "history", `${hash}.json`);
    const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    const content = JSON.parse(await readFile(historyFilePath, "utf8"));
    content.lastAccessedAt = oldDate;
    await writeFile(historyFilePath, JSON.stringify(content));

    // Run expireAndCollect with 30 days retention
    await store.expireAndCollect(30, 0, new Set());

    // Verify history JSON removed
    await expect(stat(historyFilePath)).rejects.toThrow();

    // Verify tombstone written
    const tombFile = blobTombstonePath(sessionId, storage);
    const tombstone = JSON.parse(await readFile(tombFile, "utf8"));
    expect(tombstone).toEqual({
      expired: true,
      sessionHash: hash,
      expiredAt: expect.any(String),
      reason: "age",
    });

    // Verify blobs were garbage collected
    expect(await store.treeExists(before.treeId)).toBe(false);

    await store.shutdown();
  });

  it("evicts oldest sessions when storage cap is exceeded", async () => {
    const workspace = await temporaryDirectory("blob-exp-cap-ws-");
    const storage = await temporaryDirectory("blob-exp-cap-store-");
    const store = new BlobStore(storage);

    const s1 = "session-1";
    const s2 = "session-2";
    const s3 = "session-3";
    const h1 = sessionHash(s1);
    const h2 = sessionHash(s2);
    const h3 = sessionHash(s3);

    const setupSession = async (sId: string, h: string, content: string, daysAgo: number) => {
      const chk = randomUUID();
      await writeFile(join(workspace, "f.txt"), content);
      const before = await store.captureSnapshot(workspace, h, chk, "before");
      const after = await store.captureSnapshot(workspace, h, chk, "after");
      if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
      await store.retainCheckpointForResume(h, chk);

      const hStore = new BlobHistoryStore(sId, workspace, store);
      await hStore.save({
        checkpoints: [
          {
            kind: "blob",
            workspaceRoot: workspace,
            sessionHash: h,
            checkpointId: chk,
            beforeTreeId: before.treeId,
            afterTreeId: after.treeId,
            parentLeafId: "p",
            leafId: "r",
          },
        ],
        currentIndex: 0,
      });

      const hFile = join(storage, "history", `${h}.json`);
      const dateStr = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      const json = JSON.parse(await readFile(hFile, "utf8"));
      json.lastAccessedAt = dateStr;
      await writeFile(hFile, JSON.stringify(json));
    };

    await setupSession(s1, h1, "content session 1 ".repeat(100), 10);
    const bytes1 = await store.measureStoreBytes();
    await setupSession(s2, h2, "content session 2 ".repeat(100), 5);
    await setupSession(s3, h3, "content session 3 ".repeat(100), 1);

    const totalBytes = await store.measureStoreBytes();
    expect(totalBytes).toBeGreaterThan(0);

    // Set cap so that evicting s1 (oldest) brings size under cap
    const capBytes = totalBytes - Math.floor(bytes1 / 2);

    await store.expireAndCollect(0, capBytes, new Set());

    // s1 (oldest, 10 days ago) should be evicted first
    const hFile1 = join(storage, "history", `${h1}.json`);
    await expect(stat(hFile1)).rejects.toThrow();

    // Verify tombstone reason is storage_cap
    const tombFile1 = blobTombstonePath(s1, storage);
    const tomb1 = JSON.parse(await readFile(tombFile1, "utf8"));
    expect(tomb1.reason).toBe("storage_cap");

    // s2 and s3 should be retained
    const hFile2 = join(storage, "history", `${h2}.json`);
    expect((await stat(hFile2)).isFile()).toBe(true);
    const hFile3 = join(storage, "history", `${h3}.json`);
    expect((await stat(hFile3)).isFile()).toBe(true);

    await store.shutdown();
  });

  it("never evicts active sessions during cap enforcement", async () => {
    const workspace = await temporaryDirectory("blob-exp-active-ws-");
    const storage = await temporaryDirectory("blob-exp-active-store-");
    const store = new BlobStore(storage);

    const sessionId = "active-session-cap";
    const hash = sessionHash(sessionId);
    const checkpointId = randomUUID();

    await writeFile(join(workspace, "f.txt"), "active file content");
    const snap = await store.captureSnapshot(workspace, hash, checkpointId, "before");
    if ("reason" in snap) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(hash, checkpointId);

    const hStore = new BlobHistoryStore(sessionId, workspace, store);
    await hStore.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: hash,
          checkpointId,
          beforeTreeId: snap.treeId,
          afterTreeId: snap.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    const hFile = join(storage, "history", `${hash}.json`);
    const oldDate = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
    const json = JSON.parse(await readFile(hFile, "utf8"));
    json.lastAccessedAt = oldDate;
    await writeFile(hFile, JSON.stringify(json));

    // Cap is 1 byte, but session is active
    await store.expireAndCollect(0, 1, new Set([hash]));

    // Active session file must be preserved
    expect((await stat(hFile)).isFile()).toBe(true);

    await store.shutdown();
  });

  it("handles deduplication correctly during cap eviction (preserves shared blobs of remaining sessions)", async () => {
    const workspace = await temporaryDirectory("blob-exp-dedup-ws-");
    const storage = await temporaryDirectory("blob-exp-dedup-store-");
    const store = new BlobStore(storage);

    const s1 = "session-dedup-1";
    const s2 = "session-dedup-2";
    const h1 = sessionHash(s1);
    const h2 = sessionHash(s2);
    const chk1 = randomUUID();
    const chk2 = randomUUID();

    // Session 1 has shared file
    await writeFile(
      join(workspace, "shared.txt"),
      "identical content shared between sessions ".repeat(50),
    );
    const before1 = await store.captureSnapshot(workspace, h1, chk1, "before");
    const after1 = await store.captureSnapshot(workspace, h1, chk1, "after");
    if ("reason" in before1 || "reason" in after1) throw new Error("snapshot failed");

    // Session 2 has shared file plus extra unique file so s2 size alone fits in capBytes
    await writeFile(join(workspace, "unique_s2.txt"), "unique content for session 2 ".repeat(50));
    const before2 = await store.captureSnapshot(workspace, h2, chk2, "before");
    const after2 = await store.captureSnapshot(workspace, h2, chk2, "after");
    if ("reason" in before2 || "reason" in after2) throw new Error("snapshot failed");

    await store.retainCheckpointForResume(h1, chk1);
    await store.retainCheckpointForResume(h2, chk2);

    const hStore1 = new BlobHistoryStore(s1, workspace, store);
    await hStore1.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: h1,
          checkpointId: chk1,
          beforeTreeId: before1.treeId,
          afterTreeId: after1.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    const hStore2 = new BlobHistoryStore(s2, workspace, store);
    await hStore2.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: h2,
          checkpointId: chk2,
          beforeTreeId: before2.treeId,
          afterTreeId: after2.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    // Make s1 older
    const hFile1 = join(storage, "history", `${h1}.json`);
    const json1 = JSON.parse(await readFile(hFile1, "utf8"));
    json1.lastAccessedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(hFile1, JSON.stringify(json1));

    const totalBytes = await store.measureStoreBytes();
    // Set cap bytes slightly below totalBytes so evicting s1's manifest gets store under cap without evicting s2
    const capBytes = totalBytes - 50;

    // Force cap eviction of s1
    await store.expireAndCollect(0, capBytes, new Set());

    // s1 history is deleted
    await expect(stat(hFile1)).rejects.toThrow();

    // But shared blob still exists because s2 references it!
    expect(await store.blobExists(before1.entries[0].blobHash)).toBe(true);

    await store.shutdown();
  });

  it("handles mixed age expiration and cap eviction in a single run", async () => {
    const workspace = await temporaryDirectory("blob-exp-mixed-ws-");
    const storage = await temporaryDirectory("blob-exp-mixed-store-");
    const store = new BlobStore(storage);

    const s1 = "session-mixed-1";
    const s2 = "session-mixed-2";
    const s3 = "session-mixed-3";
    const h1 = sessionHash(s1);
    const h2 = sessionHash(s2);
    const h3 = sessionHash(s3);

    const setupSession = async (sId: string, h: string, content: string, daysAgo: number) => {
      const chk = randomUUID();
      await writeFile(join(workspace, "f.txt"), content);
      const before = await store.captureSnapshot(workspace, h, chk, "before");
      const after = await store.captureSnapshot(workspace, h, chk, "after");
      if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
      await store.retainCheckpointForResume(h, chk);

      const hStore = new BlobHistoryStore(sId, workspace, store);
      await hStore.save({
        checkpoints: [
          {
            kind: "blob",
            workspaceRoot: workspace,
            sessionHash: h,
            checkpointId: chk,
            beforeTreeId: before.treeId,
            afterTreeId: after.treeId,
            parentLeafId: "p",
            leafId: "r",
          },
        ],
        currentIndex: 0,
      });

      const hFile = join(storage, "history", `${h}.json`);
      const dateStr = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
      const json = JSON.parse(await readFile(hFile, "utf8"));
      json.lastAccessedAt = dateStr;
      await writeFile(hFile, JSON.stringify(json));
    };

    // s1 is 40 days old (expires by age 30)
    await setupSession(s1, h1, "content 1 ".repeat(100), 40);
    // s2 is 10 days old (within age, but will be evicted by tight cap)
    await setupSession(s2, h2, "content 2 ".repeat(100), 10);
    const bytesAfterS2 = await store.measureStoreBytes();
    // s3 is 1 day old (newest)
    await setupSession(s3, h3, "content 3 ".repeat(100), 1);

    // Set cap so that after s1 is expired by age, remaining store size > cap, forcing s2 eviction
    const capBytes = bytesAfterS2 - Math.floor((bytesAfterS2 - 0) / 4);

    await store.expireAndCollect(30, capBytes, new Set());

    // s1 tombstone should be "age"
    const tomb1 = JSON.parse(await readFile(blobTombstonePath(s1, storage), "utf8"));
    expect(tomb1.reason).toBe("age");

    // s2 tombstone should be "storage_cap"
    const tomb2 = JSON.parse(await readFile(blobTombstonePath(s2, storage), "utf8"));
    expect(tomb2.reason).toBe("storage_cap");

    // s3 history remains
    const hFile3 = join(storage, "history", `${h3}.json`);
    expect((await stat(hFile3)).isFile()).toBe(true);

    await store.shutdown();
  });

  it("skips cap eviction when maxStoreBytes is 0", async () => {
    const workspace = await temporaryDirectory("blob-exp-nocap-ws-");
    const storage = await temporaryDirectory("blob-exp-nocap-store-");
    const store = new BlobStore(storage);

    const s1 = "session-nocap";
    const h1 = sessionHash(s1);
    const chk1 = randomUUID();

    await writeFile(join(workspace, "f.txt"), "some content");
    const snap = await store.captureSnapshot(workspace, h1, chk1, "before");
    if ("reason" in snap) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(h1, chk1);

    const hStore = new BlobHistoryStore(s1, workspace, store);
    await hStore.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: h1,
          checkpointId: chk1,
          beforeTreeId: snap.treeId,
          afterTreeId: snap.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    await store.expireAndCollect(0, 0, new Set());

    const hFile = join(storage, "history", `${h1}.json`);
    expect((await stat(hFile)).isFile()).toBe(true);

    await store.shutdown();
  });

  it("skips malformed history JSON without deleting or crashing", async () => {
    const storage = await temporaryDirectory("blob-exp-malformed-store-");
    const store = new BlobStore(storage);

    const h1 = sessionHash("malformed");
    const historyDir = join(storage, "history");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(historyDir, { recursive: true });
    const hFile = join(historyDir, `${h1}.json`);
    await writeFile(hFile, "{ malformed content...", { flag: "w" });

    await store.expireAndCollect(30, 1, new Set());

    expect((await stat(hFile)).isFile()).toBe(true);

    await store.shutdown();
  });

  it("falls back to file mtime when lastAccessedAt is missing (v1 schema)", async () => {
    const workspace = await temporaryDirectory("blob-exp-mtime-ws-");
    const storage = await temporaryDirectory("blob-exp-mtime-store-");
    const store = new BlobStore(storage);

    const sessionId = "v1-blob-session";
    const hash = sessionHash(sessionId);
    const checkpointId = randomUUID();

    await writeFile(join(workspace, "f.txt"), "v1 content");
    const before = await store.captureSnapshot(workspace, hash, checkpointId, "before");
    const after = await store.captureSnapshot(workspace, hash, checkpointId, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(hash, checkpointId);

    const hStore = new BlobHistoryStore(sessionId, workspace, store);
    await hStore.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: hash,
          checkpointId,
          beforeTreeId: before.treeId,
          afterTreeId: after.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    const hFile = join(storage, "history", `${hash}.json`);
    const json = JSON.parse(await readFile(hFile, "utf8"));
    delete json.lastAccessedAt;
    json.schemaVersion = 1;
    await writeFile(hFile, JSON.stringify(json));

    const fortyDaysAgoSec = (Date.now() - 40 * 24 * 60 * 60 * 1000) / 1000;
    const { utimes } = await import("node:fs/promises");
    await utimes(hFile, fortyDaysAgoSec, fortyDaysAgoSec);

    await store.expireAndCollect(30, 0, new Set());

    await expect(stat(hFile)).rejects.toThrow();

    await store.shutdown();
  });

  it("skips the tree/blob sweep when nothing expired and sweeps on the next real removal", async () => {
    const workspace = await temporaryDirectory("blob-exp-gate-ws-");
    const storage = await temporaryDirectory("blob-exp-gate-store-");
    const store = new BlobStore(storage);

    const sessionId = "gate-session";
    const hash = sessionHash(sessionId);
    const checkpointId = randomUUID();
    await writeFile(join(workspace, "f.txt"), "gate content");
    const snap = await store.captureSnapshot(workspace, hash, checkpointId, "before");
    if ("reason" in snap) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(hash, checkpointId);

    const hStore = new BlobHistoryStore(sessionId, workspace, store);
    await hStore.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: hash,
          checkpointId,
          beforeTreeId: snap.treeId,
          afterTreeId: snap.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    // Orphan a second capture by releasing its refs.
    const orphanCheckpoint = randomUUID();
    await writeFile(join(workspace, "orphan.txt"), "orphan");
    const orphan = await store.captureSnapshot(workspace, hash, orphanCheckpoint, "before");
    if ("reason" in orphan) throw new Error("snapshot failed");
    await store.releaseCheckpointRefs(hash, [orphanCheckpoint]);
    expect(await store.treeExists(orphan.treeId)).toBe(true);

    // Nothing is expired (fresh history), so the O(store) sweep must be skipped.
    await store.expireAndCollect(30, 0, new Set());
    expect(await store.treeExists(orphan.treeId)).toBe(true);

    // Aging the session makes expireAndCollect remove it; the sweep then
    // reclaims the orphan that the no-op run left behind.
    const hFile = join(storage, "history", `${hash}.json`);
    const json = JSON.parse(await readFile(hFile, "utf8"));
    json.lastAccessedAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(hFile, JSON.stringify(json));

    await store.expireAndCollect(30, 0, new Set());
    expect(await store.treeExists(orphan.treeId)).toBe(false);

    await store.shutdown();
  });

  it("uses dynamic activeSessionHashes getter to re-check candidate sessions at deletion time", async () => {
    const workspace = await temporaryDirectory("blob-exp-getter-ws-");
    const storage = await temporaryDirectory("blob-exp-getter-store-");
    const store = new BlobStore(storage);

    const sessionId = "getter-session";
    const hash = sessionHash(sessionId);
    const checkpointId = randomUUID();

    await writeFile(join(workspace, "f.txt"), "content");
    const before = await store.captureSnapshot(workspace, hash, checkpointId, "before");
    const after = await store.captureSnapshot(workspace, hash, checkpointId, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    await store.retainCheckpointForResume(hash, checkpointId);

    const hStore = new BlobHistoryStore(sessionId, workspace, store);
    await hStore.save({
      checkpoints: [
        {
          kind: "blob",
          workspaceRoot: workspace,
          sessionHash: hash,
          checkpointId,
          beforeTreeId: before.treeId,
          afterTreeId: after.treeId,
          parentLeafId: "p",
          leafId: "r",
        },
      ],
      currentIndex: 0,
    });

    const hFile = join(storage, "history", `${hash}.json`);
    const json = JSON.parse(await readFile(hFile, "utf8"));
    json.lastAccessedAt = new Date(Date.now() - 50 * 24 * 60 * 60 * 1000).toISOString();
    await writeFile(hFile, JSON.stringify(json));

    const activeSet = new Set<string>();
    let calls = 0;
    const activeGetter = () => {
      calls++;
      if (calls > 1) activeSet.add(hash);
      return activeSet;
    };

    await store.expireAndCollect(30, 0, activeGetter);

    expect((await stat(hFile)).isFile()).toBe(true);

    await store.shutdown();
  });
});
