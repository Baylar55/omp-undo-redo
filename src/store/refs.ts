import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GitRunner, GitRepository } from "../types.js";
import type { RefSpec } from "../infra/git-parse.js";
import { storeEnv } from "./git-store.js";

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
 *  busy and splitting only multiplies the wait. A held `packed-refs.lock`
 *  fails every deletion alike (each spawn waiting out git's lock timeout),
 *  so it skips the halving and hands every ref to `onSingleFailure` at once. */
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
  let sharedLock = false;
  try {
    // LC_ALL=C pins the lock message matched below.
    const result = await git(["update-ref", "--stdin"], {
      env: { ...options.env, LC_ALL: "C" },
      stdin: `${input}\n`,
      timeoutMs: options.timeoutMs,
    });
    if (result.code === 0) return "ok";
    if (result.error === "timeout") return "timeout";
    // A per-ref `<ref>.lock'` blocks only that ref, which halving isolates.
    sharedLock = /[\\/]packed-refs\.lock'/.test(result.stderr);
  } catch {
    // Fall through to halving.
  }
  if (refs.length === 1 || sharedLock) {
    const fallback = options.onSingleFailure;
    if (!fallback) return "failed";
    let released = true;
    for (const ref of refs) if (!(await fallback(ref))) released = false;
    return released ? "ok" : "failed";
  }
  const midpoint = Math.ceil(refs.length / 2);
  const left = await deleteRefsBatched(git, refs.slice(0, midpoint), options);
  if (left === "timeout") return "timeout";
  const right = await deleteRefsBatched(git, refs.slice(midpoint), options);
  if (right === "timeout") return "timeout";
  return left === "ok" && right === "ok" ? "ok" : "failed";
}

export const REF_ROOT = "refs/omp-undo-redo";

/** Single spelling of the retained-history ref namespace. Takes an
 *  already-hashed session (`checkpointNamespace(sessionId)`), never a raw id. */
export const HISTORY_REF_ROOT = `${REF_ROOT}/history/`;

export function historyRefPrefix(sessionHash: string): string {
  return `${HISTORY_REF_ROOT}${sessionHash}/`;
}

interface RefRelease {
  repository: GitRepository;
  ref: string;
  expectedHash: string;
}

export async function releaseLooseRef(
  repository: GitRepository,
  ref: string,
  expectedHash: string,
): Promise<boolean> {
  if (!ref.startsWith("refs/") || ref.includes("..")) return false;
  const path = join(repository.storeDir, ref);
  try {
    if ((await readFile(path, "utf8")).trim() !== expectedHash) return false;
    await rm(path, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function releaseRefs(
  gitForRepository: (repository: GitRepository) => GitRunner,
  refs: readonly RefRelease[],
): Promise<boolean> {
  const grouped = new Map<string, RefRelease[]>();
  for (const ref of refs) {
    const list = grouped.get(ref.repository.storeDir);
    if (list) list.push(ref);
    else grouped.set(ref.repository.storeDir, [ref]);
  }
  const results = await Promise.allSettled(
    [...grouped.values()].map(async (groupedRefs) => {
      // Each group has at least one ref, so the head carries the repository.
      const { repository } = groupedRefs[0];
      try {
        await markGcPending(repository.storeDir);
        const outcome = await deleteRefsBatched(gitForRepository(repository), groupedRefs, {
          env: storeEnv(repository),
          onSingleFailure: ({ ref, expectedHash }) =>
            releaseLooseRef(repository, ref, expectedHash),
        });
        return outcome === "ok";
      } catch {
        return false;
      }
    }),
  );
  return results.every((result) => result.status === "fulfilled" && result.value);
}
