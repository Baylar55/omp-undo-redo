import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRunner } from "../../src/infra/git-runner.js";
import { storeEnv } from "../../src/store/git-store.js";
import { migrateLegacySnapshots } from "../../src/store/maintenance/legacy.js";
import type { GitCommandResult, GitRepository, GitRunner, GitRunOptions } from "../../src/types.js";
import { git, gitRepository, makeRepository, rmRetry } from "../helpers/index.js";

const LEGACY_REF = "refs/omp-undo-redo/draft";

let cwd: string;
let repository: GitRepository;
let userGit: GitRunner;
let storeGit: GitRunner;
let packDir: string;

/** Commits the worktree's current content as a parentless snapshot that only
 *  the legacy ref in the user's repository reaches, the pre-store layout. */
async function legacySnapshot(): Promise<string> {
  await git(cwd, ["add", "-A"]);
  const tree = await git(cwd, ["write-tree"]);
  const commit = await git(cwd, ["commit-tree", tree, "-m", "omp-undo-redo: before turn"]);
  await git(cwd, ["reset", "-q"]);
  await git(cwd, ["update-ref", LEGACY_REF, commit]);
  return commit;
}

/** `userGit` with every `rev-list` result swapped by `rewrite`. */
function revListVia(
  rewrite: (args: string[], options: GitRunOptions | undefined) => Promise<GitCommandResult>,
): GitRunner {
  return (args, options) =>
    args[0] === "rev-list" ? rewrite(args, options) : userGit(args, options);
}

const packs = async () => (await readdir(packDir)).filter((name) => name.endsWith(".idx")).sort();

beforeEach(async () => {
  cwd = await makeRepository("omp-undo-redo-legacy-");
  repository = await gitRepository(cwd);
  userGit = createGitRunner(cwd);
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

describe("migrateLegacySnapshots", () => {
  it("packs every object only legacy refs reach when rev-list output arrives split mid-line", async () => {
    const commit = await legacySnapshot();
    const expected = (
      await git(cwd, [
        "rev-list",
        "--objects",
        "--objects-edge-aggressive",
        commit,
        "--not",
        "HEAD",
      ])
    )
      .split("\n")
      .filter((line) => line && !line.startsWith("-"))
      .map((line) => line.slice(0, 40))
      .sort();
    expect(expected).toHaveLength(6); // commit, root tree, dir tree, 3 blobs
    const before = await packs();
    // Real rev-list output, handed on in 7-character pieces.
    const chunked = revListVia((args, options) =>
      userGit(args, {
        ...options,
        onStdout: (chunk) => {
          for (let at = 0; at < chunk.length; at += 7) options?.onStdout?.(chunk.slice(at, at + 7));
        },
      }),
    );

    await migrateLegacySnapshots(chunked, repository);

    expect(await git(cwd, ["for-each-ref", "refs/omp-undo-redo/"])).toBe("");
    expect((await storeGit(["rev-parse", LEGACY_REF])).stdout.trim()).toBe(commit);
    const added = (await packs()).filter((name) => !before.includes(name));
    expect(added).toHaveLength(1);
    const listing = await git(cwd, ["verify-pack", "-v", join(packDir, added[0]!)]);
    const packed = listing
      .split("\n")
      .filter((line) => /^[0-9a-f]{40} /.test(line))
      .map((line) => line.slice(0, 40))
      .sort();
    expect(packed).toEqual(expected);
  });

  it("keeps the snapshot through the user's prune when the runner buffers rev-list output", async () => {
    const commit = await legacySnapshot();
    // A runner may ignore `onStdout` and return everything in `stdout`.
    const buffering = revListVia((args, options) =>
      userGit(args, { ...options, onStdout: undefined }),
    );

    await migrateLegacySnapshots(buffering, repository);

    expect(await git(cwd, ["for-each-ref", "refs/omp-undo-redo/"])).toBe("");
    await git(cwd, ["reflog", "expire", "--expire=now", "--all"]);
    await git(cwd, ["gc", "-q", "--prune=now"]);
    await expect(git(cwd, ["cat-file", "-e", commit])).rejects.toThrow();
    // Walks every object the snapshot needs; fails on the first one missing.
    expect((await storeGit(["rev-list", "--objects", commit])).code).toBe(0);
  });

  it("moves nothing and writes no pack when rev-list fails after listing", async () => {
    const commit = await legacySnapshot();
    const before = (await readdir(packDir)).sort();
    // A full valid list reaches pack-objects; only then does rev-list fail.
    const failing = revListVia(async (args, options) => ({
      ...(await userGit(args, options)),
      code: 1,
    }));

    await migrateLegacySnapshots(failing, repository);

    expect(await git(cwd, ["rev-parse", LEGACY_REF])).toBe(commit);
    expect((await storeGit(["for-each-ref", "refs/omp-undo-redo/"])).stdout).toBe("");
    expect((await readdir(packDir)).sort()).toEqual(before);
  });
});
