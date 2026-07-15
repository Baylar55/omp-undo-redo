import { describe, expect, it } from "vitest";
import { isValidTarget, previousCheckpoint } from "../src/core/checkpoints.js";
import type { SessionEntryLike, SessionReader } from "../src/core/types.js";

function reader(entries: SessionEntryLike[], leafId: string | null): SessionReader {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId,
    getEntry: (id) => byId.get(id),
    getBranch: (fromId) => {
      const result: SessionEntryLike[] = [];
      let current = fromId ? byId.get(fromId) : undefined;
      while (current) {
        result.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return result;
    },
  };
}

const entries: SessionEntryLike[] = [
  { id: "u1", parentId: null, type: "message", message: { role: "user" } },
  { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
  { id: "u2", parentId: "a1", type: "message", message: { role: "user" } },
  { id: "a2", parentId: "u2", type: "message", message: { role: "assistant" } },
];

describe("checkpoint selection", () => {
  it("returns no target at the first interaction", () => {
    expect(previousCheckpoint(reader(entries.slice(0, 2), "a1"))).toBeNull();
  });

  it("selects the previous completed interaction", () => {
    expect(previousCheckpoint(reader(entries, "a2"))).toBe("a1");
    expect(isValidTarget(reader(entries, "a1"), "a1")).toBe(true);
    expect(isValidTarget(reader(entries, "a1"), "missing")).toBe(false);
  });
});
