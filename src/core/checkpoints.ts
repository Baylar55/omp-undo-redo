import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GitRunner, SessionReader, SnapshotStore, WorkspaceSnapshot } from "./types.js";

async function changedPaths(git: GitRunner, baseline: string | null): Promise<string[] | null> {
  const trackedArgs = baseline
    ? ["diff", "--name-only", "-z", baseline]
    : ["diff", "--name-only", "-z", "HEAD"];
  const [tracked, untracked] = await Promise.all([
    git(trackedArgs),
    git(["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  if (tracked.code !== 0 || untracked.code !== 0) return null;
  return [...tracked.stdout, ...untracked.stdout]
    .join("")
    .split("\0")
    .map((value) => value.trim())
    .filter(Boolean);
}

function cloneSnapshot(files: Map<string, string | null>): WorkspaceSnapshot {
  return { files: Object.fromEntries([...files].map(([file, content]) => [file, content])) };
}

export function createSnapshotStore(git: GitRunner, cwd: string): SnapshotStore {
  const knownPaths = new Set<string>();
  let baseline: string | null = null;

  return {
    async capture() {
      if (!baseline) {
        const head = await git(["rev-parse", "HEAD"]);
        if (head.code !== 0) return null;
        baseline = head.stdout.trim();
      }
      const paths = await changedPaths(git, baseline);
      if (!paths) return null;
      for (const file of paths) knownPaths.add(file);
      const files = new Map<string, string | null>();
      for (const file of knownPaths) {
        try {
          files.set(file, (await readFile(path.join(cwd, file))).toString("base64"));
        } catch {
          files.set(file, null);
        }
      }
      return cloneSnapshot(files);
    },
    async restore(snapshot) {
      const current = await changedPaths(git, baseline);
      if (!current) return false;
      const paths = new Set([...knownPaths, ...current, ...Object.keys(snapshot.files)]);
      try {
        for (const file of paths) {
          const target = snapshot.files[file] ?? null;
          const absolute = path.join(cwd, file);
          if (target === null) {
            await rm(absolute, { force: true });
          } else {
            await writeFile(absolute, Buffer.from(target, "base64"));
          }
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function previousCheckpoint(ctx: SessionReader): string | null {
  const leafId = ctx.getLeafId();
  if (!leafId) return null;
  const entries = ctx.getBranch(leafId);
  const currentIndex = entries.findIndex((e) => e.id === leafId);
  for (let i = currentIndex - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === "message" && entry.message?.role === "user") {
      return entry.id;
    }
  }
  return null;
}
