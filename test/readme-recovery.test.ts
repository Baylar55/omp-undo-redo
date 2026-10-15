import { execFile, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createGitRunner } from "../src/infra/git-runner.js";
import { storeRootDirectory } from "../src/infra/paths.js";
import { finishAfterTurn, prepareBeforeTurn } from "../src/snapshot/capture.js";
import { defaultPool } from "../src/snapshot/index-leases.js";
import { applyCheckpoint } from "../src/snapshot/restore.js";
import { snapshotRunnerEnv } from "../src/store/git-store.js";
import { ensurePrivateGitRepository } from "../src/store/private-store.js";
import type { GitRepository, GitRunner } from "../src/types.js";
import { git, gitRepository, makeRepository, rmRetry } from "./helpers/index.js";

const execFileAsync = promisify(execFile);

// The commands under the README's "Restoring files after an interrupted undo or
// redo" heading, exactly as users copy them.
const section =
  readFileSync(new URL("../README.md", import.meta.url), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n### Restoring files after an interrupted undo or redo\n")[1]
    ?.split("\n### ")[0] ?? "";
const bashCommands = /```sh\n([\s\S]*?)\n```/.exec(section)?.[1];
const powershellCommands = /```powershell\n([\s\S]*?)\n```/.exec(section)?.[1];

// Without this, a renamed heading or fence would skip every case below.
it("finds the README's recovery commands", () => {
  expect(bashCommands).toContain("git read-tree");
  expect(powershellCommands).toContain("git read-tree");
});

/** Git Bash on Windows (a bare `bash` there may be WSL's), `bash` elsewhere. */
function findBash(): string | undefined {
  if (process.platform !== "win32") {
    return spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0 ? "bash" : undefined;
  }
  const exec = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout.trim();
  const bash = resolve(exec, "..", "..", "..", "bin", "bash.exe");
  return existsSync(bash) ? bash : undefined;
}

const powershells = (process.platform === "win32" ? ["powershell", "pwsh"] : ["pwsh"]).filter(
  (shell) =>
    spawnSync(shell, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", windowsHide: true })
      .status === 0,
);

const shells: Array<{
  name: string;
  commands: string;
  extension: string;
  run: (file: string) => string[];
}> = [];
const bash = findBash();
if (bash && bashCommands) {
  shells.push({ name: "bash", commands: bashCommands, extension: "sh", run: (f) => [bash, f] });
}
if (powershellCommands) {
  for (const ps of powershells) {
    shells.push({
      name: ps,
      commands: powershellCommands,
      extension: "ps1",
      run: (f) => [ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f],
    });
  }
}

type Workspace = { cwd: string; repository: GitRepository; snap: GitRunner; cleanup: string[] };

async function gitWorkspace(): Promise<Workspace> {
  const cwd = realpathSync.native(await makeRepository("omp-undo-redo-recover-git-"));
  const repository = await gitRepository(cwd);
  const snap = createGitRunner(cwd, { env: snapshotRunnerEnv(repository) });
  return { cwd, repository, snap, cleanup: [cwd] };
}

async function privateWorkspace(): Promise<Workspace> {
  const cwd = realpathSync.native(await mkdtemp(join(tmpdir(), "omp-undo-redo-recover-private-")));
  const repository = await ensurePrivateGitRepository(
    (dir, env) => createGitRunner(dir, env ? { env } : undefined),
    cwd,
    storeRootDirectory(),
  );
  if (!repository) throw new Error("private repo init failed");
  const snap = createGitRunner(cwd, { env: snapshotRunnerEnv(repository) });
  return { cwd, repository, snap, cleanup: [cwd, repository.storeDir] };
}

const UNICODE = "sp ace ü.txt";

/** The README's procedure against snapshots the extension really took: a turn,
 *  then an `/undo` of it killed halfway, then the commands with the hashes the
 *  recovery warning prints (before = the turn's after-snapshot, result = its
 *  before-snapshot). */
describe.each(shells)("README recovery commands ($name)", ({ commands, extension, run }) => {
  it.each([
    ["Git mode", gitWorkspace],
    ["Private-Git mode", privateWorkspace],
  ] as const)(
    "put a half-undone worktree back at the 'before' snapshot in %s",
    async (mode, makeWorkspace) => {
      const { cwd, repository, snap, cleanup } = await makeWorkspace();
      const put = async (path: string, content: string) => {
        await mkdir(dirname(join(cwd, path)), { recursive: true });
        await writeFile(join(cwd, path), content);
      };
      const read = (path: string) => readFile(join(cwd, path), "utf8").catch(() => null);
      try {
        await put("a.txt", "v1");
        await put("c.txt", "new1");
        await put(UNICODE, "f1");
        await put("sub/x.txt", "x1");
        await put("u.txt", "u1");
        if (mode === "Git mode") {
          await put("staged.txt", "staged");
          await git(cwd, ["add", "staged.txt"]);
        }
        const pending = await prepareBeforeTurn(
          snap,
          `recover-${mode}`,
          defaultPool,
          undefined,
          repository,
        );
        if (pending.status !== "git") throw new Error(`no before-snapshot: ${pending.reason}`);
        await put("a.txt", "v2");
        await rm(join(cwd, "c.txt"));
        await put("d.txt", "d2");
        await put(UNICODE, "f2");
        await rm(join(cwd, "sub"), { recursive: true });
        const turn = await finishAfterTurn(snap, pending.checkpoint, null, null, defaultPool);
        if (turn.status !== "git") throw new Error(`no after-snapshot: ${turn.reason}`);
        const { beforeHash, afterHash } = turn.checkpoint;

        // `/undo` (after -> before) killed halfway, then an unrelated edit.
        await put("a.txt", "v1");
        await put("c.txt", "new1");
        await rm(join(cwd, UNICODE));
        await put("sub/x.txt", "x1");
        await put("u.txt", "user edit");
        expect((await applyCheckpoint(snap, afterHash, beforeHash, true)).status).not.toBe(
          "applied",
        );
        const realIndex =
          mode === "Git mode"
            ? [await git(cwd, ["ls-files", "-s"]), await git(cwd, ["rev-parse", "HEAD"])]
            : [];

        const filled = commands
          .replace("<store>", repository.storeDir)
          .replace("<before-hash>", afterHash)
          .replace("<result-hash>", beforeHash);
        const scratch = await mkdtemp(join(tmpdir(), "omp-undo-redo-recover-script-"));
        cleanup.push(scratch);
        const file = join(scratch, `restore.${extension}`);
        await writeFile(file, `${filled}\n`);
        const [command, ...args] = run(file);
        // A user's shell, not this test's: no inherited GIT_* variables.
        const env = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
        );
        await execFileAsync(command, args, { cwd, env, windowsHide: true });

        expect(await read("a.txt")).toBe("v2");
        expect(await read("c.txt")).toBeNull();
        expect(await read("d.txt")).toBe("d2");
        expect(await read(UNICODE)).toBe("f2");
        expect(await read("sub/x.txt")).toBeNull();
        expect(await read("u.txt")).toBe("user edit");
        // The next `/undo` now applies, exactly as if the first had never run.
        expect((await applyCheckpoint(snap, afterHash, beforeHash, true)).status).toBe("applied");
        if (mode === "Git mode") {
          expect([
            await git(cwd, ["ls-files", "-s"]),
            await git(cwd, ["rev-parse", "HEAD"]),
          ]).toEqual(realIndex);
        }
      } finally {
        for (const path of cleanup) await rmRetry(path);
      }
    },
    60_000,
  );
});
