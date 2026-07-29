import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  checkpointNamespace,
  finishAfterTurn,
  prepareBeforeTurn,
  previousCheckpoint,
  releaseCheckpoint,
  restoreCheckpoint,
} from "../src/core/checkpoints.js";
import type { GitRunner, SessionEntryLike, SessionReader } from "../src/core/types.js";

const execFileAsync = promisify(execFile);

function reader(entries: SessionEntryLike[], leafId: string | null): SessionReader {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getLeafId: () => leafId,
    getEntry: (id) => byId.get(id),
    getBranch: (fromId) => {
      const result: SessionEntryLike[] = [];
      let current = fromId ? byId.get(fromId) : undefined;
      while (current) {
        result.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return result;
    },
  };
}

const entries: SessionEntryLike[] = [
  { id: "u1", parentId: null, type: "message", message: { role: "user" } },
  { id: "a1", parentId: "u1", type: "message", message: { role: "assistant" } },
  { id: "u2", parentId: "a1", type: "message", message: { role: "user" } },
  { id: "a2", parentId: "u2", type: "message", message: { role: "assistant" } },
];

describe("previousCheckpoint", () => {
  it("selects the first prompt boundary so the first interaction is undoable", () => {
    expect(previousCheckpoint(reader(entries.slice(0, 2), "a1"))).toBe("u1");
    expect(previousCheckpoint(reader(entries.slice(0, 1), "u1"))).toBeNull();
  });

  it("selects the latest prompt boundary", () => {
    expect(previousCheckpoint(reader(entries, "a2"))).toBe("u2");
  });
});

describe("checkpoint namespaces", () => {
  it("hashes session IDs and keeps refs in the private namespace", () => {
    const namespace = checkpointNamespace("session/raw id");
    expect(namespace).toMatch(/^[0-9a-f]{64}$/);
    expect(namespace).not.toContain("session");
  });
});

describe("protected Git checkpoints", () => {
  it("keeps active checkpoints reachable after reflog expiry and aggressive GC", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "omp-undo-redo-"));
    const git: GitRunner = async (args) => {
      try {
        const result = await execFileAsync("git", args, { cwd });
        return { stdout: result.stdout, stderr: result.stderr, code: 0 };
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: number };
        return {
          stdout: failure.stdout ?? "",
          stderr: failure.stderr ?? "",
          code: failure.code ?? 1,
        };
      }
    };
    try {
      await git(["init", "-q"]);
      await git(["config", "user.name", "test"]);
      await git(["config", "user.email", "test@example.com"]);
      await git(["config", "core.autocrlf", "false"]);
      await writeFile(join(cwd, "tracked.txt"), "base\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "base"]);
      await writeFile(join(cwd, "tracked.txt"), "before\n");
      await writeFile(join(cwd, "deleted.txt"), "remove\n");
      await git(["add", "."]);
      await git(["commit", "-qm", "setup"]);
      await git(["reset", "--mixed", "HEAD^"]);
      await writeFile(join(cwd, "untracked.txt"), "before-only\n");

      const before = await prepareBeforeTurn(git, "session/raw id");
      expect(before).not.toBeNull();
      if (!before) return;
      await writeFile(join(cwd, "tracked.txt"), "after\n");
      await writeFile(join(cwd, "untracked.txt"), "after-only\n");
      const checkpoint = await finishAfterTurn(git, before, null, null);
      expect(checkpoint).not.toBeNull();
      if (!checkpoint) return;
      expect((await git(["rev-parse", `${checkpoint.beforeRef}^{commit}`])).stdout.trim()).toBe(
        checkpoint.beforeHash,
      );
      expect((await git(["rev-parse", `${checkpoint.afterRef}^{commit}`])).stdout.trim()).toBe(
        checkpoint.afterHash,
      );
      await git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
      await git(["gc", "--prune=now"]);
      expect((await git(["cat-file", "-e", `${checkpoint.beforeHash}^{commit}`])).code).toBe(0);
      expect((await git(["cat-file", "-e", `${checkpoint.afterHash}^{commit}`])).code).toBe(0);

      expect(await restoreCheckpoint(git, checkpoint, checkpoint.beforeHash)).toBe(true);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("before\n");
      expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("before-only\n");
      expect(await restoreCheckpoint(git, checkpoint, checkpoint.afterHash)).toBe(true);
      expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("after\n");
      expect(await readFile(join(cwd, "untracked.txt"), "utf8")).toBe("after-only\n");
      expect(await releaseCheckpoint(git, checkpoint)).toBe(true);
      await git(["reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all"]);
      await git(["gc", "--prune=now"]);
      expect((await git(["cat-file", "-e", `${checkpoint.beforeHash}^{commit}`])).code).not.toBe(0);
      expect((await git(["cat-file", "-e", `${checkpoint.afterHash}^{commit}`])).code).not.toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
