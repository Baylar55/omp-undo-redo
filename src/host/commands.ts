import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { AnyContext } from "../host-contract.js";
import { timedOutAfter } from "../infra/async.js";
import { ensureNavigation } from "../session/controller.js";
import { isMainSession } from "../session/housekeeping.js";
import type { SessionNavigation } from "../session/navigation.js";
import type { SessionRegistry } from "../session/registry.js";
import type { ExtensionServices } from "../session/services.js";
import type { ActionId, CommandNavigationResult, NavigationResult } from "../types.js";
import {
  VERBS,
  closingUnavailableMessage,
  listed,
  notRestoredMessage,
  restoredFilesMessage,
  subagentUnavailableMessage,
  unavailableMessage,
} from "./messages.js";

export type NavigationDirection = "undo" | "redo";

export async function runNavigation(
  navigation: SessionNavigation,
  ctx: ExtensionCommandContext,
  direction: NavigationDirection,
): Promise<CommandNavigationResult> {
  const verbs = VERBS[direction];
  if (!ctx.isIdle()) {
    ctx.ui.notify(verbs.busy, "warning");
    return { status: "busy" };
  }

  const outcome: NavigationResult = await navigation[direction]();
  switch (outcome.status) {
    case "moved": {
      if (outcome.files === "unavailable") {
        ctx.ui.notify(
          `${verbs.movedUnavailablePrefix}${unavailableMessage(outcome.reason)}`,
          "info",
        );
      } else if (outcome.files === "partial") {
        ctx.ui.notify(
          `${verbs.movedPartialPrefix}${notRestoredMessage(outcome.nestedRepositories, outcome.unreadableFiles)}${restoredFilesMessage(outcome.restoredFiles)}`,
          "warning",
        );
      } else {
        ctx.ui.notify(
          `${verbs.movedSuccess}${restoredFilesMessage(outcome.restoredFiles)}`,
          "info",
        );
      }
      break;
    }
    case "empty":
      ctx.ui.notify(verbs.empty, "info");
      break;
    case "cancelled":
      ctx.ui.notify(verbs.cancelled, "warning");
      break;
    case "rollback_failed":
      ctx.ui.notify(verbs.rollbackFailed, "error");
      break;
    case "git_failed":
      ctx.ui.notify(
        outcome.failure === "conflict"
          ? `${verbs.conflict}${outcome.conflictedFiles.length > 0 ? ` Conflicting files: ${listed(outcome.conflictedFiles)}.` : ""}`
          : "Could not restore the Git checkpoint.",
        "warning",
      );
      break;
  }
  return outcome;
}

export function registerCommands(
  pi: ExtensionAPI,
  services: ExtensionServices,
  registry: SessionRegistry,
): void {
  const makeHandler = (id: ActionId) => async (_args: string, ctx: ExtensionCommandContext) => {
    const token = randomUUID();
    const typed = ctx as unknown as AnyContext;
    if (!isMainSession(services, typed)) {
      ctx.ui.notify(subagentUnavailableMessage(id), "warning");
      return;
    }
    const sessionId = typed.sessionManager.getSessionId();
    // Commands run even mid-stream: the turn's finalize only registers at
    // agent_end, so the guards below must be read after the idle wait.
    await ctx.waitForIdle();
    const state = services.sessions.get(sessionId);
    const guards: [Promise<unknown> | undefined, string][] = [
      [state?.capture?.complete, "the file checkpoint is still being captured"],
      [state?.finalize, "the last turn is still being finalized"],
    ];
    for (const [work, reason] of guards) {
      if (!work) continue;
      if (await timedOutAfter(work, services.captureDeadlineMs)) {
        ctx.ui.notify(`Cannot ${id} while ${reason}; try again shortly.`, "warning");
        return;
      }
    }
    const nav = await ensureNavigation(services, typed);
    if (!nav) {
      ctx.ui.notify(closingUnavailableMessage(id), "warning");
      return;
    }
    nav.setNavigateTree(ctx.navigateTree);
    const outcome = await runNavigation(nav, ctx, id);
    await registry.publishActionResult(
      typed.sessionManager.getSessionId(),
      nav,
      typed,
      id,
      token,
      outcome.status === "moved",
    );
  };

  pi.registerCommand("undo", {
    description: "Revert file changes and session context for the last turn",
    handler: makeHandler("undo"),
  });
  pi.registerCommand("redo", {
    description: "Restore the most recently undone turn",
    handler: makeHandler("redo"),
  });
}
