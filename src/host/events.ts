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

  pi.on("session_tree", (event, ctx) =>
    track(() => registry.sessionTree(ctx, event), services.activeOperations),
  );

  const adoptSwitchedSession = (_event: unknown, ctx: AnyContext) =>
    track(() => registry.adoptSwitchedSession(ctx), services.activeOperations);
  pi.on("session_before_switch", registry.rememberNavigationSource);
  pi.on("session_switch", adoptSwitchedSession);
  pi.on("session_before_branch", registry.rememberNavigationSource);
  pi.on("session_branch", adoptSwitchedSession);

  pi.on("before_agent_start", (_event, ctx) =>
    track(() => registry.beforeAgentStart(ctx), services.activeOperations),
  );

  // Every tool (built-in, custom, MCP, subagent) passes through the host's
  // `tool_call` gate before executing. Returning undefined never blocks it.
  pi.on("tool_call", (_event, ctx) => registry.toolCall(ctx));

  pi.on("agent_end", (_event, ctx) =>
    track(() => registry.agentEnd(ctx), services.activeOperations),
  );

  pi.on("session_shutdown", () => registry.shutdown());
}
