import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readlink, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeExclusive } from "../infra/fs.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANY_UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const BOOT_ID_TIMEOUT_MS = 2_000;
const execFileAsync = promisify(execFile);

export interface HostIdentity {
  id: string | null;
  persistent: boolean;
}

export interface HostIdentityOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  randomId?: () => string;
  readFile?: (path: string, encoding: "utf8") => Promise<string>;
  readlink?: (path: string) => Promise<string>;
  /** Runs a command and resolves its stdout; rejects on failure. */
  runCommand?: (file: string, args: string[]) => Promise<string>;
}

export function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function hostIdentityPath(options: HostIdentityOptions): string {
  const selectedPlatform = options.platform ?? platform();
  const env = options.env ?? process.env;
  const home = options.homeDirectory ?? homedir();
  if (selectedPlatform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "omp-undo-redo", "host-id");
  }
  if (selectedPlatform === "darwin") {
    return join(home, "Library", "Application Support", "omp-undo-redo", "host-id");
  }
  return join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), "omp-undo-redo", "host-id");
}

async function readValidUuid(path: string): Promise<string | null | "unreadable"> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return isCanonicalUuid(value) ? value : "unreadable";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : "unreadable";
  }
}

export async function resolvePersistentHostId(
  options: HostIdentityOptions = {},
): Promise<HostIdentity> {
  const path = hostIdentityPath(options);
  const existing = await readValidUuid(path);
  if (existing === "unreadable") return { id: null, persistent: false };
  if (existing) return { id: existing, persistent: true };
  const id = (options.randomId ?? randomUUID)();
  if (!isCanonicalUuid(id)) return { id: null, persistent: false };
  const temporary = `${path}.${randomUUID()}.tmp`;
  const adoptWinner = async (): Promise<HostIdentity> => {
    const winner = await readValidUuid(path);
    return winner && winner !== "unreadable"
      ? { id: winner, persistent: true }
      : { id: null, persistent: false };
  };
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (!(await writeExclusive(temporary, `${id}\n`))) return adoptWinner();
    try {
      await link(temporary, path);
      await rm(temporary, { force: true });
      return { id, persistent: true };
    } catch {
      return adoptWinner();
    }
  } catch {
    return { id: null, persistent: false };
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function runCommand(file: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    timeout: BOOT_ID_TIMEOUT_MS,
    windowsHide: true,
  });
  return stdout;
}

/** A value the OS changes on every boot and never within one. Wall-clock boot
 *  time (`Date.now() - uptime`) is not: a clock step shifts it mid-boot. */
async function readNativeBootId(
  selectedPlatform: NodeJS.Platform,
  options: HostIdentityOptions,
): Promise<string | null> {
  const run = options.runCommand ?? runCommand;
  try {
    if (selectedPlatform === "win32") {
      const systemRoot = (options.env ?? process.env).SystemRoot ?? "C:\\Windows";
      const output = await run(`${systemRoot}\\System32\\reg.exe`, [
        "query",
        "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Memory Management\\PrefetchParameters",
        "/v",
        "BootId",
      ]);
      return /^\s*BootId\s+REG_DWORD\s+(0x[0-9a-f]+)\s*$/im.exec(output)?.[1].toLowerCase() ?? null;
    }
    if (selectedPlatform === "darwin") {
      const output = (await run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"])).trim();
      return ANY_UUID_PATTERN.test(output) ? output.toLowerCase() : null;
    }
  } catch {
    // Fall through: unreadable boot identity.
  }
  return null;
}

export async function resolveRuntimeScope(
  options: HostIdentityOptions = {},
): Promise<string | null> {
  const selectedPlatform = options.platform ?? platform();
  if (selectedPlatform !== "linux") {
    // An unreadable boot ID keeps the boot-less scope: pids from an earlier
    // boot then look live (refs leak), but a live owner never looks remote.
    const bootId = await readNativeBootId(selectedPlatform, options);
    const scope = `native-process-table:${selectedPlatform}`;
    return createHash("sha256")
      .update(bootId ? `${scope}:${bootId}` : scope)
      .digest("hex");
  }
  const readText = options.readFile ?? readFile;
  const readLink = options.readlink ?? readlink;
  try {
    const [bootId, pidNamespace] = await Promise.all([
      readText("/proc/sys/kernel/random/boot_id", "utf8"),
      readLink("/proc/self/ns/pid"),
    ]);
    const boot = bootId.trim();
    if (!isCanonicalUuid(boot) || !/^pid:\[\d+\]$/.test(pidNamespace)) return null;
    return createHash("sha256").update(`linux:${boot}:${pidNamespace}`).digest("hex");
  } catch {
    return null;
  }
}
