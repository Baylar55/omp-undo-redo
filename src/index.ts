import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { SessionEntryLike } from "./core/types.js";
import { runRedo } from "./commands/redo.js";
import { runUndo } from "./commands/undo.js";
import { SessionNavigation } from "./core/session-navigation.js";
import { createSnapshotStore } from "./core/checkpoints.js";
import type { SnapshotStore } from "./core/types.js";

type AnyContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(fromId?: string): SessionEntryLike[];
    getEntry(id: string): SessionEntryLike | undefined;
  };
};

function createGitRunner(pi: ExtensionAPI, cwd: string) {
  return async (args: string[]) => {
    const result = await pi.exec("git", args, { cwd });
    if (typeof result === "string") return { stdout: result, stderr: "", code: 0 };
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      code: typeof result.code === "number" ? result.code : 0,
    };
  };
}

function createNavigation(
  pi: ExtensionAPI,
  ctx: AnyContext,
  snapshots: SnapshotStore,
): SessionNavigation {
  const manager = ctx.sessionManager;
  const port = {
    getLeafId: () => manager.getLeafId(),
    getBranch: (fromId: string | undefined) => manager.getBranch(fromId),
    getEntry: (id: string) => manager.getEntry(id),
  };
  return new SessionNavigation(port, snapshots);
}

function createSnapshotStoreFor(pi: ExtensionAPI, ctx: AnyContext): SnapshotStore {
  return createSnapshotStore(createGitRunner(pi, ctx.cwd), ctx.cwd);
}

const navigations = new Map<string, SessionNavigation>();
const snapshots = new Map<string, SnapshotStore>();
const initialised = new Set<string>();

export default function ompUndoRedo(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const typed = ctx as unknown as AnyContext;
    const store = createSnapshotStoreFor(pi, typed);
    const nav = createNavigation(pi, typed, store);
    navigations.set(sessionId, nav);
    snapshots.set(sessionId, store);
    initialised.delete(sessionId);
    const initial = await store.capture();
    if (initial) {
      nav.setInitialCheckpoint(initial);
      initialised.add(sessionId);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const typed = ctx as unknown as AnyContext;
    let nav = navigations.get(sessionId);
    let store = snapshots.get(sessionId);
    if (!nav || !store) {
      store = createSnapshotStoreFor(pi, typed);
      nav = createNavigation(pi, typed, store);
      navigations.set(sessionId, nav);
      snapshots.set(sessionId, store);
    }
    const snapshot = await store.capture();
    if (!snapshot) return;
    if (!initialised.has(sessionId)) {
      nav.setInitialCheckpoint(snapshot);
      initialised.add(sessionId);
    } else {
      await nav.recordTurnEnd(snapshot);
    }
  });

  const undoHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const nav = navigations.get(sessionId);
    if (!nav) {
      ctx.ui.notify("Undo is unavailable until the first turn completes.", "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    await runUndo(nav, ctx);
  };

  const redoHandler = async (_args: string, ctx: ExtensionCommandContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    const nav = navigations.get(sessionId);
    if (!nav) {
      ctx.ui.notify("Redo is unavailable until the first turn completes.", "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    await runRedo(nav, ctx);
  };

  pi.registerCommand("undo", {
    description: "Revert file changes and session context for the last turn",
    handler: undoHandler,
  });
  pi.registerCommand("redo", {
    description: "Restore the most recently undone turn",
    handler: redoHandler,
  });
}
