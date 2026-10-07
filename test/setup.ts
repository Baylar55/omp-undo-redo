import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

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
