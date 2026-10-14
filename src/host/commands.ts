import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type { AnyContext } from "../host-contract.js";
import type { SessionNavigation } from "../session/navigation.js";
import type { SessionRegistry } from "../session/registry.js";
import type { ActionId, CommandNavigationResult, NavigationResult } from "../types.js";
import {
  VERBS,
  commandBlockedMessage,
  listed,
  notRestoredMessage,
  restoredFilesMessage,
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

export function registerCommands(pi: ExtensionAPI, registry: SessionRegistry): void {
  const makeHandler = (id: ActionId) => async (_args: string, ctx: ExtensionCommandContext) => {
    const token = randomUUID();
    const typed = ctx as unknown as AnyContext;
    const prepared = await registry.commandNavigation(typed, () => ctx.waitForIdle());
    if (prepared.status !== "ready") {
      ctx.ui.notify(commandBlockedMessage(id, prepared.status), "warning");
      return;
    }
    const nav = prepared.navigation;
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
