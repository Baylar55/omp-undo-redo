import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRunner } from "../../src/infra/git-runner.js";
import { storeEnv } from "../../src/store/git-store.js";
import { pinStoreObjects } from "../../src/store/pinning.js";
import type { GitCommandResult, GitRepository, GitRunner, GitRunOptions } from "../../src/types.js";
import { git, gitRepository, makeRepository, rmRetry } from "../helpers/index.js";

const TIMEOUT_MS = 60_000;

let cwd: string;
let repository: GitRepository;
let storeGit: GitRunner;
let packDir: string;

/** Commits the worktree's current content as a parentless snapshot that only
 *  the store's ref `name` reaches, the shape of a reset-away checkpoint. */
async function snapshot(name: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  const tree = await git(cwd, ["write-tree"]);
  const commit = await git(cwd, ["commit-tree", tree, "-m", name]);
  await git(cwd, ["reset", "-q"]);
  await storeGit(["update-ref", `refs/test/${name}`, commit]);
  return commit;
}

/** Ids of the objects `pack` holds. */
async function packedObjects(pack: string): Promise<string[]> {
  const listing = await git(cwd, ["verify-pack", "-v", join(packDir, pack)]);
  return listing
    .split("\n")
    .filter((line) => /^[0-9a-f]{40} /.test(line))
    .map((line) => line.slice(0, 40))
    .sort();
}

/** `storeGit` with every `rev-list` result swapped by `rewrite`. */
function revListVia(
  rewrite: (args: string[], options: GitRunOptions | undefined) => Promise<GitCommandResult>,
): GitRunner {
  return (args, options) =>
    args[0] === "rev-list" ? rewrite(args, options) : storeGit(args, options);
}

beforeEach(async () => {
  cwd = await makeRepository("omp-undo-redo-pinning-");
  repository = await gitRepository(cwd);
  storeGit = createGitRunner(tmpdir(), { env: storeEnv(repository) });
  packDir = join(repository.storeDir, "objects", "pack");
  await mkdir(join(cwd, "dir"));
  await writeFile(join(cwd, "tracked.txt"), "draft\n");
  await writeFile(join(cwd, "dir", "one.txt"), "one\n");
  await writeFile(join(cwd, "dir", "two.txt"), "two\n");
});

afterEach(async () => {
  await rmRetry(cwd);
});

describe("pinStoreObjects", () => {
  it("pins every listed object when rev-list output arrives split mid-line", async () => {
    await snapshot("draft");
    // Real rev-list output, handed on in 7-character pieces.
    const chunked = revListVia((args, options) =>
      storeGit(args, {
        ...options,
        onStdout: (chunk) => {
          for (let at = 0; at < chunk.length; at += 7) options?.onStdout?.(chunk.slice(at, at + 7));
        },
      }),
    );

    await pinStoreObjects(chunked, repository, TIMEOUT_MS);

    const keeps = (await readdir(packDir)).filter((name) => name.endsWith(".keep"));
    expect(keeps).toHaveLength(1);
    const head = await git(cwd, ["rev-parse", "HEAD"]);
    const listed = await storeGit([
      "rev-list",
      "--objects",
      "--objects-edge-aggressive",
      "--all",
      "--not",
      head,
    ]);
    const expected = listed.stdout
      .split("\n")
      .filter((line) => line && !line.startsWith("-"))
      .map((line) => line.slice(0, 40))
      .sort();
    expect(expected).toHaveLength(6); // commit, root tree, dir tree, 3 blobs
    expect(await packedObjects(keeps[0]!.replace(/\.keep$/, ".idx"))).toEqual(expected);
  });

  it("keeps the previous pins and writes no pack when rev-list fails after listing", async () => {
    await snapshot("first");
    await pinStoreObjects(storeGit, repository, TIMEOUT_MS);
    const before = (await readdir(packDir)).sort();
    expect(before.filter((name) => name.endsWith(".keep"))).toHaveLength(1);
    await writeFile(join(cwd, "dir", "three.txt"), "three\n");
    await snapshot("second");
    // A full valid list reaches pack-objects; only then does rev-list fail.
    const failing = revListVia(async (args, options) => ({
      ...(await storeGit(args, options)),
      code: 1,
    }));

    await pinStoreObjects(failing, repository, TIMEOUT_MS);

    expect((await readdir(packDir)).sort()).toEqual(before);
  });

  it("drops the previous pins without an empty pack once nothing needs pinning", async () => {
    await snapshot("draft");
    await pinStoreObjects(storeGit, repository, TIMEOUT_MS);
    const pinned = (await readdir(packDir)).sort();
    await storeGit(["update-ref", "-d", "refs/test/draft"]);

    await pinStoreObjects(storeGit, repository, TIMEOUT_MS);

    expect((await readdir(packDir)).sort()).toEqual(
      pinned.filter((name) => !name.endsWith(".keep")),
    );
  });
});
