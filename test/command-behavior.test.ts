import { SessionNavigation } from "../src/core/session-navigation.js";
import { describe, expect, it } from "vitest";
import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  NavigationPort,
  SessionOnlyCheckpoint,
} from "../src/core/types.js";

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
  const repository: GitRepository = {
    worktree: ".",
    gitDir: ".git",
    commonDir: ".git",
  };
  return {
    kind: "git",
    repository,
    beforeHash: `before-${leafId}`,
    beforeRef: `refs/omp-undo-redo/test/${leafId}/before`,
    afterHash: `after-${leafId}`,
    afterRef: `refs/omp-undo-redo/test/${leafId}/after`,
    parentLeafId,
    leafId,
  };
}

function sessionCheckpoint(parentLeafId: string | null, leafId: string): SessionOnlyCheckpoint {
  return {
    kind: "session",
    reason: "not_repository",
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

    expect((await navigation.undo()).status).toBe("moved");
    expect(session.leaf).toBe("u2");
    expect((await navigation.undo()).status).toBe("moved");
    expect(session.leaf).toBe("u1");
    expect((await navigation.undo()).status).toBe("empty");

    expect((await navigation.redo()).status).toBe("moved");
    expect(session.leaf).toBe("a1");
    expect((await navigation.redo()).status).toBe("moved");
    expect(session.leaf).toBe("a2");
    expect((await navigation.redo()).status).toBe("empty");
  });

  it("preserves redo for matching internal tree navigation", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    navigation.setNavigateTree(async (targetId) => {
      const oldLeafId = session.leaf;
      session.navigateCalls.push(targetId);
      session.leaf = targetId;
      await navigation.handleSessionTreeNavigation(oldLeafId, targetId);
      return { cancelled: false };
    });
    await navigation.recordTurnEnd(checkpoint("u1", "a1"));
    await navigation.recordTurnEnd(checkpoint("u2", "a2"));

    expect((await navigation.undo()).status).toBe("moved");
    expect((await navigation.redo()).status).toBe("moved");
    expect((await navigation.redo()).status).toBe("empty");
  });

  it("invalidates only redo after unrelated tree navigation", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    await navigation.recordTurnEnd(checkpoint("u1", "a1"));
    await navigation.recordTurnEnd(checkpoint("u2", "a2"));
    expect((await navigation.undo()).status).toBe("moved");

    await navigation.handleSessionTreeNavigation("u2", "other");

    expect((await navigation.redo()).status).toBe("empty");
    expect(session.navigateCalls).toEqual(["u2"]);
    expect((await navigation.undo()).status).toBe("moved");
    expect(session.navigateCalls).toEqual(["u2", "u1"]);
  });

  it("treats same-leaf tree events as no-ops", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    await navigation.recordTurnEnd(checkpoint("u1", "a1"));
    await navigation.recordTurnEnd(checkpoint("u2", "a2"));
    expect((await navigation.undo()).status).toBe("moved");

    await navigation.handleSessionTreeNavigation("u2", "u2");

    expect((await navigation.redo()).status).toBe("moved");
  });

  it("clears an expected transition after cancelled navigation", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    await navigation.recordTurnEnd(checkpoint("u1", "a1"));
    await navigation.recordTurnEnd(checkpoint("u2", "a2"));
    expect((await navigation.undo()).status).toBe("moved");
    navigation.setNavigateTree(async () => ({ cancelled: true }));

    expect((await navigation.redo()).status).toBe("cancelled");
    await navigation.handleSessionTreeNavigation("u2", "a2");

    expect((await navigation.redo()).status).toBe("empty");
  });

  it("clears forward checkpoints on a new branch", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    navigation.recordTurnEnd(checkpoint("u2", "a2"));
    await navigation.undo();
    navigation.recordTurnEnd(checkpoint("u1", "new-branch"));
    expect((await navigation.redo()).status).toBe("empty");
  });

  it("rejects cancelled navigation", async () => {
    const session = port();
    session.navigateTree = async () => ({ cancelled: true });
    const navigation = makeNavigation(session);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    expect((await navigation.undo()).status).toBe("cancelled");
    expect((await navigation.redo()).status).toBe("empty");
  });

  it("reports Git restore failures", async () => {
    const session = port();
    const failingGit: GitRunner = async () => ({ stdout: "", stderr: "fatal", code: 128 });
    const navigation = new SessionNavigation(session, failingGit);
    navigation.recordTurnEnd(checkpoint("u1", "a1"));
    expect((await navigation.undo()).status).toBe("git_failed");
  });
  it("supports repeated session-only undo and redo", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    await navigation.recordTurnEnd(sessionCheckpoint("u1", "a1"));
    await navigation.recordTurnEnd(sessionCheckpoint("u2", "a2"));

    expect(await navigation.undo()).toEqual({
      status: "moved",
      files: "unavailable",
      reason: "not_repository",
    });
    expect(await navigation.undo()).toEqual({
      status: "moved",
      files: "unavailable",
      reason: "not_repository",
    });
    expect(await navigation.redo()).toEqual({
      status: "moved",
      files: "unavailable",
      reason: "not_repository",
    });
    expect(await navigation.redo()).toEqual({
      status: "moved",
      files: "unavailable",
      reason: "not_repository",
    });
  });

  it("processes mixed Git and session-only history in order", async () => {
    const session = port();
    const navigation = makeNavigation(session);
    await navigation.recordTurnEnd(checkpoint("u1", "a1"));
    await navigation.recordTurnEnd(sessionCheckpoint("a1", "a2"));

    expect((await navigation.undo()).files).toBe("unavailable");
    expect((await navigation.undo()).files).toBe("restored");
    expect((await navigation.redo()).files).toBe("restored");
    expect((await navigation.redo()).files).toBe("unavailable");
  });

  it("does not move the history index when session navigation is cancelled", async () => {
    const session = port();
    session.navigateTree = async () => ({ cancelled: true });
    const navigation = makeNavigation(session);
    await navigation.recordTurnEnd(sessionCheckpoint("u1", "a1"));

    expect((await navigation.undo()).status).toBe("cancelled");
    navigation.setNavigateTree(async () => ({ cancelled: false }));
    expect((await navigation.undo()).status).toBe("moved");
  });

  it("does not call Git while disposing session-only entries", async () => {
    let calls = 0;
    const git: GitRunner = async () => {
      calls++;
      return { stdout: "", stderr: "", code: 0 };
    };
    const navigation = new SessionNavigation(port(), git);
    await navigation.recordTurnEnd(sessionCheckpoint("u1", "a1"));
    await navigation.dispose();
    expect(calls).toBe(0);
  });
});
