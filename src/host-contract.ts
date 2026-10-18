import type { SessionEntryLike } from "./types.js";

export type AnyContext = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getBranch(fromId?: string): SessionEntryLike[];
    getEntry(id: string): SessionEntryLike | undefined;
  };
  ui?: {
    notify(message: string, level: string): void;
  };
  /** Set by OMP 18.3.2+; hosts that don't set it (Pi included) read as the main agent. */
  agent?: { kind: "main" | "sub" };
};

export const DEFAULT_CAPTURE_DEADLINE_MS = 3_000;

export const DEFAULT_TOOL_CALL_DEADLINE_MS = 25_000;

export const DEFAULT_FINALIZE_DEADLINE_MS = 25_000;

/** `session_shutdown`'s own deadline. OMP caps the handler at 2 s and then
 *  exits; the margin covers the fallback lease removal. */
export const SHUTDOWN_BUDGET_MS = 1_500;

/** How long shutdown waits for in-flight captures and finalizes, within
 *  SHUTDOWN_BUDGET_MS: the checkpoint releases before this wait and the
 *  owner-lease check after it need the rest. */
export const SHUTDOWN_TURN_DRAIN_MS = 1_000;

/** `customType` of the entry a host appends when a session exits; the
 *  effective leaf skips it. */
export const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

// Hosts (OMP, Pi) never leave the leaf on a user or custom_message entry:
// they land on its parent and move the text to the editor. Accepting the
// parent for any custom_message covers hosts that exempt skill prompts
// (those land on the target, which is accepted too).
export function landsOnParent(target: SessionEntryLike | undefined): target is SessionEntryLike {
  return (
    target !== undefined &&
    ((target.type === "message" && target.message?.role === "user") ||
      target.type === "custom_message")
  );
}
