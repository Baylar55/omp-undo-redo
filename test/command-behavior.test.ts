import { describe, expect, it } from "vitest";
import { SessionNavigation } from "../src/core/session-navigation.js";
import type { GitCheckpoint, GitRunner, NavigationPort } from "../src/core/types.js";

function mockGit(): GitRunner {
  return async () => ({ stdout: "", stderr: "", code: 0 });
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
      value.leaf = targetId;
      return { cancelled: false };
    },
  };
  return value;
}

function checkpoint(parentLeafId: string | null, leafId: string): GitCheckpoint {
  return {
    baseHash: "base",
    beforeHash: `before-${leafId}`,
    afterHash: `after-${leafId}`,
    parentLeafId,
    leafId,
  };
}

function makeNavigation(
  session: NavigationPort & { leaf: string; navigateCalls: string[] },
): SessionNavigation {
  return new SessionNavigation(session, mockGit());
}

describe("session navigation", () => {
  it("supports repeated undo and redo", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    navigation.recordTurnEnd(checkpoint("u2", "a2"));

    expect(await navigation.undo()).toBe("moved");
    expect(session.leaf).toBe("u2");
    expect(await navigation.undo()).toBe("moved");
    expect(session.leaf).toBe("u1");
    expect(await navigation.undo()).toBe("empty");

    expect(await navigation.redo()).toBe("moved");
    expect(session.leaf).toBe("a1");
    expect(await navigation.redo()).toBe("moved");
    expect(session.leaf).toBe("a2");
    expect(await navigation.redo()).toBe("empty");
  });

  it("clears forward checkpoints on a new branch", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    navigation.recordTurnEnd(checkpoint("u2", "a2"));
    await navigation.undo();
    navigation.recordTurnEnd(checkpoint("u1", "new-branch"));
    expect(await navigation.redo()).toBe("empty");
  });

  it("rejects cancelled navigation", async () => {
    const session = port();
    session.navigateTree = async () => ({ cancelled: true });
    const navigation = makeNavigation(session);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    expect(await navigation.undo()).toBe("cancelled");
  });

  it("reports Git restore failures", async () => {
    const session = port();
    const failingGit: GitRunner = async () => ({ stdout: "", stderr: "fatal", code: 128 });
    const navigation = new SessionNavigation(session, failingGit);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    expect(await navigation.undo()).toBe("git_failed");
  });
});
