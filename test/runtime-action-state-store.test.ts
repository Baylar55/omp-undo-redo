import type * as Fs from "node:fs/promises";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkpointNamespace } from "../src/core/checkpoints.js";
import { RuntimeActionStateStore } from "../src/core/runtime-action-state-store.js";
import type { NavigationState } from "../src/core/types.js";

/** While `hold` is set, `rm` signals `entered` and waits for `hold`, and
 *  `mkdir` calls are counted in `mkdirsWhileHeld`. */
const rmGate = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
  mkdirsWhileHeld: 0,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof Fs>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      if (rmGate.hold) {
        const hold = rmGate.hold;
        rmGate.entered?.();
        await hold;
      }
      return actual.rm(...args);
    },
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      if (rmGate.hold) rmGate.mkdirsWhileHeld += 1;
      return actual.mkdir(...args);
    },
  };
});

const roots: string[] = [];

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omp-undo-redo-runtime-store-"));
  roots.push(root);
  return root;
}

async function readState(
  store: RuntimeActionStateStore,
  sessionId: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(store.sessionPath(sessionId), "utf8")) as Record<
    string,
    unknown
  >;
}

function state(currentIndex: number): NavigationState {
  return {
    checkpoints: [
      {
        kind: "session",
        reason: "not_repository",
        parentLeafId: "root",
        leafId: "turn",
      },
      {
        kind: "session",
        reason: "not_repository",
        parentLeafId: "turn",
        leafId: "turn-2",
      },
    ],
    currentIndex,
  };
}

afterEach(async () => {
  Object.assign(rmGate, { hold: undefined, entered: undefined, mkdirsWhileHeld: 0 });
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime action-state store", () => {
  it("writes atomic schema-2 state with hashed session filename", async () => {
    const root = await makeRoot();
    const store = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 101,
      runtimeId: "runtime-a",
      clock: () => new Date("2026-08-01T12:00:00.000Z"),
      uuid: () => "temporary",
    });
    await store.initialize();
    await store.publishNavigation("secret-session", state(0), null);

    const marker = JSON.parse(await readFile(join(root, "101", "runtime.json"), "utf8")) as Record<
      string,
      unknown
    >;
    const published = await readState(store, "secret-session");
    const files = await readdir(join(root, "101", "sessions"));

    expect(marker).toEqual({
      schemaVersion: 1,
      protocol: "omp-undo-redo/runtime",
      runtimeId: "runtime-a",
      pid: 101,
      hostname: expect.any(String),
      startedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(files).toEqual([`${checkpointNamespace("secret-session")}.json`]);
    expect(published).toMatchObject({
      schemaVersion: 2,
      protocol: "omp-undo-redo/action-state",
      sessionHash: checkpointNamespace("secret-session"),
      runtimeId: "runtime-a",
      pid: 101,
      actions: [
        { id: "undo", enabled: true },
        { id: "redo", enabled: true },
      ],
      activeSessionLeaf: null,
    });
    expect(published.sessionRevision).toEqual(expect.any(String));
    expect(published.updatedAt).toEqual(expect.any(String));
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "leaves the mode of a configured root alone, such as a shared /tmp",
    async () => {
      const root = await makeRoot();
      await chmod(root, 0o1777);
      const store = new RuntimeActionStateStore({ rootDirectory: root, pid: 105 });
      await store.initialize();
      expect((await stat(root)).mode & 0o7777).toBe(0o1777);
      expect((await stat(join(root, "105"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "105", "sessions"))).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === "win32")("restricts the default root to its owner", async () => {
    const home = await makeRoot();
    const root = join(home, ".omp", "omp-undo-redo", "runtime");
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    try {
      vi.stubEnv("HOME", home);
      vi.stubEnv("OMP_UNDO_REDO_RUNTIME_DIR", undefined);
      const store = new RuntimeActionStateStore({ pid: 106 });
      await store.initialize();
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps revisions stable for action-only updates and preserves latest result", async () => {
    const store = new RuntimeActionStateStore({ rootDirectory: await makeRoot(), pid: 102 });
    await store.publishNavigation("session", state(0), "turn");
    const before = await readState(store, "session");
    await store.publishActionResult("session", state(0), "turn", {
      id: "undo",
      applied: false,
      token: "first",
    });
    const afterAction = await readState(store, "session");
    await store.publishNavigation("session", state(0), "turn");
    const afterNavigation = await readState(store, "session");

    expect(afterAction.sessionRevision).toBe(before.sessionRevision);
    expect(afterNavigation.sessionRevision).toBe(before.sessionRevision);
    expect(afterNavigation.actionResult).toEqual({
      id: "undo",
      applied: false,
      token: "first",
    });
  });

  it("resets action result when session initialization starts", async () => {
    const store = new RuntimeActionStateStore({ rootDirectory: await makeRoot(), pid: 103 });
    await store.publishActionResult("session", state(0), "turn", {
      id: "undo",
      applied: true,
      token: "old",
    });
    await store.initializeSession("session", state(0), "turn");

    expect((await readState(store, "session")).actionResult).toBeUndefined();
  });

  it("serializes concurrent writes in logical order", async () => {
    const store = new RuntimeActionStateStore({ rootDirectory: await makeRoot(), pid: 104 });
    await Promise.all([
      store.publishNavigation("session", state(0), "turn"),
      store.publishNavigation("session", state(1), "turn-2"),
      store.publishNavigation("session", state(0), "turn"),
    ]);

    const published = await readState(store, "session");
    expect(published.activeSessionLeaf).toBe("turn");
    expect((published.actions as Array<{ id: string; enabled: boolean }>)[1]).toEqual({
      id: "redo",
      enabled: true,
    });
  });

  it("isolates PIDs and removes stale PID directory before marker write", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "105", "sessions"), { recursive: true });
    await writeFile(join(root, "105", "stale.json"), "stale");
    const first = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 105,
      runtimeId: "first",
    });
    const second = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 106,
      runtimeId: "second",
    });

    await first.initialize();
    await second.initialize();
    await first.publishNavigation("one", state(0), "turn");
    await second.publishNavigation("two", state(1), "turn-2");

    await expect(access(join(root, "105", "stale.json"))).rejects.toThrow();
    expect(await readFile(join(root, "105", "runtime.json"), "utf8")).toContain('"first"');
    expect(await readFile(join(root, "106", "runtime.json"), "utf8")).toContain('"second"');
    await expect(
      access(join(root, "105", "sessions", `${checkpointNamespace("two")}.json`)),
    ).rejects.toThrow();
  });

  it("shuts down idempotently and removes only its own runtime directory", async () => {
    const root = await makeRoot();
    const first = new RuntimeActionStateStore({ rootDirectory: root, pid: 107 });
    const second = new RuntimeActionStateStore({ rootDirectory: root, pid: 108 });
    await first.publishNavigation("one", state(0), "turn");
    await second.publishNavigation("two", state(0), "turn");

    await Promise.all([first.shutdown(), first.shutdown()]);
    await expect(access(join(root, "107"))).rejects.toThrow();
    await expect(access(join(root, "108", "runtime.json"))).resolves.toBeUndefined();
    await second.shutdown();
  });

  it("shares one PID directory between the extension copies of a process", async () => {
    const root = await makeRoot();
    const main = new RuntimeActionStateStore({ rootDirectory: root, pid: 110, runtimeId: "main" });
    const subagent = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 110,
      runtimeId: "subagent",
    });
    await main.publishNavigation("main-session", state(0), "turn");
    await subagent.publishNavigation("subagent-session", state(0), "turn");
    expect((await readState(subagent, "subagent-session")).runtimeId).toBe("main");
    await subagent.shutdown();

    await main.publishNavigation("main-session", state(1), "turn-2");
    expect((await readState(main, "main-session")).activeSessionLeaf).toBe("turn-2");
    await expect(access(subagent.sessionPath("subagent-session"))).rejects.toThrow();
    expect(await readFile(join(root, "110", "runtime.json"), "utf8")).toContain('"main"');

    await main.shutdown();
    await expect(access(join(root, "110"))).rejects.toThrow();
  });

  it("keeps the directory of a copy that joins while the last one leaves", async () => {
    const root = await makeRoot();
    const leaving = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 111,
      runtimeId: "leaving",
    });
    const joining = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 111,
      runtimeId: "joining",
    });
    await leaving.publishNavigation("old", state(0), "turn");
    const entered = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    rmGate.entered = entered.resolve;
    rmGate.hold = held.promise;
    const left = leaving.shutdown();
    // The leaver has dropped out and its directory removal is in flight.
    await entered.promise;
    rmGate.entered = undefined;
    const joined = joining.publishNavigation("new", state(0), "turn");
    // The joiner must not touch the directory before that removal finishes.
    expect(rmGate.mkdirsWhileHeld).toBe(0);
    rmGate.hold = undefined;
    held.resolve();
    await Promise.all([left, joined]);

    expect((await readState(joining, "new")).runtimeId).toBe("joining");
    expect(await readFile(join(root, "111", "runtime.json"), "utf8")).toContain('"joining"');
    await joining.shutdown();
  });

  it("swallows filesystem failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-undo-redo-runtime-file-"));
    roots.push(root);
    const store = new RuntimeActionStateStore({
      rootDirectory: join(root, "not-a-directory"),
      pid: 109,
    });
    await writeFile(join(root, "not-a-directory"), "file");

    await expect(store.initialize()).resolves.toBeUndefined();
    await expect(store.publishNavigation("session", state(0), "turn")).resolves.toBeUndefined();
    await expect(
      store.publishActionResult("session", state(0), "turn", {
        id: "undo",
        applied: false,
        token: "failure-safe",
      }),
    ).resolves.toBeUndefined();
  });
});
