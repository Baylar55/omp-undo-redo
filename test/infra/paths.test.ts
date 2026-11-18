import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntimeRoot, runtimeRootDirectory } from "../../src/infra/paths.js";

describe("runtimeRootDirectory", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("treats an empty OMP_UNDO_REDO_RUNTIME_DIR as unset, not as the cwd", () => {
    vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", "");
    expect(runtimeRootDirectory()).toBe(defaultRuntimeRoot());
  });
});
