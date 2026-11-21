import { access, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import type * as Fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  activeHeartbeatPath,
  releaseSessionHeartbeat,
  sessionHeartbeatIsFresh,
  touchSessionHeartbeat,
} from "../../src/history/liveness.js";
import { localRuntimeScope } from "../../src/store/host-identity.js";

// Error codes injected into the module under test's stats, reads and writes.
const failing = vi.hoisted(() => ({ stat: "", read: "", write: "" }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  return {
    ...actual,
    stat: ((...args: Parameters<typeof actual.stat>) =>
      failing.stat ? fail(failing.stat) : actual.stat(...args)) as typeof actual.stat,
    readFile: ((...args: Parameters<typeof actual.readFile>) =>
      failing.read ? fail(failing.read) : actual.readFile(...args)) as typeof actual.readFile,
    writeFile: ((...args: Parameters<typeof actual.writeFile>) =>
      failing.write ? fail(failing.write) : actual.writeFile(...args)) as typeof actual.writeFile,
  };
});

const HASH = "a".repeat(64);
let dir: string;
let marker: string;
let scope: string;

beforeEach(async (ctx) => {
  const resolved = await localRuntimeScope();
  if (resolved === null) ctx.skip();
  scope = resolved!;
  dir = await mkdtemp(join(tmpdir(), "liveness-"));
  marker = activeHeartbeatPath(dir, HASH);
});

afterEach(async () => {
  vi.restoreAllMocks();
  failing.stat = failing.read = failing.write = "";
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function staleMarker(owner: object): Promise<void> {
  await writeFile(marker, JSON.stringify(owner));
  const old = (Date.now() - 3 * 24 * 60 * 60 * 1000) / 1000;
  await utimes(marker, old, old);
}

it("a stale marker from another runtime scope ages by mtime even if its pid is live", async () => {
  await staleMarker({ pid: process.pid, runtimeScope: "f".repeat(64) });
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(false);
});

it("only ESRCH proves a stale owner gone", async () => {
  await staleMarker({ pid: 12345, runtimeScope: scope });
  const kill = vi.spyOn(process, "kill");
  kill.mockImplementation(() => {
    throw Object.assign(new Error("probe"), { code: "EINVAL" });
  });
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(true);
  kill.mockImplementation(() => {
    throw Object.assign(new Error("probe"), { code: "ESRCH" });
  });
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(false);
});

it("a beat writes this process's claim atomically, leaving no temp", async () => {
  await touchSessionHeartbeat(dir, HASH);
  expect(JSON.parse(await readFile(marker, "utf8"))).toEqual({
    pid: process.pid,
    runtimeScope: scope,
  });
  expect(await readdir(dir)).toEqual([`.active.${HASH}`]);
});

it("release clears only this process's claim, after any beat in flight", async () => {
  const other = JSON.stringify({ pid: process.pid + 1, runtimeScope: scope });
  await writeFile(marker, other);
  await releaseSessionHeartbeat(dir, HASH);
  expect(await readFile(marker, "utf8")).toBe(other);

  // Not awaited: the release queued behind it must still land last.
  void touchSessionHeartbeat(dir, HASH);
  await releaseSessionHeartbeat(dir, HASH);
  expect(await readFile(marker, "utf8")).toBe("");
});

it("a stale marker that cannot be read or stat'ed keeps its session", async () => {
  await staleMarker({ pid: 2 ** 31 - 4, runtimeScope: scope });
  failing.read = "EBUSY";
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(true);
  failing.read = "";
  failing.stat = "EACCES";
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(true);
  failing.stat = "ENOTDIR";
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(false);
  failing.stat = "";
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(false);
  await rm(marker);
  expect(await sessionHeartbeatIsFresh(dir, HASH)).toBe(false);
});

it("a release whose write fails removes the marker instead of keeping the claim", async () => {
  await touchSessionHeartbeat(dir, HASH);
  failing.write = "ENOSPC";
  await releaseSessionHeartbeat(dir, HASH);
  await expect(access(marker)).rejects.toThrow();
});

it("a release never removes an unreadable marker, which may hold another owner's claim", async () => {
  await touchSessionHeartbeat(dir, HASH);
  failing.read = "EBUSY";
  failing.write = "ENOSPC";
  await releaseSessionHeartbeat(dir, HASH);
  failing.read = failing.write = "";
  await access(marker);
});
