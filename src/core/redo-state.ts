import type { SessionReader } from "./types.js";

export interface RedoState {
  schemaVersion: 1;
  targets: string[];
  currentLeafId: string | null;
}

export function createRedoState(): RedoState {
  return { schemaVersion: 1, targets: [], currentLeafId: null };
}

export function invalidateRedo(state: RedoState): void {
  state.targets = [];
  state.currentLeafId = null;
}

export function validateRedoState(state: unknown, reader: SessionReader): state is RedoState {
  if (!state || typeof state !== "object") return false;
  const candidate = state as Partial<RedoState>;
  return (
    candidate.schemaVersion === 1 &&
    Array.isArray(candidate.targets) &&
    candidate.targets.every(
      (target) => typeof target === "string" && reader.getEntry(target) !== undefined,
    ) &&
    (candidate.currentLeafId === null || typeof candidate.currentLeafId === "string")
  );
}
