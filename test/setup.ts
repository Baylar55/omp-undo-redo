import { rm } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, vi } from "vitest";

// Node's homedir() reads HOME (USERPROFILE on Windows) on every call; Bun's
// ignores runtime changes, so vi.stubEnv("HOME") would not reach src under Bun.
vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof NodeOs>();
  const homedir = () =>
    process.env[process.platform === "win32" ? "USERPROFILE" : "HOME"] || os.homedir();
  return { ...os, homedir, default: { ...os, homedir } };
});

// Every Git workspace gets a snapshot store under the store root, which
// defaults to ~/.omp. Suites that do not pick their own root share a temp one.
if (!process.env.OMP_UNDO_REDO_STORE_DIR) {
  const storeRoot = join(tmpdir(), `omp-undo-redo-test-store-${process.pid}`);
  process.env.OMP_UNDO_REDO_STORE_DIR = storeRoot;
  // Detached sweeps may still hold it open on Windows; a leftover temp dir is harmless.
  afterAll(() => rm(storeRoot, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}));
}

// Runtime action state defaults to ~/.omp too: without this, every test
// worker leaves a runtime/<pid>/ dir of fixture sessions in the user's home.
if (!process.env.OMP_UNDO_REDO_RUNTIME_DIR) {
  const runtimeRoot = join(tmpdir(), `omp-undo-redo-test-runtime-${process.pid}`);
  process.env.OMP_UNDO_REDO_RUNTIME_DIR = runtimeRoot;
  afterAll(() => rm(runtimeRoot, { recursive: true, force: true, maxRetries: 10 }).catch(() => {}));
}

// Snapshot index leases live in %TEMP%/omp-undo-redo-index-* until
// session_shutdown, which most suites never emit. Each test file runs in its
// own worker process, so its leases are all released here. Imported late:
// a static import would load index-leases.js before a suite's vi.mock applies.
afterAll(async () => {
  const { releaseAllPersistentSnapshotIndices } = await import("../src/snapshot/index-leases.js");
  await releaseAllPersistentSnapshotIndices();
});
