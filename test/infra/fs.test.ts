import type * as FsPromises from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFileAtomic } from "../../src/infra/fs.js";

const { mockState } = vi.hoisted(() => ({ mockState: { renameFailures: 0 } }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    rename: vi.fn(async (from: string, to: string) => {
      if (mockState.renameFailures > 0) {
        mockState.renameFailures -= 1;
        throw Object.assign(new Error("EPERM: operation not permitted, rename"), {
          code: "EPERM",
        });
      }
      return actual.rename(from, to);
    }),
  };
});

describe("writeFileAtomic", () => {
  let directory: string | undefined;
  afterEach(async () => {
    mockState.renameFailures = 0;
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("lands the write when Windows refuses the rename for a moment", async () => {
    directory = await mkdtemp(join(tmpdir(), "omp-fs-"));
    const target = join(directory, "target.json");
    await writeFile(target, "old");
    mockState.renameFailures = 2;

    await writeFileAtomic(target, join(directory, ".target.json.tmp"), "new");

    expect(await readFile(target, "utf8")).toBe("new");
    expect(await readdir(directory)).toEqual(["target.json"]);
  });
});
