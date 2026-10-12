import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GitRepository, GitRunner } from "../types.js";
import { invoke } from "../infra/git-runner.js";
import { borrowsObjects, snapshotRunnerEnv } from "./git-store.js";

/** Copies into a Git-mode store every object of a snapshot that the store
 *  only borrows and the user's HEAD does not reach: content of a reset or
 *  amended commit, a blob staged and then dropped, an old version a file was
 *  reverted to. Those survive the user's `gc` only for its grace periods,
 *  and `reflog expire --expire=now` + `gc --prune=now` would break the
 *  snapshot at once. What HEAD reaches stays shared, so capture never copies
 *  the repository: a user who rewrites history and prunes it on purpose
 *  loses the checkpoints that need it, and restoring them reports a failure.
 *  An unborn HEAD reaches nothing: every staged blob the store lacks is
 *  copied (the index is where an unborn repository's snapshot content can
 *  already exist). A clean worktree costs one `diff-tree`; objects the
 *  capture itself wrote are loose in the store and cost a `stat` each.
 *  The store's own gc would drop these copies again while the user's
 *  repository still holds the object (prune deletes loose duplicates of any
 *  pack, alternates' included; `repack -l` skips borrowed objects), so every
 *  store gc first moves them into a kept pack (`pinStoreObjects`). */
export async function pinBorrowedObjects(
  git: GitRunner,
  repository: GitRepository,
  tree: string,
): Promise<boolean> {
  if (!borrowsObjects(repository)) return true;
  const env = snapshotRunnerEnv(repository);
  const changed = await invoke(
    git,
    ["diff-tree", "-r", "-t", "-z", "--no-renames", "--no-relative", "HEAD", tree, "--"],
    { env },
  );
  const candidates = new Set<string>();
  if (changed.code === 0) {
    // Raw records: ":<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0".
    const fields = changed.stdout.split("\0");
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const [, mode, , sha] = fields[index]!.slice(1).split(" ");
      if (mode !== "160000" && sha && !/^0+$/.test(sha)) candidates.add(sha);
    }
    // No difference means the snapshot is HEAD's own tree.
    if (candidates.size > 0) candidates.add(tree);
  } else {
    if (changed.error) return false;
    const head = await invoke(git, ["rev-parse", "--verify", "-q", "HEAD"], { env });
    if (head.code === 0 || head.error) return false;
    const staged = await invoke(git, ["ls-files", "-s", "-z"], { env });
    if (staged.code !== 0) return false;
    // Entries: "<mode> <object> <stage>\t<path>".
    for (const entry of staged.stdout.split("\0")) {
      const [mode, sha] = entry.split(" ");
      if (sha && mode !== "160000") candidates.add(sha);
    }
    candidates.add(tree);
  }
  const objects = join(repository.storeDir, "objects");
  const loose = await Promise.all(
    [...candidates].map((id) =>
      stat(join(objects, id.slice(0, 2), id.slice(2))).then(
        () => true,
        () => false,
      ),
    ),
  );
  const unknown = [...candidates].filter((_, index) => !loose[index]);
  if (unknown.length === 0) return true;
  // Without the alternates env only the store's own objects are visible.
  const local = await invoke(git, ["cat-file", "--batch-check=%(objectname)"], {
    env: { ...env, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" },
    stdin: `${unknown.join("\n")}\n`,
  });
  if (local.code !== 0) return false;
  const borrowed = local.stdout
    .split("\n")
    .filter((line) => line.endsWith(" missing"))
    .map((line) => line.slice(0, line.indexOf(" ")));
  if (borrowed.length === 0) return true;
  const packed = await invoke(git, ["pack-objects", "-q", join(objects, "pack", "pack")], {
    env,
    stdin: `${borrowed.join("\n")}\n`,
  });
  return packed.code === 0;
}

/** Content of the `.keep` file that marks a store's pins pack. */
const PINS_KEEP = "omp-undo-redo pins\n";

/** Runs right before a Git-mode store's prune and gc: packs every object the
 *  store's refs reach and the user's HEAD does not, borrowed ones included,
 *  into one pack kept from both (`.keep`), then unkeeps the previous pins
 *  pack so the same gc reclaims what no ref needs any more. Without it the
 *  gc would drop `pinBorrowedObjects`' copies (see there), and the user's
 *  `reflog expire --expire=now --all && gc --prune=now` would then break the
 *  snapshot. `--objects-edge-aggressive` also leaves out the blobs HEAD's
 *  tree holds: snapshot commits have no parent, so plain `--objects` would
 *  copy the whole checkout. An unborn HEAD reaches nothing, so everything is
 *  pinned. Any failure keeps the previous pins pack, so the gc then loses
 *  at most the copies made since. Private-Git stores borrow nothing.
 *  ponytail: no lock spans pinning and gc, so two processes maintaining one
 *  store at once can unkeep each other's pins pack, and a capture running
 *  meanwhile can lose its copy to this gc until the next maintenance
 *  re-pins it; only an aggressive user prune inside that gap loses data.
 *  Upgrade path: one store-wide lock file held across pin, prune and gc. */
export async function pinStoreObjects(
  git: GitRunner,
  repository: GitRepository,
  timeoutMs: number,
): Promise<void> {
  if (!borrowsObjects(repository)) return;
  const head = await invoke(git, ["rev-parse", "--verify", "-q", "HEAD"], {
    env: { GIT_DIR: repository.gitDir },
  });
  if (head.error) return;
  const headHash = head.code === 0 ? head.stdout.trim() : "";
  // A snapshot whose content the user already pruned stays broken; it must
  // not keep every other snapshot from being pinned.
  const listed = await invoke(
    git,
    [
      "rev-list",
      "--objects",
      "--objects-edge-aggressive",
      "--missing=allow-any",
      "--all",
      ...(headHash ? ["--not", headHash] : []),
    ],
    { timeoutMs },
  );
  if (listed.code !== 0 || listed.error) return;
  // Edges ("-<id>") are HEAD's commits, not objects to pin.
  const objects = listed.stdout.split("\n").filter((line) => line && !line.startsWith("-"));
  const packDir = join(repository.storeDir, "objects", "pack");
  let kept = "";
  if (objects.length > 0) {
    const packed = await invoke(git, ["pack-objects", "-q", join(packDir, "pack")], {
      stdin: `${objects.join("\n")}\n`,
      timeoutMs,
    });
    const hash = packed.stdout.trim();
    if (packed.code !== 0 || packed.error || !/^[0-9a-f]{40,64}$/.test(hash)) return;
    kept = `pack-${hash}.keep`;
    try {
      await writeFile(join(packDir, kept), PINS_KEEP);
    } catch {
      return;
    }
  }
  // Only after the new pack is kept. Unchanged pins rebuild the same pack.
  const names = await readdir(packDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.endsWith(".keep") || name === kept) continue;
    const path = join(packDir, name);
    if ((await readFile(path, "utf8").catch(() => "")) === PINS_KEEP) {
      await rm(path, { force: true }).catch(() => undefined);
    }
  }
}
