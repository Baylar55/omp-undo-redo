import type { SessionEntryLike, SessionReader } from "./types.js";

export function isUserMessage(entry: SessionEntryLike): boolean {
  return entry.type === "message" && entry.message?.role === "user";
}

/** Return the user-prompt boundary before the latest assistant/tool activity. */
export function previousCheckpoint(reader: SessionReader): string | null {
  const leafId = reader.getLeafId();
  if (!leafId) return null;
  const branch = reader.getBranch(leafId);
  let latestUserIndex = -1;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (isUserMessage(branch[index])) {
      latestUserIndex = index;
      break;
    }
  }
  if (latestUserIndex < 0 || branch[latestUserIndex].id === leafId) return null;
  return branch[latestUserIndex].id;
}

export function isValidTarget(reader: SessionReader, targetId: string): boolean {
  if (!targetId || !reader.getEntry(targetId)) return false;
  const branch = reader.getBranch(targetId);
  return branch.length > 0 && branch.at(-1)?.id === targetId;
}
