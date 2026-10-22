import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { storeRootDirectory } from "./paths.js";

/** `OMP_UNDO_REDO_DEBUG=1`: appends `entry` (plus time and pid) to
 *  `<storeRoot>/debug.log` as one JSON line. Not under a snapshot store: the
 *  store's own setup is one of the failures worth logging. Synchronous, so a
 *  process that dies right after a failure still leaves its last lines, and
 *  lines keep their order; the cost is paid only while debugging. Every
 *  error is ignored: logging must never fail what it observes.
 *  ponytail: unbounded while enabled; add rotation if anyone leaves it on. */
export function debugLog(entry: Record<string, unknown>): void {
  if (process.env.OMP_UNDO_REDO_DEBUG !== "1") return;
  try {
    const root = storeRootDirectory();
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const line = { time: new Date().toISOString(), pid: process.pid, ...entry };
    appendFileSync(join(root, "debug.log"), `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch {
    // Diagnostics only.
  }
}
