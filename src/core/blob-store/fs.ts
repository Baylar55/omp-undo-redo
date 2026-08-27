import { createHash, randomUUID } from "node:crypto";
import { createReadStream, realpath as realpathCb, realpathSync } from "node:fs";
import { chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const realpathNative = promisify(realpathCb.native);

/** Filesystem, hashing, and path/id-guard primitives shared by the blob
 *  store's internal modules. Everything here is stateless. */

export function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes `content` to `path` via a same-directory temporary file and an
 *  atomic rename, so readers never observe a torn file. */
export async function atomicWrite(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function chmodSafe(path: string, mode: number): Promise<void> {
  try {
    await chmod(path, mode & 0o777);
  } catch {
    // Windows and filesystems without POSIX modes are allowed to ignore mode restoration.
  }
}

export function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function safeId(value: string): boolean {
  return /^[0-9a-fA-F-]{1,128}$/.test(value);
}

/** True for store-internal relative paths: no NUL, no backslash, not
 *  absolute, no drive prefix, and no empty/./.. segments. */
export function validPath(value: string): boolean {
  if (
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    isAbsolute(value) ||
    /^[A-Za-z]:/.test(value)
  )
    return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

/** On-disk store layout, shared by every module that must compute store
 *  paths itself: blobs are sharded by the first two hash characters. */
export function blobPathFor(storeRoot: string, hash: string): string {
  return join(storeRoot, "blobs", hash.slice(0, 2), hash.slice(2));
}

export function treePathFor(storeRoot: string, treeId: string): string {
  return join(storeRoot, "trees", `${treeId}.json`);
}

export function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Number of "/"-separated segments in a store path; sorting descending by
 *  depth lets removals process children before their parents. */
export function depth(value: string): number {
  let count = 1;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 47) count++; // "/"
  }
  return count;
}

export function canonicalPathSync(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    let current = resolve(path);
    const suffix: string[] = [];
    while (true) {
      try {
        const canonical = realpathSync.native(current);
        return suffix.length ? join(canonical, ...suffix.reverse()) : canonical;
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(path);
        suffix.push(basename(current));
        current = parent;
      }
    }
  }
}

export async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpathNative(path);
  } catch {
    let current = resolve(path);
    const suffix: string[] = [];
    while (true) {
      try {
        const canonical = await realpathNative(current);
        return suffix.length ? join(canonical, ...suffix.reverse()) : canonical;
      } catch {
        const parent = dirname(current);
        if (parent === current) return resolve(path);
        suffix.push(basename(current));
        current = parent;
      }
    }
  }
}
