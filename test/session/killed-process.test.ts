import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import ompUndoRedo from "../../src/index.js";
import { checkpointNamespace } from "../../src/infra/paths.js";
import { historyRefPrefix } from "../../src/store/refs.js";
import {
  context,
  FakeExtensionApi,
  gitRepository,
  makeRepository,
  privateRefs,
  rmRetry,
  type TestEntry,
} from "../helpers/index.js";

// Real second processes, really killed: the dead-pid probe, owner leases and
// the restore intent run against a process that is gone, not a fake.

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
let scratch: string;
let childScript: string;

/** The child runs outside vitest, so the sources it imports are transpiled
 *  into `scratch` first (Node 20 cannot strip types itself). */
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "omp-undo-redo-killed-"));
  // Parent and children must share one persistent host id, or no owner is
  // pid-probed; keep it out of the user's own state dir.
  // shortcut: macOS reads it under homedir(), which stays ambient; stubbing
  // HOME would also move git's global config. Upgrade if macOS CI needs it.
  vi.stubEnv("LOCALAPPDATA", join(scratch, "state"));
  vi.stubEnv("XDG_STATE_HOME", join(scratch, "state"));
  const sources = (await readdir(join(repoRoot, "src"), { recursive: true }))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => join("src", file))
    .concat(
      join("test", "helpers", "index.ts"),
      join("test", "session", "killed-process.child.ts"),
    );
  await Promise.all(
    sources.map(async (file) => {
      const out = join(scratch, "build", file.replace(/\.ts$/, ".js"));
      await mkdir(dirname(out), { recursive: true });
      const { outputText } = ts.transpileModule(await readFile(join(repoRoot, file), "utf8"), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      await writeFile(out, outputText);
    }),
  );
  await writeFile(join(scratch, "build", "package.json"), '{"type":"module"}');
  childScript = join(scratch, "build", "test", "session", "killed-process.child.js");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await rmRetry(scratch, 10);
});

const children: ChildProcess[] = [];

/** Forks the child and resolves once it reaches its kill point. Its temp
 *  dir (snapshot indexes a killed process never removes) is in `scratch`. */
async function launch(scenario: "undo" | "mid-turn", cwd: string, sessionId: string) {
  const temp = join(scratch, "tmp");
  await mkdir(temp, { recursive: true });
  const child = fork(childScript, [scenario, cwd, sessionId], {
    execArgv: [],
    env: { ...process.env, TMPDIR: temp, TEMP: temp, TMP: temp },
    silent: true,
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));
  child.stdout?.resume();
  const { promise, resolve, reject } = Promise.withResolvers<ChildProcess>();
  child.once("message", () => resolve(child));
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    reject(
      new Error(`${scenario} child exited (${code ?? signal}) before its kill point\n${stderr}`),
    ),
  );
  return promise;
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

/** Owner id of each lease in the store, by the pid it names. */
async function leaseOwners(storeDir: string): Promise<Map<number, string>> {
  const dir = join(storeDir, "omp-undo-redo", "owners");
  const owners = new Map<number, string>();
  for (const name of await readdir(dir)) {
    if (!name.endsWith(".json")) continue;
    const lease = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      ownerId: string;
      pid: number;
    };
    owners.set(lease.pid, lease.ownerId);
  }
  return owners;
}

async function refsUnder(cwd: string, prefix: string): Promise<string[]> {
  return (await privateRefs(cwd)).filter((ref) => ref.startsWith(prefix));
}

const ownerRefs = (owner: string) => `refs/omp-undo-redo/v2/${owner}/`;

it("reaps only killed owners' refs and settles the /undo a SIGKILL interrupted", async () => {
  const cwd = await makeRepository();
  const undoSession = "killed-process-undo";
  try {
    // Each starts while the earlier ones are alive, so its own owner scan
    // reaps nothing: only the restart below sees a dead owner.
    const live = await launch("mid-turn", cwd, "killed-process-live");
    const undoing = await launch("undo", cwd, undoSession);
    const capturing = await launch("mid-turn", cwd, "killed-process-capture");
    await Promise.all([kill(undoing), kill(capturing)]);
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");

    const { storeDir } = await gitRepository(cwd);
    const leases = await leaseOwners(storeDir);
    const liveOwner = leases.get(live.pid!)!;
    const undoOwner = leases.get(undoing.pid!)!;
    const captureOwner = leases.get(capturing.pid!)!;
    expect([liveOwner, undoOwner, captureOwner].every(Boolean)).toBe(true);
    expect(await refsUnder(cwd, ownerRefs(liveOwner))).toHaveLength(1);
    expect(await refsUnder(cwd, ownerRefs(captureOwner))).toHaveLength(1);
    const history = historyRefPrefix(checkpointNamespace(undoSession));
    expect(await refsUnder(cwd, history)).toHaveLength(2);

    // The next process resumes the killed session where its file ends.
    const prompt: TestEntry = {
      id: "prompt",
      parentId: null,
      type: "message",
      message: { role: "user" },
    };
    const response: TestEntry = {
      id: "response",
      parentId: prompt.id,
      type: "message",
      message: { role: "assistant" },
    };
    const exit: TestEntry = {
      id: "exit",
      parentId: response.id,
      type: "custom",
      customType: "session_exit",
    };
    const pi = new FakeExtensionApi();
    ompUndoRedo(pi as never);
    const ctx = context(cwd, undoSession);
    ctx.leaf = exit.id;
    ctx.branch = ctx.entries = [prompt, response, exit];
    ctx.navigateTree = async (targetId) => {
      ctx.leaf = targetId;
      ctx.branch = targetId === prompt.id ? [prompt] : [prompt, response];
      return { cancelled: false };
    };
    await pi.emit("session_start", ctx);
    expect(ctx.ui.notifications.at(-1)?.message).toBe(
      "The /undo interrupted by the last exit had already restored the files; undo history now matches them.",
    );
    await pi.runCommand("redo", ctx);
    expect(ctx.leaf).toBe(response.id);
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("changed\n");
    await pi.runCommand("undo", ctx);
    expect(ctx.leaf).toBe(prompt.id);
    expect(await readFile(join(cwd, "tracked.txt"), "utf8")).toBe("base\n");

    // This process's first snapshot publishes its lease and scans the others.
    await pi.emit("before_agent_start", ctx);
    // A dead child's pid reused by a new process before this scan reads as
    // alive and fails the wait below: rare, a flake rather than a regression.
    await vi.waitFor(
      async () => {
        const owners = [...(await leaseOwners(storeDir)).values()];
        expect(owners).not.toContain(undoOwner);
        expect(owners).not.toContain(captureOwner);
      },
      { timeout: 10_000, interval: 100 },
    );
    expect(await refsUnder(cwd, ownerRefs(captureOwner))).toEqual([]);
    expect(await refsUnder(cwd, history)).toHaveLength(2);
    // Shutdown waits for the scan, so a live owner it wrongly reaped shows here.
    await pi.emit("session_shutdown", ctx);
    expect([...(await leaseOwners(storeDir)).values()]).toContain(liveOwner);
    expect(await refsUnder(cwd, ownerRefs(liveOwner))).toHaveLength(1);
  } finally {
    await Promise.all(children.splice(0).map(kill));
    await rmRetry(cwd, 10);
  }
}, 60_000);
