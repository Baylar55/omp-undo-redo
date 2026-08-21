import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, readlink, rename, rm, stat } from "node:fs/promises";
import { hostname as systemHostname, homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import type { GitRepository, GitRunner, GitCommandResult, OwnershipMode } from "./types.js";

export const CHECKPOINT_OWNER_REF_ROOT = "refs/omp-undo-redo/v2";
export const CHECKPOINT_OWNER_LEASE_SCHEMA = 1;
const MAX_LEASE_BYTES = 64 * 1024;
const DEFAULT_CLEANUP_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_WAIT_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUNTIME_SCOPE_PATTERN = /^[0-9a-f]{64}$/;

export interface ParsedCheckpointRef {
  ownerId: string;
  sessionHash: string;
  checkpointId: string;
  phase: "before" | "after";
}

export interface CheckpointOwnerLease {
  schemaVersion: 1;
  ownerId: string;
  hostId: string;
  hostname: string;
  runtimeScope: string;
  pid: number;
  startedAt: string;
}

export type LeaseClassification = "alive" | "remote" | "stale" | "unknown";

export interface HostIdentity {
  id: string | null;
  persistent: boolean;
}

export interface HostIdentityOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  randomId?: () => string;
  readFile?: typeof readFile;
  readlink?: typeof readlink;
}

export interface LivenessOptions {
  currentOwnerId: string;
  currentHostId: string | null;
  currentHostname: string;
  currentRuntimeScope: string | null;
  probePid?: (pid: number) => void;
}

export interface OwnerRegistryOptions {
  ownerId?: string;
  hostIdentity?: HostIdentity;
  hostname?: string;
  runtimeScope?: string | null;
  maxConcurrentOwners?: number;
  cleanupTimeoutMs?: number;
  shutdownWaitMs?: number;
  now?: () => Date;
  resolveHostIdentity?: () => Promise<HostIdentity>;
  resolveRuntimeScope?: () => Promise<string | null>;
  probePid?: (pid: number) => void;
}

export function isCanonicalUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isSha256Hash(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

export function isGitObjectId(value: string): boolean {
  return OBJECT_ID_PATTERN.test(value);
}

export function parseCheckpointOwnerRef(ref: string): ParsedCheckpointRef | null {
  const parts = ref.split("/");
  if (parts.length !== 7) return null;
  if (parts.slice(0, 3).join("/") !== CHECKPOINT_OWNER_REF_ROOT) return null;
  const [, , , ownerId, sessionHash, checkpointId, phase] = parts;
  if (!isCanonicalUuid(ownerId) || !isSha256Hash(sessionHash) || !isCanonicalUuid(checkpointId)) {
    return null;
  }
  if (phase !== "before" && phase !== "after") return null;
  return { ownerId, sessionHash, checkpointId, phase };
}

export function ownerCheckpointPrefix(ownerId: string): string | null {
  return isCanonicalUuid(ownerId) ? `${CHECKPOINT_OWNER_REF_ROOT}/${ownerId}/` : null;
}

export function parseCheckpointOwnerLease(
  filename: string,
  contents: string,
): CheckpointOwnerLease | null {
  if (!filename.endsWith(".json")) return null;
  const filenameOwner = filename.slice(0, -5);
  if (!isCanonicalUuid(filenameOwner) || Buffer.byteLength(contents, "utf8") > MAX_LEASE_BYTES)
    return null;
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (keys !== "hostId,hostname,ownerId,pid,runtimeScope,schemaVersion,startedAt") return null;
  if (
    record.schemaVersion !== CHECKPOINT_OWNER_LEASE_SCHEMA ||
    record.ownerId !== filenameOwner ||
    typeof record.ownerId !== "string" ||
    !isCanonicalUuid(record.ownerId) ||
    typeof record.hostId !== "string" ||
    !isCanonicalUuid(record.hostId) ||
    typeof record.hostname !== "string" ||
    record.hostname.length === 0 ||
    record.hostname.length > 255 ||
    typeof record.pid !== "number" ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.runtimeScope !== "string" ||
    !RUNTIME_SCOPE_PATTERN.test(record.runtimeScope) ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) {
    return null;
  }
  return record as unknown as CheckpointOwnerLease;
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

async function writeExclusive(path: string, contents: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.close();
    return true;
  } catch {
    await handle?.close().catch(() => undefined);
    return false;
  }
}

export async function resolvePersistentHostId(
  options: HostIdentityOptions = {},
): Promise<HostIdentity> {
  const path = hostIdentityPath(options);
  // A2: reap leaked host-id.*.tmp files from prior crashed attempts (fire-and-forget, <1ms)
  try {
    const hostDir = dirname(path);
    const hostEntries = await readdir(hostDir, { withFileTypes: true }).catch(() => null);
    if (hostEntries) {
      const tmpPattern = /^host-id\.[0-9a-f-]{36}\.tmp$/;
      await Promise.all(
        hostEntries
          .filter((e) => e.isFile() && tmpPattern.test(e.name))
          .map((e) => rm(join(hostDir, e.name), { force: true }).catch(() => undefined)),
      );
    }
  } catch {
    // Best-effort cleanup
  }
  const existing = await readValidUuid(path);
  if (existing === "unreadable") return { id: null, persistent: false };
  if (existing) return { id: existing, persistent: true };
  const id = (options.randomId ?? randomUUID)();
  if (!isCanonicalUuid(id)) return { id: null, persistent: false };
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (!(await writeExclusive(temporary, `${id}\n`))) {
      const winner = await readValidUuid(path);
      return winner && winner !== "unreadable"
        ? { id: winner, persistent: true }
        : { id: null, persistent: false };
    }
    try {
      await link(temporary, path);
      await rm(temporary, { force: true });
      return { id, persistent: true };
    } catch {
      const winner = await readValidUuid(path);
      return winner && winner !== "unreadable"
        ? { id: winner, persistent: true }
        : { id: null, persistent: false };
    }
  } catch {
    return { id: null, persistent: false };
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function resolveRuntimeScope(
  options: HostIdentityOptions = {},
): Promise<string | null> {
  const selectedPlatform = options.platform ?? platform();
  if (selectedPlatform !== "linux") {
    return createHash("sha256").update(`native-process-table:${selectedPlatform}`).digest("hex");
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

export function classifyCheckpointOwner(
  lease: CheckpointOwnerLease,
  options: LivenessOptions,
): LeaseClassification {
  if (lease.ownerId === options.currentOwnerId) return "alive";
  if (!options.currentHostId || !options.currentRuntimeScope) return "unknown";
  if (
    lease.hostId !== options.currentHostId ||
    lease.hostname !== options.currentHostname ||
    lease.runtimeScope !== options.currentRuntimeScope
  )
    return "remote";
  try {
    (options.probePid ?? ((pid) => process.kill(pid, 0)))(lease.pid);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "stale";
    return "unknown";
  }
}

function leaseDirectory(repository: GitRepository): string {
  return join(repository.commonDir, "omp-undo-redo", "owners");
}

function leasePath(repository: GitRepository, ownerId: string): string {
  return join(leaseDirectory(repository), `${ownerId}.json`);
}

function leaseContents(
  ownerId: string,
  hostId: string,
  hostname: string,
  runtimeScope: string,
  now: () => Date,
): string {
  return JSON.stringify({
    schemaVersion: CHECKPOINT_OWNER_LEASE_SCHEMA,
    ownerId,
    hostId,
    hostname,
    pid: process.pid,
    runtimeScope,
    startedAt: now().toISOString(),
  });
}
async function removeCurrentOwnerTemporaryFiles(directory: string, ownerId: string): Promise<void> {
  const pattern = new RegExp(`^\\.${ownerId}\\.[0-9a-f-]{36}\\.tmp$`);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => rm(join(directory, entry.name), { force: true }).catch(() => undefined)),
  );
}

async function publishLease(
  repository: GitRepository,
  ownerId: string,
  hostId: string,
  hostname: string,
  runtimeScope: string,
  now: () => Date,
): Promise<boolean> {
  const directory = leaseDirectory(repository);
  const finalPath = leasePath(repository, ownerId);
  const temporary = join(directory, `.${ownerId}.${randomUUID()}.tmp`);
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await removeCurrentOwnerTemporaryFiles(directory, ownerId);
    if (
      !(await writeExclusive(
        temporary,
        leaseContents(ownerId, hostId, hostname, runtimeScope, now),
      ))
    )
      return false;
    await rename(temporary, finalPath);
    return true;
  } catch {
    return false;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function enumerateOwnerRefs(
  git: GitRunner,
  repository: GitRepository,
  ownerId: string,
  timeoutMs: number,
): Promise<{ ok: true; refs: Array<{ ref: string; expectedHash: string }> } | { ok: false }> {
  const prefix = ownerCheckpointPrefix(ownerId);
  if (!prefix) return { ok: false };
  let result: GitCommandResult;
  try {
    result = await git(["for-each-ref", "--format=%(refname)%00%(objectname)", prefix], {
      env: { GIT_DIR: repository.commonDir },
      timeoutMs,
    });
  } catch {
    return { ok: false };
  }
  if (result.error || result.code !== 0) return { ok: false };
  const refs: Array<{ ref: string; expectedHash: string }> = [];
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf("\0");
    if (separator < 0 || line.indexOf("\0", separator + 1) >= 0) return { ok: false };
    const ref = line.slice(0, separator);
    const expectedHash = line.slice(separator + 1);
    const parsed = parseCheckpointOwnerRef(ref);
    if (!parsed || parsed.ownerId !== ownerId || !isGitObjectId(expectedHash)) return { ok: false };
    refs.push({ ref, expectedHash });
  }
  return { ok: true, refs };
}

async function deleteOwnerRefs(
  git: GitRunner,
  repository: GitRepository,
  refs: readonly { ref: string; expectedHash: string }[],
  timeoutMs: number,
): Promise<"ok" | "failed" | "timeout"> {
  if (refs.length === 0) return "ok";
  const input = refs.map(({ ref, expectedHash }) => `delete ${ref} ${expectedHash}`).join("\n");
  let result: GitCommandResult;
  try {
    result = await git(["update-ref", "--stdin"], {
      env: { GIT_DIR: repository.commonDir },
      stdin: `${input}\n`,
      timeoutMs,
    });
  } catch {
    return "failed";
  }
  if (result.error === "timeout") return "timeout";
  if (result.code === 0) return "ok";
  if (refs.length === 1) return "failed";
  const midpoint = Math.ceil(refs.length / 2);
  const left = await deleteOwnerRefs(git, repository, refs.slice(0, midpoint), timeoutMs);
  if (left === "timeout") return "timeout";
  const right = await deleteOwnerRefs(git, repository, refs.slice(midpoint), timeoutMs);
  if (right === "timeout") return "timeout";
  return left === "ok" && right === "ok" ? "ok" : "failed";
}

async function cleanupStaleOwner(
  git: GitRunner,
  repository: GitRepository,
  ownerId: string,
  timeoutMs: number,
): Promise<void> {
  const first = await enumerateOwnerRefs(git, repository, ownerId, timeoutMs);
  if (!first.ok) return;
  const deletion = await deleteOwnerRefs(git, repository, first.refs, timeoutMs);
  if (deletion === "timeout") return;
  const second = await enumerateOwnerRefs(git, repository, ownerId, timeoutMs);
  if (!second.ok || second.refs.length !== 0) return;
  await rm(leasePath(repository, ownerId), { force: true }).catch(() => undefined);
}

export class CheckpointOwnerRegistry {
  readonly ownerId: string;
  private readonly hostname: string;
  private readonly options: Required<
    Pick<OwnerRegistryOptions, "maxConcurrentOwners" | "cleanupTimeoutMs" | "shutdownWaitMs">
  >;
  private readonly now: () => Date;
  private readonly probePid: (pid: number) => void;
  private readonly hostIdentityPromise: Promise<HostIdentity>;
  private readonly runtimeScopePromise: Promise<string | null>;
  private readonly initializations = new Map<string, Promise<OwnershipMode>>();
  private readonly initialized = new Map<string, { repository: GitRepository; git: GitRunner }>();
  private readonly scans = new Set<Promise<void>>();
  constructor(options: OwnerRegistryOptions = {}) {
    const configuredOwnerId = options.ownerId;
    this.ownerId =
      configuredOwnerId && isCanonicalUuid(configuredOwnerId) ? configuredOwnerId : randomUUID();
    this.hostname = options.hostname ?? systemHostname();
    this.options = {
      maxConcurrentOwners: Math.max(1, options.maxConcurrentOwners ?? 4),
      cleanupTimeoutMs: Math.max(1, options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS),
      shutdownWaitMs: Math.max(1, options.shutdownWaitMs ?? DEFAULT_SHUTDOWN_WAIT_MS),
    };
    this.now = options.now ?? (() => new Date());
    this.probePid = options.probePid ?? ((pid) => process.kill(pid, 0));
    this.hostIdentityPromise = (
      options.resolveHostIdentity
        ? options.resolveHostIdentity()
        : Promise.resolve(options.hostIdentity ?? { id: null, persistent: false })
    ).catch(() => ({ id: null, persistent: false }));
    this.runtimeScopePromise = (
      options.resolveRuntimeScope
        ? options.resolveRuntimeScope()
        : Promise.resolve(options.runtimeScope ?? null)
    ).catch(() => null);
  }

  async ensureInitialized(repository: GitRepository, git: GitRunner): Promise<OwnershipMode> {
    const key = repository.commonDir;
    if (this.initialized.has(key)) return "v2";
    const existing = this.initializations.get(key);
    if (existing) return existing;
    const attempt = this.initialize(repository, git);
    this.initializations.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this.initializations.delete(key);
    }
  }

  private async initialize(repository: GitRepository, git: GitRunner): Promise<OwnershipMode> {
    const [host, resolvedRuntimeScope] = await Promise.all([
      this.hostIdentityPromise,
      this.runtimeScopePromise,
    ]);
    const hostId = host.id ?? randomUUID();
    const leaseRuntimeScope =
      resolvedRuntimeScope ?? createHash("sha256").update(randomUUID()).digest("hex");
    if (
      !(await publishLease(
        repository,
        this.ownerId,
        hostId,
        this.hostname,
        leaseRuntimeScope,
        this.now,
      ))
    )
      return "legacy";
    this.initialized.set(repository.commonDir, { repository, git });
    if (host.persistent && resolvedRuntimeScope)
      this.startScan(repository, git, hostId, resolvedRuntimeScope);
    return "v2";
  }

  private startScan(
    repository: GitRepository,
    git: GitRunner,
    hostId: string,
    runtimeScope: string,
  ): void {
    const scan = this.scan(repository, git, hostId, runtimeScope).catch(() => undefined);
    this.scans.add(scan);
    void scan.finally(() => this.scans.delete(scan));
  }

  private async scan(
    repository: GitRepository,
    git: GitRunner,
    hostId: string,
    runtimeScope: string,
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(leaseDirectory(repository), { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
      return;
    }
    const candidates: Array<{ ownerId: string }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = join(leaseDirectory(repository), entry.name);
      const metadata = await stat(filePath).catch(() => null);
      if (!metadata || metadata.size > MAX_LEASE_BYTES) continue;
      const contents = await readFile(filePath, "utf8").catch(() => null);
      if (contents === null) continue;
      const lease = parseCheckpointOwnerLease(entry.name, contents);
      if (!lease) continue;
      const classification = classifyCheckpointOwner(lease, {
        currentOwnerId: this.ownerId,
        currentHostId: hostId,
        currentHostname: this.hostname,
        currentRuntimeScope: runtimeScope,
        probePid: this.probePid,
      });
      if (classification === "stale") candidates.push({ ownerId: lease.ownerId });
    }
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const candidate = candidates[next++];
        await cleanupStaleOwner(git, repository, candidate.ownerId, this.options.cleanupTimeoutMs);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.options.maxConcurrentOwners, candidates.length) }, worker),
    );
  }

  async shutdown(): Promise<void> {
    const scans = [...this.scans];
    if (scans.length > 0) {
      await Promise.race([Promise.allSettled(scans), delay(this.options.shutdownWaitMs)]);
    }
    for (const { repository, git } of this.initialized.values()) {
      const refs = await enumerateOwnerRefs(
        git,
        repository,
        this.ownerId,
        this.options.cleanupTimeoutMs,
      );
      if (!refs.ok || refs.refs.length !== 0) continue;
      await rm(leasePath(repository, this.ownerId), { force: true }).catch(() => undefined);
    }
    this.initialized.clear();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
