import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitRunner } from "./types.js";

export type RefSpec = { ref: string; expectedHash: string };

/** Parses `for-each-ref --format=%(refname)%00%(objectname)` output. Null when
 *  a line does not hold exactly one NUL: a malformed listing must never be
 *  mistaken for "no refs are present". */
export function parseRefLines(stdout: string): RefSpec[] | null {
  const refs: RefSpec[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    if (separator < 0 || line.indexOf("\0", separator + 1) >= 0) return null;
    refs.push({ ref: line.slice(0, separator), expectedHash: line.slice(separator + 1) });
  }
  return refs;
}

/** Durable "this store holds garbage" flag. A deleted ref can orphan packed
 *  objects, which `git prune` never deletes: only a gc reclaims them, and
 *  every gc trigger lives in process memory, lost to an exit or a killed gc.
 *  The boot sweep gcs every store that carries it. */
export function gcPendingPath(storeDir: string): string {
  return join(storeDir, "omp-undo-redo", "gc-pending");
}

/** Marks `storeDir` before a store-ref deletion, so a crash between the
 *  deletion and its gc cannot drop the trigger. Best-effort: it never blocks
 *  the deletion, and never recreates a store removed meanwhile (no recursive
 *  mkdir). */
export async function markGcPending(storeDir: string): Promise<void> {
  try {
    const path = gcPendingPath(storeDir);
    await mkdir(dirname(path), { mode: 0o700 }).catch(() => undefined);
    await writeFile(path, "");
  } catch {
    // The deletion proceeds; a later trigger still gcs the store.
  }
}

/** Deletes refs in one `update-ref --stdin` batch, halving on failure so a
 *  single unexpected hash cannot block the rest. `onSingleFailure` receives
 *  refs that still fail alone — that is how a caller reaches a loose-ref
 *  unlink when git itself is unusable, so a throw falls through to halving
 *  rather than aborting. A timeout aborts the walk instead: the repository is
 *  busy and splitting only multiplies the wait. */
export async function deleteRefsBatched(
  git: GitRunner,
  refs: readonly RefSpec[],
  options: {
    env?: Record<string, string>;
    timeoutMs?: number;
    onSingleFailure?: (ref: RefSpec) => Promise<boolean>;
  } = {},
): Promise<"ok" | "failed" | "timeout"> {
  if (refs.length === 0) return "ok";
  const input = refs.map(({ ref, expectedHash }) => `delete ${ref} ${expectedHash}`).join("\n");
  try {
    const result = await git(["update-ref", "--stdin"], {
      env: options.env,
      stdin: `${input}\n`,
      timeoutMs: options.timeoutMs,
    });
    if (result.code === 0) return "ok";
    if (result.error === "timeout") return "timeout";
  } catch {
    // Fall through to halving.
  }
  if (refs.length === 1) {
    return options.onSingleFailure && (await options.onSingleFailure(refs[0])) ? "ok" : "failed";
  }
  const midpoint = Math.ceil(refs.length / 2);
  const left = await deleteRefsBatched(git, refs.slice(0, midpoint), options);
  if (left === "timeout") return "timeout";
  const right = await deleteRefsBatched(git, refs.slice(midpoint), options);
  if (right === "timeout") return "timeout";
  return left === "ok" && right === "ok" ? "ok" : "failed";
}
