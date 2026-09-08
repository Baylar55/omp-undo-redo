import { describe, expect, it } from "vitest";
import { releaseRefs } from "../src/core/checkpoints.js";
import "../src/core/compat.js";

describe("Node compatibility", () => {
  it("provides Promise.withResolvers when missing or preserves native implementation", async () => {
    expect(typeof Promise.withResolvers).toBe("function");

    const { promise, resolve } = Promise.withResolvers<string>();
    resolve("compat-ok");
    await expect(promise).resolves.toBe("compat-ok");

    const failing = Promise.withResolvers<void>();
    failing.reject(new Error("compat-fail"));
    await expect(failing.promise).rejects.toThrow("compat-fail");
  });

  it("releases refs without Map.groupBy (Node 20 compatibility)", async () => {
    // Simulate Node 20 environment by temporarily deleting Map.groupBy
    const originalGroupBy = (Map as unknown as { groupBy?: unknown }).groupBy;
    delete (Map as unknown as { groupBy?: unknown }).groupBy;
    try {
      const git = async () => ({ stdout: "", stderr: "", code: 0 });
      git.cwd = ".";
      const repository = { worktree: ".", gitDir: ".git", commonDir: ".git" };
      const refs = [
        { repository, ref: "refs/omp-undo-redo/test1", expectedHash: "abc" },
        { repository, ref: "refs/omp-undo-redo/test2", expectedHash: "def" },
      ];
      const result = await releaseRefs(() => git, refs);
      expect(result).toBe(true);
    } finally {
      if (originalGroupBy !== undefined) {
        (Map as unknown as { groupBy?: unknown }).groupBy = originalGroupBy;
      }
    }
  });
});
