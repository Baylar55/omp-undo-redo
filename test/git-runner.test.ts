import { EventEmitter } from "node:events";
import type { spawn as Spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitRunner } from "../src/core/git-runner.js";

async function runnerInTempRepo() {
  const cwd = await mkdtemp(join(tmpdir(), "omp-runner-test-"));
  const git = createGitRunner(cwd);
  await git(["init", "-q"]);
  return git;
}

class FakeGitChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly signals: string[] = [];

  kill(signal = "SIGTERM"): boolean {
    this.signals.push(signal);
    return true;
  }
}

function runnerWithChild(child: FakeGitChild, terminationGraceMs = 50) {
  const spawnGit = (() => child) as unknown as typeof Spawn;
  return createGitRunner(".", { spawnGit, terminationGraceMs });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Git runner", () => {
  it("preserves ordinary Git failures", async () => {
    const git = await runnerInTempRepo();
    const result = await git(["show-ref", "--verify", "refs/heads/missing"]);
    expect(result.code).not.toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("settles stdin commands after Git closes", async () => {
    const git = await runnerInTempRepo();
    const result = await git(["update-ref", "--stdin"], {
      stdin: "start\n",
      timeoutMs: 1_000,
    });
    expect(result.code).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it("waits for close after timeout and force-kills after the grace period", async () => {
    vi.useFakeTimers();
    const child = new FakeGitChild();
    const resultPromise = runnerWithChild(child)(["update-ref", "--stdin"], {
      stdin: "start\n",
      timeoutMs: 100,
    });
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(50);
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(settled).toBe(false);

    child.emit("close", null);
    await expect(resultPromise).resolves.toMatchObject({ code: 1, error: "timeout" });
  });

  it("does not force-kill when close arrives during the grace period", async () => {
    vi.useFakeTimers();
    const child = new FakeGitChild();
    const resultPromise = runnerWithChild(child)(["update-ref", "--stdin"], {
      stdin: "",
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(50);

    expect(child.signals).toEqual(["SIGTERM"]);
    await expect(resultPromise).resolves.toMatchObject({ code: 0, error: "timeout" });
  });

  it("settles once when error and close race after timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeGitChild();
    const resultPromise = runnerWithChild(child)(["update-ref", "--stdin"], {
      stdin: "",
      timeoutMs: 100,
    });
    const observer = vi.fn();
    void resultPromise.then(observer);

    await vi.advanceTimersByTimeAsync(100);
    child.emit("error", new Error("terminated"));
    child.emit("close", 1);
    await resultPromise;

    expect(observer).toHaveBeenCalledTimes(1);
    await expect(resultPromise).resolves.toMatchObject({ error: "timeout" });
  });

  it("classifies synchronous spawn failure as unavailable", async () => {
    const spawnGit = (() => {
      throw new Error("missing");
    }) as unknown as typeof Spawn;
    const git = createGitRunner(".", { spawnGit });

    await expect(git(["update-ref", "--stdin"], { stdin: "" })).resolves.toMatchObject({
      code: 1,
      error: "unavailable",
    });
  });
});
