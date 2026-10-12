import type { NavigationState, SessionEntryLike, SessionReader, TurnCheckpoint } from "../types.js";
import { SESSION_EXIT_CUSTOM_TYPE } from "../host-contract.js";

export function entryExists(reader: SessionReader, id: string | null): boolean {
  return id === null || reader.getEntry(id) !== undefined;
}

function isSessionExitEntry(entry: SessionEntryLike | undefined): boolean {
  return entry?.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE;
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

/** Rebuilds the branch ending at `leafId` (null: the empty session). */
export function reconstructSessionHistory(
  reader: SessionReader,
  leafId: string | null = reader.getLeafId(),
): NavigationState {
  const branch = (leafId === null ? [] : reader.getBranch(leafId)).filter(
    (entry) => !isSessionExitEntry(entry),
  );
  const checkpoints: TurnCheckpoint[] = [];
  for (let index = 0; index < branch.length; index++) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message?.role !== "user") continue;
    let leafIndex = index;
    while (
      leafIndex + 1 < branch.length &&
      !(branch[leafIndex + 1].type === "message" && branch[leafIndex + 1].message?.role === "user")
    ) {
      leafIndex++;
    }
    if (leafIndex === index) continue;
    checkpoints.push({
      kind: "session",
      reason: "resumed_checkpoint_unavailable",
      parentLeafId: entry.id,
      leafId: branch[leafIndex].id,
    });
    index = leafIndex;
  }
  return { checkpoints, currentIndex: checkpoints.length - 1 };
}
