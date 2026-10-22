import type * as Fs from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/infra/compat.js";
import { RuntimeActionStateStore } from "../../src/runtime/action-state.js";
import { reapStaleRuntimes } from "../../src/runtime/reaper.js";
import type { NavigationState } from "../../src/types.js";
import { checkpointNamespace } from "../../src/infra/paths.js";

/** While `hold` is set, `rm` signals `entered` and waits for `hold`, and
 *  `mkdir` calls are counted in `mkdirsWhileHeld`. */
const rmGate = vi.hoisted(() => ({
  hold: undefined as Promise<void> | undefined,
  entered: undefined as (() => void) | undefined,
  mkdirsWhileHeld: 0,
}));
/** `stat` of any path in `fail` rejects, as an unreadable directory would. */
const statGate = vi.hoisted(() => ({ fail: new Set<string>() }));
/** `writeFile` of a runtime marker rejects while set, as a full disk would. */
const markerGate = vi.hoisted(() => ({ fail: false }));
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
    stat: (...args: Parameters<typeof actual.stat>) =>
      statGate.fail.has(String(args[0]))
        ? Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))
        : actual.stat(...args),
    writeFile: (...args: Parameters<typeof actual.writeFile>) =>
      markerGate.fail && String(args[0]).includes("runtime.json")
        ? Promise.reject(Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }))
        : actual.writeFile(...args),
  };
});

const roots: string[] = [];
const scope = "c".repeat(64);
const otherScope = "d".repeat(64);
const resolveRuntimeScope = async (): Promise<string> => scope;

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
  statGate.fail.clear();
  markerGate.fail = false;
  vi.restoreAllMocks();
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
      resolveRuntimeScope,
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
      runtimeScope: scope,
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
      // Bun's chmod drops the sticky bit, so compare against what actually got set.
      const sharedMode = (await stat(root)).mode & 0o7777;
      const store = new RuntimeActionStateStore({ rootDirectory: root, pid: 105 });
      await store.initialize();
      expect((await stat(root)).mode & 0o7777).toBe(sharedMode);
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
    await writeFile(
      join(root, "105", "runtime.json"),
      JSON.stringify({
        schemaVersion: 1,
        protocol: "omp-undo-redo/runtime",
        pid: 105,
        hostname: hostname(),
        runtimeScope: scope,
      }),
    );
    const first = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 105,
      runtimeId: "first",
      resolveRuntimeScope,
    });
    const second = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 106,
      runtimeId: "second",
      resolveRuntimeScope,
    });

    await first.initialize();
    await second.initialize();
    await first.publishNavigation("one", state(0), "turn");
    await second.publishNavigation("two", state(1), "turn-2");

    await expect(access(join(root, "105", "stale.json"))).rejects.toThrow();
    // The replaced directory was moved aside and removed, not left as `105.*.tmp`.
    expect((await readdir(root)).sort()).toEqual(["105", "106"]);
    expect(await readFile(join(root, "105", "runtime.json"), "utf8")).toContain('"first"');
    expect(await readFile(join(root, "106", "runtime.json"), "utf8")).toContain('"second"');
    await expect(
      access(join(root, "105", "sessions", `${checkpointNamespace("two")}.json`)),
    ).rejects.toThrow();
  });

  it("leaves a pre-existing directory without its marker alone and publishes nothing", async () => {
    const root = await makeRoot();
    await mkdir(join(root, "109"), { recursive: true });
    await writeFile(join(root, "109", "precious.txt"), "keep me");
    const store = new RuntimeActionStateStore({ rootDirectory: root, pid: 109 });

    await store.initialize();
    await store.publishNavigation("session", state(0), "turn");
    await store.publishActionResult("session", state(0), "turn", {
      id: "undo",
      applied: true,
      token: "t",
    });
    await store.shutdown();

    expect(await readFile(join(root, "109", "precious.txt"), "utf8")).toBe("keep me");
    expect(await readdir(join(root, "109"))).toEqual(["precious.txt"]);
  });

  it("replaces another runtime scope's directory only once it is ancient", async () => {
    // A container sharing the root has its own pid 130/131: same number, not ours.
    const root = await makeRoot();
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1_000);
    for (const [pid, startedAt] of [
      [130, new Date()],
      [131, ancient],
    ] as const) {
      await mkdir(join(root, String(pid), "sessions"), { recursive: true });
      await writeFile(
        join(root, String(pid), "runtime.json"),
        JSON.stringify({
          schemaVersion: 1,
          protocol: "omp-undo-redo/runtime",
          runtimeId: `container-${pid}`,
          pid,
          hostname: hostname(),
          runtimeScope: otherScope,
          startedAt: startedAt.toISOString(),
        }),
      );
      await utimes(join(root, String(pid)), startedAt, startedAt);
    }
    const live = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 130,
      resolveRuntimeScope,
    });
    const stale = new RuntimeActionStateStore({
      rootDirectory: root,
      pid: 131,
      runtimeId: "new",
      resolveRuntimeScope,
    });

    await live.publishNavigation("session", state(0), "turn");
    await stale.publishNavigation("session", state(0), "turn");
    await live.shutdown();

    expect(await readFile(join(root, "130", "runtime.json"), "utf8")).toContain('"container-130"');
    await expect(access(live.sessionPath("session"))).rejects.toThrow();
    expect((await readState(stale, "session")).runtimeId).toBe("new");
    await stale.shutdown();
  });

  it("publishes over leftovers of an install a killed process left", async () => {
    const root = await makeRoot();
    const marked = join(root, "120.dead-install.tmp");
    const unmarked = join(root, "120.early-kill.tmp");
    await mkdir(join(marked, "sessions"), { recursive: true });
    await writeFile(
      join(marked, "runtime.json"),
      JSON.stringify({ schemaVersion: 1, protocol: "omp-undo-redo/runtime", pid: 120 }),
    );
    await mkdir(join(unmarked, "sessions"), { recursive: true });
    const store = new RuntimeActionStateStore({ rootDirectory: root, pid: 120, runtimeId: "new" });

    await store.publishNavigation("session", state(0), "turn");

    expect((await readState(store, "session")).runtimeId).toBe("new");
    expect(await readFile(join(root, "120", "runtime.json"), "utf8")).toContain('"new"');
    expect((await readdir(root)).sort()).toEqual(
      ["120", "120.dead-install.tmp", "120.early-kill.tmp"].sort(),
    );
    await store.shutdown();
    expect((await readdir(root)).sort()).toEqual(
      ["120.dead-install.tmp", "120.early-kill.tmp"].sort(),
    );
  });

  it("leaves no unmarked directory when the marker cannot be written", async () => {
    const root = await makeRoot();
    markerGate.fail = true;
    const failed = new RuntimeActionStateStore({ rootDirectory: root, pid: 122 });
    await failed.publishNavigation("session", state(0), "turn");
    markerGate.fail = false;
    // The process dies without shutting down: forget its in-process share.
    (
      (globalThis as Record<symbol, unknown>)[
        Symbol.for("omp-undo-redo/runtime-directories/v1")
      ] as Map<string, unknown>
    ).delete(failed.runtimeDirectory);
    expect(await readdir(root)).toEqual([]);

    // A later process given the same pid must not find it foreign.
    const next = new RuntimeActionStateStore({ rootDirectory: root, pid: 122, runtimeId: "next" });
    await next.publishNavigation("session", state(0), "turn");
    expect((await readState(next, "session")).runtimeId).toBe("next");
    await next.shutdown();
  });

  it("shuts down idempotently and removes only its own runtime directory", async () => {
    const root = await makeRoot();
    const first = new RuntimeActionStateStore({ rootDirectory: root, pid: 107 });
    const second = new RuntimeActionStateStore({ rootDirectory: root, pid: 108 });
    await first.publishNavigation("one", state(0), "turn");
    await second.publishNavigation("two", state(0), "turn");

    await Promise.all([first.shutdown(), first.shutdown()]);
    await expect(access(join(root, "107"))).rejects.toThrow();
    // Bun resolves access() with null, Node with undefined: just require it not to reject.
    await access(join(root, "108", "runtime.json"));
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

  it("forgets a session it left and publishes it again once resumed", async () => {
    const root = await makeRoot();
    const store = new RuntimeActionStateStore({ rootDirectory: root, pid: 112 });
    await store.publishNavigation("left", state(0), "turn");
    await store.publishNavigation("kept", state(0), "turn");

    await store.releaseSession("left");
    await expect(access(store.sessionPath("left"))).rejects.toThrow();
    expect((await readState(store, "kept")).activeSessionLeaf).toBe("turn");

    await store.publishNavigation("left", state(1), "turn-2");
    expect((await readState(store, "left")).activeSessionLeaf).toBe("turn-2");
    await store.shutdown();
  });

  it("reaps only runtime directories that are dead or ancient on this host", async () => {
    // The free sweep, not `store.initialize()`: that also arms the store's own
    // delayed sweep, which a slow fixture setup lets race this one.
    const root = await makeRoot();

    const now = Date.now();
    const recent = new Date(now - 60_000);
    const ancient = new Date(now - 48 * 60 * 60 * 1_000);
    // pid -> process.kill outcome: an errno code, "" for alive and ours.
    const killCodes: Record<number, string> = {};
    // Each fixture: dir name = pid + suffix; mtime applied last since writes bump it.
    // `code` unset = the sweep must never probe that pid.
    const fixtures: Array<{
      pid: number;
      suffix?: string;
      code?: string;
      startedAt: Date;
      mtime: Date;
      host?: string;
      /** Marker `runtimeScope`; `null` writes a marker from before the field. */
      scope?: string | null;
      unreadable?: boolean;
      marker?: "none" | "corrupt" | "string-pid";
      precious?: boolean;
      tmpFile?: boolean;
    }> = [
      { pid: 301, code: "ESRCH", startedAt: recent, mtime: recent }, // gone
      { pid: 302, code: "EPERM", startedAt: recent, mtime: recent }, // foreign, recent
      { pid: 303, code: "EPERM", startedAt: ancient, mtime: ancient }, // foreign, ancient
      { pid: 304, code: "ESRCH", startedAt: ancient, mtime: ancient, host: "other-host" },
      { pid: 305, code: "EPERM", startedAt: ancient, mtime: ancient, unreadable: true },
      { pid: 306, code: "EPERM", startedAt: recent, mtime: ancient }, // marker still fresh
      { pid: 307, code: "EPERM", startedAt: ancient, mtime: recent }, // dir still fresh
      { pid: 308, code: "EINVAL", startedAt: ancient, mtime: ancient }, // unknown probe error
      { pid: 309, code: "", startedAt: ancient, mtime: ancient }, // alive and ours: never aged out
      { pid: 310, startedAt: ancient, mtime: ancient, marker: "none" }, // not provably ours
      { pid: 311, startedAt: recent, mtime: recent, marker: "none" },
      { pid: 312, startedAt: ancient, mtime: ancient, marker: "corrupt" },
      { pid: 313, startedAt: recent, mtime: recent, marker: "string-pid" },
      { pid: 314, startedAt: ancient, mtime: ancient, marker: "none", precious: true },
      // Only sessions/ and a temp file: still not provably ours.
      { pid: 315, startedAt: ancient, mtime: ancient, marker: "none", tmpFile: true },
      // Install/discard leftovers: reaped by marker like `<pid>`.
      { pid: 316, suffix: ".a.tmp", code: "ESRCH", startedAt: recent, mtime: recent },
      { pid: 317, suffix: ".a.tmp", code: "", startedAt: recent, mtime: recent }, // installing
      { pid: 318, suffix: ".a.tmp", startedAt: ancient, mtime: ancient, marker: "none" },
      // Another PID namespace (container) or boot: never probed, only aged out.
      { pid: 319, startedAt: recent, mtime: recent, scope: otherScope },
      { pid: 320, startedAt: ancient, mtime: ancient, scope: otherScope },
      { pid: 322, startedAt: recent, mtime: recent, scope: null },
      { pid: 323, startedAt: ancient, mtime: ancient, scope: null },
      { pid: 200, startedAt: ancient, mtime: ancient }, // own pid: never probed or reaped
      { pid: 200, suffix: ".a.tmp", startedAt: ancient, mtime: ancient }, // own pid
    ];
    for (const f of fixtures) {
      const dir = join(root, `${f.pid}${f.suffix ?? ""}`);
      await mkdir(join(dir, "sessions"), { recursive: true });
      if (f.marker !== "none") {
        await writeFile(
          join(dir, "runtime.json"),
          f.marker === "corrupt"
            ? "{not json"
            : JSON.stringify({
                schemaVersion: 1,
                protocol: "omp-undo-redo/runtime",
                runtimeId: `r-${f.pid}`,
                pid: f.marker === "string-pid" ? String(f.pid) : f.pid,
                hostname: f.host ?? hostname(),
                ...(f.scope === null ? {} : { runtimeScope: f.scope ?? scope }),
                startedAt: f.startedAt.toISOString(),
              }),
        );
      }
      if (f.precious) await writeFile(join(dir, "precious.txt"), "keep me");
      if (f.tmpFile) await writeFile(join(dir, ".runtime.json.x.tmp"), "{");
      await utimes(dir, f.mtime, f.mtime);
      if (f.unreadable) statGate.fail.add(resolve(dir));
      if (f.code !== undefined) killCodes[f.pid] = f.code;
    }
    await mkdir(join(root, "not-a-pid"));
    await utimes(join(root, "not-a-pid"), ancient, ancient);
    await mkdir(join(root, "321.tmp"));
    await utimes(join(root, "321.tmp"), ancient, ancient);

    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      const code = killCodes[Number(pid)];
      if (code === undefined) throw new Error(`unexpected kill(${String(pid)})`);
      if (code) throw Object.assign(new Error(code), { code });
      return true;
    });
    await reapStaleRuntimes(root, 200, scope);

    expect((await readdir(root)).sort()).toEqual(
      [
        "200",
        "302",
        "304",
        "305",
        "306",
        "307",
        "308",
        "309",
        "310",
        "311",
        "312",
        "313",
        "314",
        "315",
        "319",
        "322",
        "317.a.tmp",
        "318.a.tmp",
        "200.a.tmp",
        "not-a-pid",
        "321.tmp",
      ].sort(),
    );
    // Signal 0 only probes. Exactly the same-host, same-scope numeric marker
    // pids are probed: never itself (200, its leftover too), the other host's
    // (304), another scope's or a scopeless marker's (319, 320, 322, 323), or a dir
    // without a numeric pid.
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
    expect(kill.mock.calls.map(([pid]) => pid).sort((a, b) => a - b)).toEqual([
      301, 302, 303, 305, 306, 307, 308, 309, 316, 317,
    ]);
  });

  it("spares a fresh directory a recycled pid installs after the probe", async () => {
    const root = await makeRoot();
    const dir = join(root, "401");
    const marker = (runtimeId: string): string =>
      JSON.stringify({
        schemaVersion: 1,
        protocol: "omp-undo-redo/runtime",
        runtimeId,
        pid: 401,
        hostname: hostname(),
        runtimeScope: scope,
        startedAt: new Date().toISOString(),
      });
    await mkdir(join(dir, "sessions"), { recursive: true });
    await writeFile(join(dir, "runtime.json"), marker("dead"));
    // The probe reports the old owner gone; meanwhile the pid's new owner
    // discards that directory and renames its own into place.
    vi.spyOn(process, "kill").mockImplementation(() => {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(join(dir, "sessions"), { recursive: true });
      writeFileSync(join(dir, "sessions", "s.json"), "{}");
      writeFileSync(join(dir, "runtime.json"), marker("fresh"));
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });

    await reapStaleRuntimes(root, 200, scope);

    expect(await readFile(join(dir, "runtime.json"), "utf8")).toContain('"fresh"');
    expect(await readFile(join(dir, "sessions", "s.json"), "utf8")).toBe("{}");
    expect(await readdir(root)).toEqual(["401"]);
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
