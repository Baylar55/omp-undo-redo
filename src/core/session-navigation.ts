import {
  invalidateRedo,
  validateRedoState,
  type RedoState,
  createRedoState,
} from "./redo-state.js";
import { isValidTarget, previousCheckpoint } from "./checkpoints.js";
import type { NavigationPort } from "./types.js";

export type NavigationOutcome = "moved" | "empty" | "invalid" | "cancelled";

export class SessionNavigation {
  readonly redoState: RedoState;

  constructor(
    private readonly port: NavigationPort,
    state: unknown = createRedoState(),
  ) {
    this.redoState = validateRedoState(state, port) ? state : createRedoState();
  }

  invalidateIfDiverged(): void {
    if (
      this.redoState.targets.length > 0 &&
      this.port.getLeafId() !== this.redoState.currentLeafId
    ) {
      invalidateRedo(this.redoState);
    }
  }

  async undo(): Promise<NavigationOutcome> {
    const currentLeafId = this.port.getLeafId();
    const targetId = previousCheckpoint(this.port);
    if (!currentLeafId || !targetId) return "empty";
    if (!isValidTarget(this.port, targetId)) return "invalid";
    const result = await this.port.navigateTree(targetId);
    if (result.cancelled) return "cancelled";
    this.redoState.targets.push(currentLeafId);
    this.redoState.currentLeafId = this.port.getLeafId();
    return "moved";
  }

  async redo(): Promise<NavigationOutcome> {
    this.invalidateIfDiverged();
    const targetId = this.redoState.targets.at(-1);
    if (!targetId || this.port.getLeafId() !== this.redoState.currentLeafId) return "empty";
    if (!isValidTarget(this.port, targetId)) {
      invalidateRedo(this.redoState);
      return "invalid";
    }
    const result = await this.port.navigateTree(targetId);
    if (result.cancelled) return "cancelled";
    this.redoState.targets.pop();
    this.redoState.currentLeafId = this.port.getLeafId();
    return "moved";
  }
}
