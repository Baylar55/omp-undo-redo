import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

/** Incremental store-size ledger for blobs/ and trees/. One full scan
 *  establishes the baseline; afterwards, writes are tracked per hash and
 *  deletions subtract from the baseline, so `measure()` is O(1) after the
 *  first call without ever rescanning the store. */

export class StoreAccountant {
  private readonly rootDirectory: string;
  /** Exact on-disk bytes of blobs/ and trees/ at the last full scan, or null
   *  when no scan has happened in this process. Tree manifests are written
   *  under the store lock, but blobs may be written by a concurrent workspace
   *  walk outside it; a blob the scan misses (written after its directory was
   *  read) is cleared with the rest of the pending account, a bounded,
   *  self-healing underestimate. Cross-process files written between this
   *  process's scan and a later GC are not in either account, so their
   *  deletion drifts the estimate low by at most one file's bytes. */
  private storeBytesAtLastScan: number | null = null;
  private pendingBytes = 0;
  private readonly pendingWriteSizes = new Map<string, number>();

  constructor(rootDirectory: string) {
    this.rootDirectory = rootDirectory;
  }

  /** Records one written store file's bytes. The per-key map makes repeated
   *  writes of the same key (e.g. a re-written tree) replace, not add. */
  trackStoreWrite(key: string, size: number): void {
    const previous = this.pendingWriteSizes.get(key);
    if (previous !== undefined) {
      this.pendingBytes -= previous;
    }
    this.pendingWriteSizes.set(key, size);
    this.pendingBytes += size;
  }

  /** Removes one file's bytes from the in-process store-size estimate. The key
   *  distinguishes pending (written since the last scan) from scanned entries,
   *  so the estimate stays exact without ever rescanning the store. */
  async untrackStoreFile(path: string, key: string): Promise<void> {
    const pendingSize = this.pendingWriteSizes.get(key);
    if (pendingSize !== undefined) {
      this.pendingWriteSizes.delete(key);
      this.pendingBytes -= pendingSize;
      return;
    }
    if (this.storeBytesAtLastScan === null) return;
    try {
      this.storeBytesAtLastScan -= Math.min((await stat(path)).size, this.storeBytesAtLastScan);
    } catch {
      // The file is already gone; nothing to account for.
    }
  }

  async measure(): Promise<number> {
    if (this.storeBytesAtLastScan !== null) {
      return this.storeBytesAtLastScan + this.pendingBytes;
    }
    const totalBytes = await this.scanStoreBytes();
    this.storeBytesAtLastScan = totalBytes;
    this.pendingBytes = 0;
    this.pendingWriteSizes.clear();
    return totalBytes;
  }

  private async scanStoreBytes(): Promise<number> {
    let totalBytes = 0;
    const scanDir = async (directory: string): Promise<void> => {
      let children;
      try {
        children = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        const fullPath = join(directory, child.name);
        if (child.isDirectory()) {
          await scanDir(fullPath);
        } else if (child.isFile() && !child.name.startsWith(".")) {
          try {
            const metadata = await stat(fullPath);
            totalBytes += metadata.size;
          } catch {
            // Ignore transient errors
          }
        }
      }
    };
    await scanDir(join(this.rootDirectory, "blobs"));
    await scanDir(join(this.rootDirectory, "trees"));
    return totalBytes;
  }
}
