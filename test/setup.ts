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
