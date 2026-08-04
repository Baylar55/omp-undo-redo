import type { NavigationState, SessionEntryLike, SessionReader } from "./types.js";

export function entryExists(reader: SessionReader, id: string | null): boolean {
  return id === null || reader.getEntry(id) !== undefined;
}

export function isSessionExitEntry(entry: SessionEntryLike | undefined): boolean {
  return entry?.type === "custom" && entry.customType === "session_exit";
}

export function effectiveLeaf(reader: SessionReader): string | null {
  let leafId = reader.getLeafId();
  const visited = new Set<string>();
  while (leafId && !visited.has(leafId)) {
    visited.add(leafId);
    const entry = reader.getEntry(leafId);
    if (!isSessionExitEntry(entry)) return leafId;
    leafId = entry?.parentId ?? null;
  }
  return leafId;
}

export function expectedLeaf(state: NavigationState): string | null {
  if (state.checkpoints.length === 0) return null;
  return state.currentIndex >= 0
    ? state.checkpoints[state.currentIndex].leafId
    : state.checkpoints[0].parentLeafId;
}
