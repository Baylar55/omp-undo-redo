import { describe, expect, it } from "vitest";
import { SessionNavigation } from "../src/core/session-navigation.js";
import type { NavigationPort, SnapshotStore, WorkspaceSnapshot } from "../src/core/types.js";

function snapshotStore(restoreResult = true): SnapshotStore {
  return {
    async capture() {
      return { files: {} };
    },
    async restore(_snapshot: WorkspaceSnapshot) {
      return restoreResult;
    },
  };
}

function port(): NavigationPort & { leaf: string; navigateCalls: string[] } {
  const raw: Record<
    string,
    { id: string; parentId: string | null; type: string; message?: { role?: string } }
  > = {};
  function add(id: string, parentId: string | null, role?: string) {
    raw[id] = { id, parentId, type: "message", ...(role ? { message: { role } } : {}) };
  }
  add("u1", null, "user");
  add("a1", "u1", "assistant");
  add("u2", "a1", "user");
  add("a2", "u2", "assistant");

  const value = {
    leaf: "a2",
    navigateCalls: [] as string[],
    getLeafId() {
      return value.leaf;
    },
    getEntry(id: string) {
      return raw[id];
    },
    getBranch(fromId?: string) {
      const result: Array<{
        id: string;
        parentId: string | null;
        type: string;
        message?: { role?: string };
      }> = [];
      let current = fromId ? raw[fromId] : undefined;
      while (current) {
        result.unshift(current);
        current = current.parentId ? raw[current.parentId] : undefined;
      }
      return result;
    },
    async navigateTree(targetId: string) {
      value.navigateCalls.push(targetId);
      const target = raw[targetId];
      value.leaf = target?.message?.role === "user" ? (target.parentId ?? "") : targetId;
      return { cancelled: false };
    },
  };
  return value;
}

function makeNavigation(
  session: NavigationPort & { leaf: string; navigateCalls: string[] },
): SessionNavigation {
  const nav = new SessionNavigation(session, snapshotStore());
  nav.setInitialCheckpoint({ files: {} });
  return nav;
}

describe("session navigation", () => {
  it("supports repeated undo and redo", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    // turn 1 ends with leaf "a1"
    session.leaf = "a1";
    await navigation.recordTurnEnd({ files: {} });
    // turn 2 ends with leaf "a2"
    session.leaf = "a2";
    await navigation.recordTurnEnd({ files: {} });

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
    const session = port();
    const navigation = makeNavigation(session);
    session.leaf = "a1";
    await navigation.recordTurnEnd({ files: {} });

    expect(await navigation.undo()).toBe("moved");
    expect(session.leaf).toBe("");
    expect(await navigation.redo()).toBe("moved");
    expect(session.leaf).toBe("a1");
  });

  it("clears forward checkpoints via recordTurnEnd", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    session.leaf = "a1";
    await navigation.recordTurnEnd({ files: {} });
    session.leaf = "a2";
    await navigation.recordTurnEnd({ files: {} });

    await navigation.undo();
    // recordTurnEnd with a new checkpoint clears forward checkpoints
    session.leaf = "new-branch";
    await navigation.recordTurnEnd({ files: {} });
    expect(await navigation.redo()).toBe("empty");
  });

  it("rejects cancelled navigation", async () => {
    const session = port();
    session.navigateTree = async () => ({ cancelled: true });
    const navigation = makeNavigation(session);
    session.leaf = "a1";
    await navigation.recordTurnEnd({ files: {} });

    expect(await navigation.undo()).toBe("cancelled");
  });

  it("reports a failed snapshot restore", async () => {
    const session = port();
    const navigation = new SessionNavigation(session, snapshotStore(false));
    navigation.setInitialCheckpoint({ files: {} });
    session.leaf = "a1";
    await navigation.recordTurnEnd({ files: {} });
    expect(await navigation.undo()).toBe("snapshot_failed");
  });
});
