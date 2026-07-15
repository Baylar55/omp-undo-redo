import { describe, expect, it } from "vitest";
import { createRedoState, invalidateRedo, validateRedoState } from "../src/core/redo-state.js";
import type { SessionReader } from "../src/core/types.js";

const reader: SessionReader = {
  getLeafId: () => "a",
  getEntry: (id) => (id === "a" ? { id, parentId: null, type: "message" } : undefined),
  getBranch: () => [{ id: "a", parentId: null, type: "message" }],
};

describe("redo state", () => {
  it("validates schema and targets", () => {
    expect(
      validateRedoState({ schemaVersion: 1, targets: ["a"], currentLeafId: "a" }, reader),
    ).toBe(true);
    expect(validateRedoState({ schemaVersion: 2, targets: [], currentLeafId: null }, reader)).toBe(
      false,
    );
    expect(
      validateRedoState({ schemaVersion: 1, targets: ["missing"], currentLeafId: null }, reader),
    ).toBe(false);
  });

  it("invalidates state", () => {
    const state = createRedoState();
    state.targets.push("a");
    state.currentLeafId = "a";
    invalidateRedo(state);
    expect(state).toEqual({ schemaVersion: 1, targets: [], currentLeafId: null });
  });
});
