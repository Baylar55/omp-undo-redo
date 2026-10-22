import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitRunner } from "../../src/infra/git-runner.js";
import { finishAfterTurn, prepareBeforeTurn } from "../../src/snapshot/capture.js";
import { defaultPool } from "../../src/snapshot/index-leases.js";
import { applyCheckpoint } from "../../src/snapshot/restore.js";
import { createSnapshotCommit } from "../../src/snapshot/tree.js";
import { ownedPathsInWorktree, snapshotRunnerEnv } from "../../src/store/git-store.js";
import { git, gitRepository } from "../helpers/index.js";

// A home directory that is a Git repository puts the store root inside the
// worktree. The glob characters check the pathspecs are literal.
const STORE = "st[1]";

afterEach(() => vi.unstubAllEnvs());

/** A repository whose store lands inside it: `layout` points the store/runtime
 *  env vars at `cwd`. */
async function storeInsideRepository(layout: (cwd: string) => void) {
  const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-store-in-repo-"));
  await git(cwd, ["init", "-q"]);
  await git(cwd, ["config", "user.name", "test"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "core.autocrlf", "false"]);
  await writeFile(join(cwd, "a.txt"), "base\n");
  await git(cwd, ["add", "."]);
  await git(cwd, ["commit", "-qm", "base"]);
  layout(cwd);
  const repository = await gitRepository(cwd);
  const snap = createGitRunner(repository.worktree, { env: snapshotRunnerEnv(repository) });
  const ownedPaths = ownedPathsInWorktree(repository);
  const exists = async (hash: string) => (await snap(["cat-file", "-e", hash])).code === 0;
  const ownedEntries = async (hash: string) => {
    const tree = await snap(["ls-tree", "-r", "-z", "--name-only", hash]);
    expect(tree.code).toBe(0);
    return tree.stdout
      .split("\0")
      .filter((path) => ownedPaths.some((owned) => path.startsWith(`${owned}/`))).length;
  };
  const snapshot = async (message: string, paths: readonly string[]) => {
    const result = await createSnapshotCommit(snap, message, false, repository.gitDir, paths);
    if (!("hash" in result)) throw new Error(`${message}: ${result.reason}`);
    const ref = await snap(["update-ref", `refs/test/${message}`, result.hash], {
      env: { GIT_DIR: repository.storeDir },
    });
    expect(ref.code).toBe(0);
    return result.hash;
  };
  return { cwd, repository, snap, ownedPaths, exists, ownedEntries, snapshot };
}

const storeRootInside = (cwd: string) => vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", join(cwd, STORE));

const applied = (restoredFiles: string[]) => ({
  status: "applied",
  nestedRepositories: [],
  unreadableFiles: [],
  restoredFiles,
});

describe("store inside the worktree", () => {
  it.each([
    ["the store root is inside it", storeRootInside, [STORE, `${STORE}/repos`]],
    [
      "the store root is the worktree itself",
      (cwd: string) => {
        vi.stubEnv("OMP_UNDO_REDO_STORE_DIR", undefined);
        vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", join(cwd, "runtime"));
      },
      ["repos", "runtime"],
    ],
  ])(
    "is left out of every snapshot when %s, so undo and redo keep it intact",
    async (_, layout, expected) => {
      const { cwd, repository, snap, ownedPaths, exists, ownedEntries } =
        await storeInsideRepository(layout);
      expect(ownedPaths).toEqual(expected);
      // Three turns: the first seeds a fresh index, later ones reuse its lease.
      let last;
      for (let turn = 0; turn < 3; turn++) {
        const before = await prepareBeforeTurn(snap, "store", defaultPool, undefined, repository);
        if (before.status !== "git") throw new Error(before.reason);
        await writeFile(join(cwd, "a.txt"), `turn ${turn}\n`);
        const after = await finishAfterTurn(snap, before.checkpoint, null, null, defaultPool);
        if (after.status !== "git") throw new Error(after.reason);
        last = after.checkpoint;
        expect(await ownedEntries(last.beforeHash)).toBe(0);
        expect(await ownedEntries(last.afterHash!)).toBe(0);
      }
      expect(
        await applyCheckpoint(snap, last!.afterHash!, last!.beforeHash, false, ownedPaths),
      ).toEqual(applied(["a.txt"]));
      expect(await exists(last!.beforeHash)).toBe(true);
      expect(
        await applyCheckpoint(snap, last!.beforeHash, last!.afterHash!, false, ownedPaths),
      ).toEqual(applied(["a.txt"]));
    },
    60_000,
  );

  it("drops store entries a HEAD that tracks the store would seed", async () => {
    const { cwd, ownedEntries, snapshot, ownedPaths } =
      await storeInsideRepository(storeRootInside);
    await git(cwd, ["add", "-A"]);
    await git(cwd, ["commit", "-qm", "commit the store"]);
    expect(await git(cwd, ["ls-files", "--", `:(literal)${STORE}`])).not.toBe("");
    expect(await ownedEntries(await snapshot("tracked", ownedPaths))).toBe(0);
  }, 60_000);

  it("pins the store paths that snapshots of earlier versions hold", async () => {
    const { cwd, snap, ownedPaths, exists, ownedEntries, snapshot } =
      await storeInsideRepository(storeRootInside);
    // No owned paths: captured the way earlier versions did, store included.
    const before = await snapshot("before", []);
    await writeFile(join(cwd, "a.txt"), "changed\n");
    const after = await snapshot("after", []);
    expect(await ownedEntries(after)).toBeGreaterThan(await ownedEntries(before));

    expect((await applyCheckpoint(snap, after, before, true, ownedPaths)).status).toBe("applied");
    expect(await applyCheckpoint(snap, after, before, false, ownedPaths)).toEqual(
      applied(["a.txt"]),
    );
    expect(await exists(before)).toBe(true);
    expect(await exists(after)).toBe(true);

    // An old snapshot restored against a store-free one.
    const fresh = await snapshot("fresh", ownedPaths);
    expect(await ownedEntries(fresh)).toBe(0);
    expect(await applyCheckpoint(snap, before, fresh, false, ownedPaths)).toEqual(applied([]));
    expect(await applyCheckpoint(snap, fresh, after, false, ownedPaths)).toEqual(
      applied(["a.txt"]),
    );
    expect(await exists(after)).toBe(true);
  }, 60_000);
});
