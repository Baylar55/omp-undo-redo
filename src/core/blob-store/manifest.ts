import { readFile } from "node:fs/promises";
import { comparePaths, isHash, sha256, treePathFor, validPath } from "./fs.js";
import type { TreeEntry, TreeManifest } from "./types.js";

/** Tree-manifest codec: canonical serialization, deterministic ordering, and
 *  strict validation of manifests read back from disk. */

export function sortCanonical(entries: TreeEntry[], skippedPaths: string[]): void {
  entries.sort((left, right) => comparePaths(left.path, right.path));
  skippedPaths.sort(comparePaths);
}

export function canonicalManifest(
  entries: readonly TreeEntry[],
  skippedPaths: readonly string[],
): string {
  // Pure serializer of the exact order given. Producers (captureSnapshot) must pre-sort
  // via sortCanonical so the SHA-256 treeId is deterministic. readTreeManifest
  // intentionally does NOT re-sort: it must reproduce the exact on-disk order that was
  // hashed at write time (newer snapshots used comparePaths, older ones localeCompare),
  // otherwise the stored treeId wouldn't match and existing snapshots would be rejected.
  return JSON.stringify({ entries, skippedPaths });
}

export function manifestFileContent(manifest: TreeManifest, canonical: string): string {
  return `{"treeId":${JSON.stringify(manifest.treeId)},${canonical.slice(1)}`;
}

/** Loads and strictly validates the manifest stored for `treeId` under the
 *  store's trees/ directory. Returns null for anything that fails the treeId
 *  hash check, duplicates, path validity, or case-folded collisions —
 *  callers treat that as "the tree does not exist". */
export async function readTreeManifest(
  storeRoot: string,
  treeId: string,
): Promise<TreeManifest | null> {
  if (!isHash(treeId)) return null;
  try {
    const value = JSON.parse(await readFile(treePathFor(storeRoot, treeId), "utf8")) as unknown;
    if (!value || typeof value !== "object") return null;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.treeId !== treeId ||
      !Array.isArray(candidate.entries) ||
      !Array.isArray(candidate.skippedPaths)
    )
      return null;
    const entries: TreeEntry[] = [];
    const paths = new Set<string>();
    for (const entry of candidate.entries) {
      if (!entry || typeof entry !== "object") return null;
      const item = entry as Record<string, unknown>;
      if (
        typeof item.path !== "string" ||
        !isHash(item.blobHash) ||
        !Number.isInteger(item.mode) ||
        Number(item.mode) < 0 ||
        Number(item.mode) > 0o777 ||
        !validPath(item.path) ||
        paths.has(item.path)
      )
        return null;
      paths.add(item.path);
      entries.push({ path: item.path, blobHash: item.blobHash, mode: Number(item.mode) });
    }
    const skippedPaths = candidate.skippedPaths.filter(
      (path): path is string => typeof path === "string",
    );
    if (
      skippedPaths.length !== candidate.skippedPaths.length ||
      !skippedPaths.every((path) => validPath(path)) ||
      sha256(canonicalManifest(entries, skippedPaths)) !== treeId
    )
      return null;
    const folded = new Set<string>();
    for (const path of paths) {
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      if (folded.has(key)) return null;
      folded.add(key);
      const parts = path.split("/");
      for (let index = 1; index < parts.length; index++) {
        if (paths.has(parts.slice(0, index).join("/"))) return null;
      }
    }
    return { treeId, entries, skippedPaths };
  } catch {
    return null;
  }
}
