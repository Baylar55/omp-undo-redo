import { rename, rm, writeFile } from "node:fs/promises";

/** Write so readers never observe a partial file: write `temporary`, then
 *  rename it over `path`. Throws on failure; the temp never leaks. */
export async function writeFileAtomic(
  path: string,
  temporary: string,
  contents: string,
): Promise<void> {
  try {
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
