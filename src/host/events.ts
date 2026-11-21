import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { isPiSessionStart, leavesSessionOnShutdown } from "../host-contract.js";
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
  pi.on("session_start", (event, ctx) => {
    // Every Pi copy gets its `session_start` before any run (host-contract.ts).
    if (isPiSessionStart(event)) services.flags.runsEndAtSettle = true;
    return track(() => registry.sessionStart(ctx), services.activeOperations);
  });

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
  // `session_switch` and `session_branch` are OMP's. Pi has only the
  // pre-events (`session_before_switch`, and `session_before_fork` for a
  // fork); after them it shuts this copy down and starts a new one.
  const adoptSwitchedSession = (_event: unknown, ctx: AnyContext) =>
    track(() => registry.adoptSwitchedSession(ctx), services.activeOperations);
  // OMP's types lack Pi's event names (OMP never emits them); the handler
  // shape is the same.
  const untypedPi = pi as unknown as { on(event: string, handler: typeof settle): void };
  const onPiOnly = (event: string, handler: typeof settle) => untypedPi.on(event, handler);
  pi.on("session_before_switch", leaveSession);
  pi.on("session_switch", adoptSwitchedSession);
  pi.on("session_before_branch", leaveSession);
  onPiOnly("session_before_fork", leaveSession);
  pi.on("session_branch", adoptSwitchedSession);

  pi.on("before_agent_start", (_event, ctx) =>
    track(() => registry.beforeAgentStart(ctx), services.activeOperations),
  );

  pi.on("agent_start", registry.agentStart);

  // Every tool (built-in, custom, MCP, subagent) passes through the host's
  // `tool_call` gate before executing. Returning undefined never blocks it.
  pi.on("tool_call", (_event, ctx) => registry.toolCall(ctx));

  // `willContinue` (OMP): the host already scheduled a retry or continuation,
  // which is not a settle; the turn stays open for its edits. Under Pi any
  // `agent_end` may be followed by one, so the turn always stays open.
  pi.on("agent_end", (event, ctx) =>
    track(
      () => registry.agentEnd(ctx, event.willContinue === true || services.flags.runsEndAtSettle),
      services.activeOperations,
    ),
  );
  // Pi 0.80.4+: the run is over. Ends the turn its last `agent_end` held; a
  // no-op otherwise. Pi aborts and waits for it before `session_shutdown`
  // (quit, switch, fork), so the turn is recorded before shutdown.
  // ponytail: older Pi never emits it; the next prompt, command or navigation
  // ends the held turn, but quitting first loses it (shutdown sets `closing`,
  // and the finalize then releases the checkpoint). Settling inside shutdown
  // needs room in its 1.5 s budget for the after-snapshot.
  onPiOnly("agent_settled", settle);

  pi.on("session_shutdown", (event) => registry.shutdown(leavesSessionOnShutdown(event)));
}
