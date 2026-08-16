import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  finishAfterTurnBlob,
  prepareBeforeTurnBlob,
  releaseBlobCheckpoint,
  retainBlobCheckpointForResume,
} from "../src/core/blob-checkpoints.js";
import { BlobStore } from "../src/core/blob-store/index.js";

const temporaryDirectories: string[] = [];
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("blob checkpoint lifecycle", () => {
  it("prepares, finishes, retains, applies, and releases one checkpoint", async () => {
    const workspace = await temporaryDirectory("omp-blob-checkpoint-workspace-");
    const storage = await temporaryDirectory("omp-blob-checkpoint-storage-");
    const store = new BlobStore(storage);
    await writeFile(join(workspace, "file.txt"), "before");
    const prepared = await prepareBeforeTurnBlob(store, workspace, hash("session"));
    if (prepared.status !== "blob") throw new Error("prepare failed");
    await writeFile(join(workspace, "file.txt"), "after");
    const finished = await finishAfterTurnBlob(store, prepared.checkpoint, "prompt", "response");
    if (finished.status !== "blob") throw new Error("finish failed");
    const retained = await retainBlobCheckpointForResume(store, "session", finished.checkpoint);
    expect(retained).toEqual(finished.checkpoint);

    expect(
      await store.applySnapshot(
        workspace,
        hash("session"),
        finished.checkpoint.afterTreeId,
        finished.checkpoint.beforeTreeId,
      ),
    ).toEqual({ status: "applied", partial: false });
    await expect(readFile(join(workspace, "file.txt"), "utf8")).resolves.toBe("before");
    expect(await releaseBlobCheckpoint(store, finished.checkpoint)).toBe(true);
    expect(
      await store.refMatches(
        hash("session"),
        finished.checkpoint.checkpointId,
        "before",
        finished.checkpoint.beforeTreeId,
      ),
    ).toBe(false);
    await store.shutdown();
  });

  it("degrades an unresolvable workspace to session-only", async () => {
    const storage = await temporaryDirectory("omp-blob-checkpoint-failure-storage-");
    const store = new BlobStore(storage);
    await expect(
      prepareBeforeTurnBlob(store, join(storage, "missing"), hash("missing")),
    ).resolves.toEqual({ status: "session_only", reason: "workspace_unresolvable" });
  });
});
