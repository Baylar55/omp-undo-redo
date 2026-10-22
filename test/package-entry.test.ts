import { describe, expect, it } from "vitest";
import * as entry from "../src/index.js";
import extension from "../src/extension.js";
import { readRetentionDays } from "../src/history/retention.js";
import { resolveBackend } from "../src/store/backend.js";

describe("package entry", () => {
  it("keeps its public exports until the next major", () => {
    expect(entry.default).toBe(extension);
    // Deprecated, but public API until the next major.
    expect(entry.readRetentionDays).toBe(readRetentionDays);
    expect(entry.resolveBackend).toBe(resolveBackend);
    // Removed in 1.7.0.
    expect(entry).not.toHaveProperty("purgeLegacyBlobStore");
  });
});
