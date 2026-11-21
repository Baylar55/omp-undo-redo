import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalCwd,
  defaultRuntimeRoot,
  runtimeRootDirectory,
  storeRootDirectory,
} from "../../src/infra/paths.js";

describe("runtimeRootDirectory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats an empty OMP_UNDO_REDO_RUNTIME_DIR as unset, not as the cwd", () => {
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", "");
    expect(runtimeRootDirectory()).toBe(defaultRuntimeRoot());
  });
});

describe("storeRootDirectory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("falls through an empty OMP_UNDO_REDO_STORE_DIR to OMP_UNDO_REDO_BLOB_DIR", () => {
    const blobDir = join(tmpdir(), "omp-undo-redo-blob-alias");
    vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", "");
    vi.stubEnv("OMP_UNDO_REDO_BLOB_DIR", blobDir);
    expect(storeRootDirectory()).toBe(canonicalCwd(blobDir));
  });
});
