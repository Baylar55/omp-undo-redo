import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

describe("non-Git blob store", () => {
  it("captures, undoes, and redoes regular file changes", async () => {
    const workspace = await temporaryDirectory("omp-blob-workspace-");
    const storage = await temporaryDirectory("omp-blob-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("basic");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "file.txt"), "before\n");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    expect("reason" in before).toBe(false);
    await writeFile(join(workspace, "file.txt"), "after\n");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    expect("reason" in after).toBe(false);
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");

    await expect(
      store.applySnapshot(workspace, session, after.treeId, before.treeId),
    ).resolves.toEqual({ status: "applied", partial: false });
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("before\n");
    await expect(
      store.applySnapshot(workspace, session, before.treeId, after.treeId),
    ).resolves.toEqual({ status: "applied", partial: false });
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("after\n");
    await store.shutdown();
  });

  it("does not read unchanged workspace files", async () => {
    const workspace = await temporaryDirectory("omp-blob-cache-workspace-");
    const storage = await temporaryDirectory("omp-blob-cache-storage-");
    let workspaceReads = 0;
    const store = new BlobStore(storage, {
      readWorkspaceFile: async (path) => {
        workspaceReads += 1;
        return readFile(path);
      },
    });
    const session = sessionHash("cache");
    const checkpoint = randomUUID();
    const path = join(workspace, "unchanged.txt");
    await writeFile(path, "unchanged\n");
    const oldTime = new Date(Date.now() - 10_000);
    await utimes(path, oldTime, oldTime);
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    if ("reason" in before) throw new Error("snapshot failed");
    expect(workspaceReads).toBe(1);
    workspaceReads = 0;
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in after) throw new Error("snapshot failed");
    expect(after.treeId).toBe(before.treeId);
    expect(workspaceReads).toBe(0);
    await store.shutdown();
  });

  it("re-reads files with racily-clean timestamps to prevent stale cache hits", async () => {
    const workspace = await temporaryDirectory("omp-blob-racy-workspace-");
    const storage = await temporaryDirectory("omp-blob-racy-storage-");
    let workspaceReads = 0;
    // Clock pinned so captureTime ≈ file mtime → racily-clean window triggers.
    const frozenTime = new Date();
    const store = new BlobStore(storage, {
      clock: () => frozenTime,
      readWorkspaceFile: async (path) => {
        workspaceReads += 1;
        return readFile(path);
      },
    });
    const session = sessionHash("racy");
    const filePath = join(workspace, "file.txt");
    await writeFile(filePath, "original\n");
    // Set mtime to exactly frozenTime so the guard's |mtime - captureTime| ≈ 0.
    await utimes(filePath, frozenTime, frozenTime);

    const before = await store.captureSnapshot(workspace, session, randomUUID(), "before");
    if ("reason" in before) throw new Error("snapshot failed");
    expect(workspaceReads).toBe(1);

    // Second capture: file untouched, fingerprint identical, but mtime is within
    // RACILY_CLEAN_MS of the prior captureTime → guard forces a re-read.
    workspaceReads = 0;
    const after = await store.captureSnapshot(workspace, session, randomUUID(), "after");
    if ("reason" in after) throw new Error("snapshot failed");
    // Same content → same tree, but the guard must have re-read the file.
    expect(after.treeId).toBe(before.treeId);
    expect(workspaceReads).toBe(1);
    await store.shutdown();
  });

  it("evicts least-recently-used workspace cache at hard cap", async () => {
    const storage = await temporaryDirectory("omp-blob-cache-cap-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("cache-cap");
    const workspaces: Array<{ root: string; path: string }> = [];
    for (let index = 0; index <= 16; index += 1) {
      const root = await temporaryDirectory(`omp-blob-cache-cap-workspace-${index}-`);
      const path = join(root, "file.txt");
      workspaces.push({ root, path });
      await writeFile(path, "cached\n");
      const snapshot = await store.captureSnapshot(root, session, randomUUID(), "before");
      if ("reason" in snapshot) throw new Error("snapshot failed");
    }
    const first = workspaces[0];
    const caches = Reflect.get(store, "workspaceCaches") as Map<string, unknown>;
    expect(caches.size).toBe(16);
    expect(caches.has(first.root)).toBe(false);
    await store.shutdown();
  });

  it("rebuilds cache after garbage collection removes its tree", async () => {
    const workspace = await temporaryDirectory("omp-blob-gc-cache-workspace-");
    const storage = await temporaryDirectory("omp-blob-gc-cache-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("gc-cache");
    const checkpoint = randomUUID();
    const path = join(workspace, "file.txt");
    await writeFile(path, "cached\n");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    if ("reason" in before) throw new Error("snapshot failed");

    await store.releaseCheckpointRefs(session, [checkpoint]);
    await store.collectGarbage();

    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in after) throw new Error("snapshot failed");
    await expect(store.blobExists(after.entries[0].blobHash)).resolves.toBe(true);
    await store.shutdown();
  });

  it("detects same-size changes even when mtime is restored", async () => {
    const workspace = await temporaryDirectory("omp-blob-stat-workspace-");
    const storage = await temporaryDirectory("omp-blob-stat-storage-");
    const store = new BlobStore(storage);
    const path = join(workspace, "same.txt");
    await writeFile(path, "aaaa");
    const original = await stat(path);
    const before = await store.captureSnapshot(
      workspace,
      sessionHash("stat"),
      randomUUID(),
      "before",
    );
    await writeFile(path, "bbbb");
    await utimes(path, original.atime, original.mtime);
    const after = await store.captureSnapshot(
      workspace,
      sessionHash("stat"),
      randomUUID(),
      "after",
    );
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(after.treeId).not.toBe(before.treeId);
    await store.shutdown();
  });

  it("handles file-to-directory transitions in both directions", async () => {
    const workspace = await temporaryDirectory("omp-blob-topology-workspace-");
    const storage = await temporaryDirectory("omp-blob-topology-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("topology");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "node"), "file");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await rm(join(workspace, "node"));
    await mkdir(join(workspace, "node"));
    await writeFile(join(workspace, "node", "child.txt"), "child");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");

    expect(await store.applySnapshot(workspace, session, after.treeId, before.treeId)).toEqual({
      status: "applied",
      partial: false,
    });
    await expect(readFile(join(workspace, "node"), "utf8")).resolves.toBe("file");
    expect(await store.applySnapshot(workspace, session, before.treeId, after.treeId)).toEqual({
      status: "applied",
      partial: false,
    });
    await expect(readFile(join(workspace, "node", "child.txt"), "utf8")).resolves.toBe("child");
    await store.shutdown();
  });

  it.skipIf(process.platform === "win32")("restores executable-mode-only changes", async () => {
    const workspace = await temporaryDirectory("omp-blob-mode-workspace-");
    const storage = await temporaryDirectory("omp-blob-mode-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("mode");
    const checkpoint = randomUUID();
    const path = join(workspace, "script.sh");
    await writeFile(path, "echo ok\n");
    await chmod(path, 0o644);
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await chmod(path, 0o755);
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(await store.applySnapshot(workspace, session, after.treeId, before.treeId)).toEqual({
      status: "applied",
      partial: false,
    });
    expect((await stat(path)).mode & 0o777).toBe(0o644);
    await store.shutdown();
  });

  it.skipIf(process.platform === "win32")("rejects a symlink-parent escape", async () => {
    const workspace = await temporaryDirectory("omp-blob-symlink-workspace-");
    const outside = await temporaryDirectory("omp-blob-symlink-outside-");
    const storage = await temporaryDirectory("omp-blob-symlink-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("symlink");
    const checkpoint = randomUUID();
    await mkdir(join(workspace, "parent"));
    await writeFile(join(workspace, "parent", "file.txt"), "before");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "parent", "file.txt"), "after");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    await rm(join(workspace, "parent"), { recursive: true });
    await symlink(outside, join(workspace, "parent"), "dir");

    expect(await store.applySnapshot(workspace, session, after.treeId, before.treeId)).toEqual({
      status: "conflict",
    });
    await expect(readFile(join(outside, "file.txt"))).rejects.toThrow();
    await store.shutdown();
  });

  it("rejects conflicting worktree content without mutation", async () => {
    const workspace = await temporaryDirectory("omp-blob-conflict-workspace-");
    const storage = await temporaryDirectory("omp-blob-conflict-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("conflict");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "file.txt"), "before");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "file.txt"), "after");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    await writeFile(join(workspace, "file.txt"), "external");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");

    await expect(
      store.applySnapshot(workspace, session, after.treeId, before.treeId),
    ).resolves.toEqual({
      status: "conflict",
    });
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("external");
    await store.shutdown();
  });

  it("recovers an interrupted delete from its journal", async () => {
    const workspace = await temporaryDirectory("omp-blob-recovery-workspace-");
    const storage = await temporaryDirectory("omp-blob-recovery-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("recovery");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "file.txt"), "before");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "file.txt"), "after");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");

    await rm(join(workspace, "file.txt"));
    const journals = join(storage, "journals");
    await mkdir(journals, { recursive: true });
    await writeFile(
      join(journals, `${randomUUID()}.json`),
      JSON.stringify({
        workspaceRoot: await realpath(workspace),
        sourceTreeId: before.treeId,
        targetTreeId: after.treeId,
        paths: ["file.txt"],
      }),
    );

    const recovered = await store.captureSnapshot(workspace, session, randomUUID(), "before");
    expect("reason" in recovered).toBe(false);
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("before");
    await store.shutdown();
  });

  it("reports skipped oversized paths and atomically promotes checkpoint refs", async () => {
    const workspace = await temporaryDirectory("omp-blob-partial-workspace-");
    const storage = await temporaryDirectory("omp-blob-partial-storage-");
    const store = new BlobStore(storage, { maxFileBytes: 3 });
    const session = sessionHash("partial");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "large.bin"), "1234");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "small"), "ok");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(before.skippedPaths).toEqual(["large.bin"]);
    expect(await store.retainCheckpointForResume(session, checkpoint)).toBe(true);
    expect(await store.refMatches(session, checkpoint, "before", before.treeId)).toBe(true);
    expect(await store.refMatches(session, checkpoint, "after", after.treeId)).toBe(true);
    await store.shutdown();
  });

  it("leaves skipped-to-captured paths untouched while restoring safe paths", async () => {
    const workspace = await temporaryDirectory("omp-blob-skipped-transition-workspace-");
    const storage = await temporaryDirectory("omp-blob-skipped-transition-storage-");
    const store = new BlobStore(storage, { maxFileBytes: 3 });
    const session = sessionHash("skipped-transition");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "changing.bin"), "1234");
    await writeFile(join(workspace, "safe.txt"), "old");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "changing.bin"), "ok");
    await writeFile(join(workspace, "safe.txt"), "new");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(before.skippedPaths).toEqual(["changing.bin"]);
    expect(after.skippedPaths).toEqual([]);

    expect(await store.applySnapshot(workspace, session, after.treeId, before.treeId)).toEqual({
      status: "applied",
      partial: true,
    });
    await expect(readFile(join(workspace, "changing.bin"), "utf8")).resolves.toBe("ok");
    await expect(readFile(join(workspace, "safe.txt"), "utf8")).resolves.toBe("old");
    await store.shutdown();
  });

  it("leaves captured-to-skipped paths untouched while restoring safe paths", async () => {
    const workspace = await temporaryDirectory("omp-blob-reverse-skipped-workspace-");
    const storage = await temporaryDirectory("omp-blob-reverse-skipped-storage-");
    const store = new BlobStore(storage, { maxFileBytes: 3 });
    const session = sessionHash("reverse-skipped-transition");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "changing.bin"), "ok");
    await writeFile(join(workspace, "safe.txt"), "old");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "changing.bin"), "1234");
    await writeFile(join(workspace, "safe.txt"), "new");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(before.skippedPaths).toEqual([]);
    expect(after.skippedPaths).toEqual(["changing.bin"]);

    expect(await store.applySnapshot(workspace, session, after.treeId, before.treeId)).toEqual({
      status: "applied",
      partial: true,
    });
    await expect(readFile(join(workspace, "changing.bin"), "utf8")).resolves.toBe("1234");
    await expect(readFile(join(workspace, "safe.txt"), "utf8")).resolves.toBe("old");
    await store.shutdown();
  });

  it("protects ancestors and descendants of skipped paths", async () => {
    const workspace = await temporaryDirectory("omp-blob-skipped-namespace-workspace-");
    const storage = await temporaryDirectory("omp-blob-skipped-namespace-storage-");
    const store = new BlobStore(storage, { maxFileBytes: 3 });
    const session = sessionHash("skipped-namespace");
    const checkpoint = randomUUID();
    await mkdir(join(workspace, "ancestor"));
    await writeFile(join(workspace, "ancestor", "large.bin"), "1234");
    await writeFile(join(workspace, "descendant"), "1234");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await rm(join(workspace, "ancestor"), { recursive: true });
    await writeFile(join(workspace, "ancestor"), "ok");
    await rm(join(workspace, "descendant"));
    await mkdir(join(workspace, "descendant"));
    await writeFile(join(workspace, "descendant", "child.txt"), "ok");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    expect(before.skippedPaths).toEqual(["ancestor/large.bin", "descendant"]);

    expect(await store.applySnapshot(workspace, session, after.treeId, before.treeId)).toEqual({
      status: "applied",
      partial: true,
    });
    await expect(readFile(join(workspace, "ancestor"), "utf8")).resolves.toBe("ok");
    await expect(readFile(join(workspace, "descendant", "child.txt"), "utf8")).resolves.toBe("ok");
    await store.shutdown();
  });

  it("does not split refs when history promotion fails", async () => {
    const workspace = await temporaryDirectory("omp-blob-promotion-workspace-");
    const storage = await temporaryDirectory("omp-blob-promotion-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("promotion");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "file.txt"), "before");
    const before = await store.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "file.txt"), "after");
    const after = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");
    const historyDirectory = join(storage, "refs", "history", session, checkpoint);
    await mkdir(historyDirectory, { recursive: true });
    await writeFile(join(historyDirectory, "blocker"), "block");

    expect(await store.retainCheckpointForResume(session, checkpoint)).toBe(false);
    expect(await store.refMatches(session, checkpoint, "before", before.treeId, "active")).toBe(
      true,
    );
    expect(await store.refMatches(session, checkpoint, "after", after.treeId, "active")).toBe(true);
    await store.releaseCheckpointRefs(session, [checkpoint]);
    await store.shutdown();
  });

  it("serializes concurrent applies across store instances", async () => {
    const workspace = await temporaryDirectory("omp-blob-concurrent-workspace-");
    const storage = await temporaryDirectory("omp-blob-concurrent-storage-");
    const first = new BlobStore(storage);
    const second = new BlobStore(storage);
    const session = sessionHash("concurrent");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "file.txt"), "before");
    const before = await first.captureSnapshot(workspace, session, checkpoint, "before");
    await writeFile(join(workspace, "file.txt"), "after");
    const after = await first.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in before || "reason" in after) throw new Error("snapshot failed");

    const results = await Promise.all([
      first.applySnapshot(workspace, session, after.treeId, before.treeId),
      second.applySnapshot(workspace, session, after.treeId, before.treeId),
    ]);
    expect(results.filter((result) => result.status === "applied")).toHaveLength(1);
    expect(results.filter((result) => result.status === "conflict")).toHaveLength(1);
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("before");
    await first.shutdown();
    await second.shutdown();
  });

  it("reaps only active refs owned by a provably dead local process", async () => {
    const workspace = await temporaryDirectory("omp-blob-stale-workspace-");
    const storage = await temporaryDirectory("omp-blob-stale-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("stale");
    const checkpoint = randomUUID();
    await writeFile(join(workspace, "stale.txt"), "stale");
    const snapshot = await store.captureSnapshot(workspace, session, checkpoint, "before");
    if ("reason" in snapshot) throw new Error("snapshot failed");
    expect(await readdir(join(storage, "leases"))).toHaveLength(1);
    const staleOwner = randomUUID();
    const refPath = join(storage, "refs", "active", session, checkpoint, "before.ref");
    await writeFile(refPath, JSON.stringify({ treeId: snapshot.treeId, ownerId: staleOwner }));
    await mkdir(join(storage, "leases"), { recursive: true });
    const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = child.pid;
    if (!deadPid) throw new Error("child PID unavailable");
    await new Promise<void>((resolvePromise, rejectPromise) => {
      child.once("exit", () => resolvePromise());
      child.once("error", rejectPromise);
    });
    await writeFile(
      join(storage, "leases", `${staleOwner}.json`),
      JSON.stringify({ ownerId: staleOwner, pid: deadPid, hostname: hostname() }),
    );

    await store.garbageCollect();
    expect(await store.treeExists(snapshot.treeId)).toBe(false);
    await store.shutdown();
  });

  it("garbage-collects released objects while preserving referenced history", async () => {
    const workspace = await temporaryDirectory("omp-blob-gc-workspace-");
    const storage = await temporaryDirectory("omp-blob-gc-storage-");
    const store = new BlobStore(storage);
    const session = sessionHash("gc");
    const retainedId = randomUUID();
    await writeFile(join(workspace, "kept.txt"), "kept");
    const kept = await store.captureSnapshot(workspace, session, retainedId, "before");
    await store.captureSnapshot(workspace, session, retainedId, "after");
    if ("reason" in kept) throw new Error("snapshot failed");
    expect(await store.retainCheckpointForResume(session, retainedId)).toBe(true);

    const releasedId = randomUUID();
    await writeFile(join(workspace, "orphan.txt"), "orphan");
    const orphan = await store.captureSnapshot(workspace, session, releasedId, "before");
    if ("reason" in orphan) throw new Error("snapshot failed");
    await store.releaseCheckpointRefs(session, [releasedId]);
    await store.garbageCollect();

    expect(await store.treeExists(kept.treeId)).toBe(true);
    expect(await store.treeExists(orphan.treeId)).toBe(false);
    await store.shutdown();
  });
});
