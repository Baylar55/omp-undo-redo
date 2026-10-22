import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";

/** Canonical (long-form, symlink-resolved) absolute path. Sync because the
 *  callers that key the store by it are sync, and `fs/promises` has no
 *  `realpath.native` — the native form is what the 8.3 short-path fixes on
 *  Windows depend on. */
export function canonicalCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    // The path may not exist yet (e.g., a fresh store root like
    // `C:\Users\BAYLAR~1.SAD\Temp\new-store` where only the parent exists).
    // Fall back to canonicalizing the nearest existing ancestor and re-appending
    // the remainder, so a short-form parent still yields a long-form result.
    let current = resolve(cwd);
    const suffix: string[] = [];
    while (true) {
      try {
        const canonical = realpathSync.native(current);
        return suffix.length ? join(canonical, ...suffix.reverse()) : canonical;
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(cwd);
        suffix.push(basename(current));
        current = parent;
      }
    }
  }
}

/** `path` relative to `root`, `/`-separated, when it lies strictly inside
 *  `root`; null otherwise. Both are canonicalized first, so a short-form or
 *  symlinked spelling of either still matches. */
export function pathInside(root: string, path: string): string | null {
  const rel = relative(canonicalCwd(root), canonicalCwd(path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.replace(/\\/g, "/");
}

function basenameIsRuntime(value: string): boolean {
  return value.endsWith(`${sep}runtime`) || value.endsWith("/runtime");
}

export function defaultStoreRoot(): string {
  return canonicalCwd(join(homedir(), ".omp", "omp-undo-redo"));
}

export function storeRootDirectory(): string {
  const explicit = process.env.OMP_UNDO_REDO_STORE_DIR ?? process.env.OMP_UNDO_REDO_BLOB_DIR;
  if (explicit) return canonicalCwd(explicit);
  if (process.env.OMP_UNDO_REDO_RUNTIME_DIR) {
    const runtime = resolve(process.env.OMP_UNDO_REDO_RUNTIME_DIR);
    return canonicalCwd(basenameIsRuntime(runtime) ? dirname(runtime) : runtime);
  }
  return defaultStoreRoot();
}

export function defaultRuntimeRoot(): string {
  return resolve(join(homedir(), ".omp", "omp-undo-redo", "runtime"));
}

export function runtimeRootDirectory(
  rootDirectory = process.env.OMP_UNDO_REDO_RUNTIME_DIR,
): string {
  return rootDirectory === undefined ? defaultRuntimeRoot() : resolve(rootDirectory);
}

export function checkpointNamespace(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}
