import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, join } from "node:path";
import type { GitRunner } from "../types.js";
import { canonicalCwd, defaultStoreRoot } from "../infra/paths.js";
import { localStoreHost } from "./host-identity.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Creates `<storeRoot>/repos` owner-only. A Private-Git snapshot captures
 *  everything in the workspace that is not in DEFAULT_EXCLUDES — .env, id_rsa,
 *  credentials.json — and git's own loose objects are world-readable under the
 *  default umask. The mode covers directories this call creates; the chmod of
 *  `repos` covers one created earlier with the umask default. The store root
 *  itself is re-moded only at its default location: a configured root may be a
 *  shared directory (`/tmp` as root in a container), whose permissions are not
 *  ours to strip, and `repos` already guards every snapshot in it. Windows
 *  ignores POSIX modes. */
export async function ensureReposDirectory(reposDir: string, storeRoot: string): Promise<void> {
  await mkdir(reposDir, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  await chmod(reposDir, 0o700).catch(() => undefined);
  const root = canonicalCwd(storeRoot);
  if (root === defaultStoreRoot()) await chmod(root, 0o700).catch(() => undefined);
}

/** The store git dir for a path: `<storeRoot>/repos/<sha256(path)>.git` — a
 *  workspace (Private-Git) or a repository's `commonDir` (Git mode).
 *  Both inputs are canonicalized here (realpath) so the result is one
 *  deterministic long-form path regardless of how the caller spelled either
 *  argument: a store root or cwd spelled in 8.3 short form
 *  (e.g. `C:\Users\BAYLAR~1.SAD\...`) must name the same store. */
export function privateRepositoryPath(storeRoot: string, cwd: string): string {
  return join(canonicalCwd(storeRoot), "repos", `${sha256Hex(canonicalCwd(cwd))}.git`);
}

/** Config keys each store kind writes last, so either one proves setup ran. */
const SETUP_MARKERS: ReadonlyArray<readonly [section: string, key: string]> = [
  ["core", "worktree"],
  ["omp-undo-redo", "commondir"],
];

/** `gitDir`'s config file as `section.key` → value, read without a git
 *  process: empty when the file is missing, null when it cannot be read.
 *  Only the plain `[section]` headers and `key = value` lines git writes are
 *  recognised. */
export async function readStoreConfig(gitDir: string): Promise<Map<string, string> | null> {
  let text: string;
  try {
    text = await readFile(join(gitDir, "config"), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? new Map() : null;
  }
  const values = new Map<string, string>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[([^\]]*)\]/.exec(line);
    if (header) {
      section = header[1].trim().toLowerCase();
      continue;
    }
    const entry = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (entry) values.set(`${section}.${entry[1].toLowerCase()}`, entry[2]?.trim() ?? "");
  }
  return values;
}

/** Whether `gitDir`'s setup finished: true when a setup marker is present,
 *  false when absent (a missing config file included), null when the file
 *  cannot be read. */
export async function setupFinished(gitDir: string): Promise<boolean | null> {
  const config = await readStoreConfig(gitDir);
  return config && SETUP_MARKERS.some(([section, key]) => config.has(`${section}.${key}`));
}

/** Whether a store holds any ref, loose or packed. Errors other than ENOENT
 *  propagate, which callers read as "keep". */
export async function storeHasRefs(gitDir: string): Promise<boolean> {
  try {
    const loose = await readdir(join(gitDir, "refs"), { recursive: true, withFileTypes: true });
    if (loose.some((entry) => entry.isFile())) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const packed = await readFile(join(gitDir, "packed-refs"), "utf8");
    return packed.split(/\r?\n/).some((line) => line !== "" && !line.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return false;
  }
}

/** How long a store must sit untouched before an unfinished setup counts as
 *  abandoned: a running setup touches its config every few tens of ms. */
const SETUP_QUIET_MS = 10_000;

/** Where an existing store's setup stands. HEAD alone proves nothing: `git
 *  init` writes it before the config calls, older gits before their own config
 *  and `objects/`. "new": no HEAD. "done": a setup marker is present. "busy":
 *  no marker, but touched within SETUP_QUIET_MS (a concurrent launch may still
 *  be setting it up), or unreadable. "init": abandoned before `objects/`, the
 *  last thing `git init` creates, so git rejects the directory. "config":
 *  abandoned after `git init`. A `config.lock` as quiet as the rest is debris
 *  from a killed git, which git never removes, so it is deleted here. */
async function setupState(gitDir: string): Promise<"new" | "done" | "busy" | "init" | "config"> {
  const [head, config, lock] = await Promise.all(
    ["HEAD", "config", "config.lock"].map((name) =>
      stat(join(gitDir, name)).then(
        (info) => info.mtimeMs,
        () => 0,
      ),
    ),
  );
  if (head === 0) return "new";
  const finished = await setupFinished(gitDir);
  if (finished !== false) return finished ? "done" : "busy";
  if (Date.now() - Math.max(head, config, lock) < SETUP_QUIET_MS) return "busy";
  if (lock !== 0) await rm(join(gitDir, "config.lock"), { force: true }).catch(() => undefined);
  return (await hasObjects(gitDir)) ? "config" : "init";
}

function hasObjects(gitDir: string): Promise<boolean> {
  return stat(join(gitDir, "objects")).then(
    () => true,
    () => false,
  );
}

/** Retries after a failed setup step. ~1.6s of backoff in total: enough for
 *  launches started together to take turns on config.lock. */
export const SETUP_RETRIES = 6;

export const SETUP_RETRY_MS = 25;

/** Runs the setup `setupState` calls for: `init` (git init) then `configure`
 *  (its config keys, marker last). Launches started together on one store
 *  contend for config.lock, and the loser's `git init` or `git config` fails,
 *  so a failed step is retried with backoff. A retry re-reads the state: one
 *  another launch finished is taken as is, unless this launch ran `git init`,
 *  which may have reset `core.bare` behind that launch's config, so the
 *  config is reapplied (every launch writes the same values). "busy" on the
 *  first look is used as found, and "done" runs `onDone`. Returns false when
 *  a new store could not be set up; an existing one is used as found. */
export async function setUpStore(
  gitDir: string,
  init: () => Promise<boolean>,
  configure: () => Promise<boolean>,
  onDone?: () => Promise<unknown>,
): Promise<boolean> {
  const first = await setupState(gitDir);
  if (first === "busy") return true;
  if (first === "done") {
    await onDone?.();
    return true;
  }
  let state: "new" | "init" | "config" = first;
  let initRan = false;
  for (let attempt = 0; ; attempt++) {
    let ok = true;
    if (state !== "config") {
      initRan = true;
      ok = await init();
    }
    if (ok && (await configure())) return true;
    if (attempt === SETUP_RETRIES) return first !== "new";
    await sleep(SETUP_RETRY_MS * 2 ** attempt * (0.5 + Math.random()));
    const now = await setupState(gitDir);
    if (now === "done" && !initRan) return true;
    // A repeated `git init` resets `core.bare`: only once `objects/` shows
    // some init finished is the config alone redone.
    state = now === "new" ? "new" : (await hasObjects(gitDir)) ? "config" : "init";
  }
}

/** Applies `entries` in order and stops at the first failure. */
export async function applyConfig(
  git: GitRunner,
  entries: ReadonlyArray<readonly [string, string]>,
): Promise<boolean> {
  for (const [key, value] of entries) {
    if ((await git(["config", key, value])).code !== 0) return false;
  }
  return true;
}

/** `core.hooksPath` for a store: a directory nothing creates, so no hook runs
 *  in it, whether seeded by a user template or set by a global/system
 *  `core.hooksPath`. A failing `reference-transaction` hook would abort `git
 *  init` (it writes HEAD) and every snapshot ref update. Absolute: git resolves
 *  a relative one against the process cwd: the user's workspace for
 *  Private-Git commands, the shared temp dir for the gc sweep.
 *  shortcut: env-supplied config (`GIT_CONFIG_COUNT`/`GIT_CONFIG_PARAMETERS`,
 *  kept by the runner) outranks this key after setup; pass `-c` on every
 *  store-bound command if that is ever seen. */
export function storeHooksConfig(gitDir: string): readonly [string, string] {
  return ["core.hooksPath", join(gitDir, "no-hooks")];
}

/** `git init` args for a store: no user template (hooks, config) is copied,
 *  and no hook runs during the init itself. */
export function storeInitArgs(gitDir: string, ...flags: string[]): string[] {
  const [key, value] = storeHooksConfig(gitDir);
  return ["-c", `${key}=${value}`, "init", "-q", "--template=", ...flags];
}

/** Env for a store's `git init`: the files ref backend over a user's
 *  `init.defaultRefFormat`/`GIT_DEFAULT_REF_FORMAT`, since `storeHasRefs` and
 *  `releaseLooseRef` read refs as files. git before 2.45 ignores it and only
 *  knows files; `--ref-format` would make that git fail the init. */
export const STORE_INIT_ENV = { GIT_DEFAULT_REF_FORMAT: "files" } as const;

/** Sets `core.hooksPath` on a finished store that was set up before it was
 *  part of setup. Read without a git process, so a store that has it costs
 *  nothing; an unreadable config is left alone. */
export async function ensureStoreHooksPath(git: GitRunner, gitDir: string): Promise<void> {
  if ((await readStoreConfig(gitDir))?.has("core.hookspath") !== false) return;
  await git(["config", ...storeHooksConfig(gitDir)]).catch(() => undefined);
}

/** Config key naming the machine whose launches use a store (`localStoreHost`;
 *  the last machine to open the store wins). Eviction judges a store's source
 *  as vanished only on that machine: on a store root shared between machines
 *  (NFS/SMB home, WSL and Windows sharing `~/.omp`) a path missing here may be
 *  live there. */
export const STORE_HOST_KEY = "omp-undo-redo.host";

/** Config key naming the volume holding a store's source as
 *  `<device>:<levels up to its mount root>` (see `volumeOf`), so eviction can
 *  tell a source that is gone from one whose drive is unplugged or unmounted. */
export const STORE_VOLUME_KEY = "omp-undo-redo.volume";

/** `path`'s volume as `<device>:<levels>`: its device number, and how many
 *  levels up its mount root is, the topmost ancestor on the same device. Null
 *  when unreadable. */
export async function volumeOf(path: string): Promise<string | null> {
  try {
    const { dev } = await stat(path);
    let root = path;
    let levels = 0;
    for (let parent = dirname(root); parent !== root; parent = dirname(root)) {
      if ((await stat(parent)).dev !== dev) break;
      root = parent;
      levels += 1;
    }
    return `${dev}:${levels}`;
  } catch {
    return null;
  }
}

/** This machine's `STORE_HOST_KEY` and `STORE_VOLUME_KEY` entries for a store
 *  of `source`; each is omitted when unknown. */
export async function storeStampConfig(source: string): Promise<Array<[string, string]>> {
  const [host, volume] = await Promise.all([localStoreHost(), volumeOf(source)]);
  const entries: Array<[string, string]> = [];
  if (host) entries.push([STORE_HOST_KEY, host]);
  if (volume) entries.push([STORE_VOLUME_KEY, volume]);
  return entries;
}

/** Restamps a finished store whose stamps are missing (set up by an earlier
 *  version) or out of date (another machine opened it last, or its source's
 *  volume changed). Read without a git process, so an up-to-date store costs
 *  nothing; an unreadable config is left alone. */
export async function ensureStoreStamps(
  git: GitRunner,
  gitDir: string,
  source: string,
): Promise<void> {
  const config = await readStoreConfig(gitDir);
  if (!config) return;
  for (const [key, value] of await storeStampConfig(source)) {
    if (config.get(key) !== value) await git(["config", key, value]).catch(() => undefined);
  }
}
