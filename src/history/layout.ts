import { join } from "node:path";
import type { GitRepository } from "../types.js";
import { checkpointNamespace } from "../infra/paths.js";
import { HASH } from "./codec.js";

export function historyDirectory(repository: GitRepository): string {
  return join(repository.storeDir, "omp-undo-redo", "history");
}

export function historyPath(repository: GitRepository, sessionId: string): string {
  return join(historyDirectory(repository), `${checkpointNamespace(sessionId)}.json`);
}

export function tombstonePath(repository: GitRepository, sessionIdOrHash: string): string {
  const sessionHash = HASH.test(sessionIdOrHash)
    ? sessionIdOrHash
    : checkpointNamespace(sessionIdOrHash);
  return join(historyDirectory(repository), `${sessionHash}.expired.json`);
}

/** Dot-prefixed: the expiry sweep skips it as a history file. */
export function restoreIntentPath(repository: GitRepository, sessionHash: string): string {
  return join(historyDirectory(repository), `.restore.${sessionHash}.json`);
}
