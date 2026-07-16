import { describe, expect, it } from "vitest";
import { SessionNavigation } from "../src/core/session-navigation.js";
import type { NavigationPort } from "../src/core/types.js";

function port(initialLeaf = "a2"): NavigationPort & { leaf: string; navigateCalls: string[] } {
  const entries = new Map([
    ["u1", { id: "u1", parentId: null, type: "message", message: { role: "user" } }],
    ["a1", { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } }],
    ["u2", { id: "u2", parentId: "a1", type: "message", message: { role: "user" } }],
    ["a2", { id: "a2", parentId: "u2", type: "message", message: { role: "assistant" } }],
  ]);
  const value = {
    leaf: initialLeaf,
    navigateCalls: [] as string[],
    getLeafId() {
      return value.leaf;
    },
    getEntry(id: string) {
      return entries.get(id);
    },
    getBranch(fromId?: string) {
      const result = [] as typeof entries extends Map<string, infer V> ? V[] : never;
      let current = fromId ? entries.get(fromId) : undefined;
      while (current) {
        result.unshift(current);
        current = current.parentId ? entries.get(current.parentId) : undefined;
      }
      return result;
    },
    async navigateTree(targetId: string) {
      value.navigateCalls.push(targetId);
      const target = entries.get(targetId);
      value.leaf = target?.message?.role === "user" ? (target.parentId ?? "") : targetId;
      return { cancelled: false };
    },
  };
  return value;
}

describe("session navigation", () => {
  it("supports repeated undo and redo", async () => {
    const session = port();
    const navigation = new SessionNavigation(session);
    expect(await navigation.undo()).toBe("moved");
    expect(session.leaf).toBe("a1");
    expect(await navigation.undo()).toBe("moved");
    expect(session.leaf).toBe("");
    expect(await navigation.undo()).toBe("empty");
    expect(await navigation.redo()).toBe("moved");
    expect(session.leaf).toBe("a1");
    expect(await navigation.redo()).toBe("moved");
    expect(session.leaf).toBe("a2");
    expect(await navigation.redo()).toBe("empty");
  });

  it("supports undo and redo for a first interaction at the session root", async () => {
    const session = port("a1");
    const navigation = new SessionNavigation(session);
    expect(await navigation.undo()).toBe("moved");
    expect(session.leaf).toBe("");
    expect(await navigation.redo()).toBe("moved");
    expect(session.leaf).toBe("a1");
  });

  it("clears redo after divergent activity", async () => {
    const session = port();
    const navigation = new SessionNavigation(session);
    await navigation.undo();
    session.leaf = "new-branch";
    expect(await navigation.redo()).toBe("empty");
    expect(session.navigateCalls).toEqual(["u2"]);
  });

  it("rejects cancelled navigation and stale targets", async () => {
    const session = port();
    session.navigateTree = async () => ({ cancelled: true });
    const navigation = new SessionNavigation(session);
    expect(await navigation.undo()).toBe("cancelled");
    expect(navigation.redoState.targets).toEqual([]);
  });
});
