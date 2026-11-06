import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { AnyContext } from "../host-contract.js";
import { track } from "../infra/async.js";
import type { SessionRegistry } from "../session/registry.js";
import type { ExtensionServices } from "../session/services.js";

/** The only place that subscribes to host events. */
export function registerEvents(
  pi: ExtensionAPI,
  services: ExtensionServices,
  registry: SessionRegistry,
): void {
  pi.on("session_start", (_event, ctx) =>
    track(() => registry.sessionStart(ctx), services.activeOperations),
  );

  // A turn held open for a continuation ends at the leaf being left.
  const settle = (_event: unknown, ctx: AnyContext) =>
    track(() => registry.settleContinuation(ctx), services.activeOperations);
  pi.on("session_before_tree", settle);
  pi.on("session_tree", (event, ctx) =>
    track(() => registry.sessionTree(ctx, event), services.activeOperations),
  );

  const leaveSession = (event: unknown, ctx: AnyContext) => {
    registry.rememberNavigationSource(event, ctx);
    return settle(event, ctx);
  };
  const adoptSwitchedSession = (_event: unknown, ctx: AnyContext) =>
    track(() => registry.adoptSwitchedSession(ctx), services.activeOperations);
  pi.on("session_before_switch", leaveSession);
  pi.on("session_switch", adoptSwitchedSession);
  pi.on("session_before_branch", leaveSession);
  pi.on("session_branch", adoptSwitchedSession);

  pi.on("before_agent_start", (_event, ctx) =>
    track(() => registry.beforeAgentStart(ctx), services.activeOperations),
  );

  pi.on("agent_start", registry.agentStart);

  // Every tool (built-in, custom, MCP, subagent) passes through the host's
  // `tool_call` gate before executing. Returning undefined never blocks it.
  pi.on("tool_call", (_event, ctx) => registry.toolCall(ctx));

  // `willContinue`: the host already scheduled a retry or continuation, which
  // is not a settle; the turn stays open for its edits.
  pi.on("agent_end", (event, ctx) =>
    track(() => registry.agentEnd(ctx, event.willContinue === true), services.activeOperations),
  );

  pi.on("session_shutdown", () => registry.shutdown());
}
