import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BlobStore } from "../dist/core/blob-store.js";

const [fileCountRaw, directoryCountRaw, concurrencyRaw] = process.argv.slice(2);
const fileCount = Number.parseInt(fileCountRaw ?? "20000", 10);
const directoryCount = Number.parseInt(directoryCountRaw ?? "400", 10);
const concurrency = Number.parseInt(concurrencyRaw ?? "16", 10);
const filesPerDirectory = Math.max(1, Math.floor(fileCount / Math.max(1, directoryCount)));

function formatMilliseconds(value) {
  return `${value.toFixed(1)} ms`;
}

async function main() {
  const root = await mkdtemp(join(tmpdir(), "omp-undo-redo-bench-"));
  try {
    const storage = join(root, "storage");
    const workspace = join(root, "workspace");
    const store = new BlobStore(storage, { walkConcurrency: concurrency });
    const session = "0".repeat(64);
    const checkpoint = "c0ffee";

    const created = performance.now();
    let written = 0;
    for (let dir = 0; dir < directoryCount; dir += 1) {
      const directory = join(workspace, `d${dir}`);
      await mkdir(directory, { recursive: true });
      for (let file = 0; file < filesPerDirectory; file += 1) {
        await writeFile(join(directory, `f${file}.txt`), `content-${dir}-${file}\n`);
        written += 1;
      }
    }
    console.log(
      `created ${written} files in ${directoryCount} directories (${formatMilliseconds(
        performance.now() - created,
      )})`,
    );

    const coldStart = performance.now();
    const cold = await store.captureSnapshot(workspace, session, checkpoint, "before");
    if ("reason" in cold) throw new Error(`cold capture failed: ${cold.reason}`);
    console.log(
      `cold capture (read+hash+write blobs): ${formatMilliseconds(performance.now() - coldStart)}`,
    );

    const warmStart = performance.now();
    const warm = await store.captureSnapshot(workspace, session, checkpoint, "after");
    if ("reason" in warm) throw new Error(`warm capture failed: ${warm.reason}`);
    console.log(
      `warm capture (cache hit, no changes): ${formatMilliseconds(performance.now() - warmStart)}`,
    );
    if (warm.treeId !== cold.treeId) throw new Error("unchanged workspace produced a new treeId");

    const touch = join(workspace, "d0", "f0.txt");
    await writeFile(touch, `content-0-0-modified-${Date.now()}\n`);
    const incrementalStart = performance.now();
    const incremental = await store.captureSnapshot(workspace, session, checkpoint, "before");
    if ("reason" in incremental)
      throw new Error(`incremental capture failed: ${incremental.reason}`);
    console.log(
      `incremental capture (1 file changed): ${formatMilliseconds(
        performance.now() - incrementalStart,
      )}`,
    );

    console.log(`entries: ${cold.entries.length}, skipped: ${cold.skippedPaths.length}`);
    await store.shutdown();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
