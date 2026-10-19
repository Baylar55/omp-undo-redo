import "./compat.js";
import { rename, rm, writeFile, mkdir, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

/** Write so readers never observe a partial file: write `temporary`, then
 *  rename it over `path`. Throws on failure; the temp never leaks. */
export async function writeFileAtomic(
  path: string,
  temporary: string,
  contents: string,
): Promise<void> {
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Write JSON so readers never see a partial document. */
export async function writeJsonAtomic(
  directory: string,
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFileAtomic(
    path,
    join(directory, `.${basename(path)}.${randomUUID()}.tmp`),
    JSON.stringify(value),
  );
}

export async function writeExclusive(path: string, contents: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.close();
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    return false;
  }
}

/** Delay between repeated filesystem attempts, riding out short flaps such
 *  as a handle (a git child, an antivirus scan, a reader) that Windows holds
 *  open for a moment. */
export const RETRY_DELAY_MS = 200;

export async function removeDirWithRetry(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true });
      return true;
    } catch {
      if (attempt === 4) return false;
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, RETRY_DELAY_MS);
      await promise;
    }
  }
  return false;
}

/** Rename, retried while Windows refuses it because another handle (an
 *  antivirus scan, a reader) is open on `from`, on `to`, or inside them. */
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt === 4 || !(code === "EPERM" || code === "EACCES" || code === "EBUSY")) {
        throw error;
      }
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, RETRY_DELAY_MS);
      await promise;
    }
  }
}
