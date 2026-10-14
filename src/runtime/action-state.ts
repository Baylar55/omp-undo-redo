import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { renameWithRetry, writeFileAtomic } from "../infra/fs.js";
import { debugLog } from "../infra/debug-log.js";
import type { ActionInvocationResult, NavigationState, RuntimeActionState } from "../types.js";
import { runtimeRootDirectory, defaultRuntimeRoot, checkpointNamespace } from "../infra/paths.js";
import { RUNTIME_SCHEMA, RUNTIME_PROTOCOL, reapStaleRuntimes } from "./reaper.js";
import type { RuntimeMarker } from "./reaper.js";

const ACTION_STATE_SCHEMA = 2;
const ACTION_STATE_PROTOCOL = "omp-undo-redo/action-state";
const MAX_STATE_BYTES = 64 * 1024;
type StoredActionState = RuntimeActionState & {
  schemaVersion: typeof ACTION_STATE_SCHEMA;
  protocol: typeof ACTION_STATE_PROTOCOL;
  sessionHash: string;
  runtimeId: string;
  pid: number;
  updatedAt: string;
};

type Projection = {
  state: NavigationState;
  activeSessionLeaf: string | null;
};

export type RuntimeActionStateStoreOptions = {
  rootDirectory?: string;
  pid?: number;
  runtimeId?: string;
  clock?: () => Date;
  uuid?: () => string;
};

function navigationRevision(state: NavigationState, activeSessionLeaf: string | null): string {
  const input = JSON.stringify({
    currentIndex: state.currentIndex,
    activeSessionLeaf,
    checkpoints: state.checkpoints.map(({ kind, parentLeafId, leafId }) => ({
      kind,
      parentLeafId,
      leafId,
    })),
  });
  return createHash("sha256").update(input).digest("hex");
}

/** One `runtime/<pid>/` serves every copy of the extension in a process: OMP
 *  binds a separate copy to each in-process subagent (and ACP) session, each
 *  with its own store and possibly its own evaluation of this module. The
 *  first copy in prepares the directory and writes the marker, whose runtime
 *  id every copy then publishes under; the last one out removes it. `tail`
 *  orders those steps, so a copy joining during a teardown keeps its
 *  directory. Held on `globalThis` because module state can be per copy.
 *  `foreign`: this process did not install the directory (it existed without
 *  this extension's marker, or installing failed), so it is left alone and
 *  nothing is published (copies that predate the field never set it). */
type SharedRuntimeDirectory = {
  users: number;
  runtimeId: string;
  tail: Promise<void>;
  foreign?: boolean;
};
const sharedRuntimeDirectories = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("omp-undo-redo/runtime-directories/v1")
] ??= new Map<string, SharedRuntimeDirectory>()) as Map<string, SharedRuntimeDirectory>;

export class RuntimeActionStateStore {
  private runtimeId: string;
  readonly pid: number;
  readonly runtimeDirectory: string;
  readonly sessionsDirectory: string;

  private readonly rootDirectory: string;
  private readonly clock: () => Date;
  private readonly uuid: () => string;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly latest = new Map<
    string,
    { projection: Projection; actionResult?: ActionInvocationResult }
  >();
  private ready: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private active = true;
  private shared: SharedRuntimeDirectory | null = null;

  constructor(options: RuntimeActionStateStoreOptions = {}) {
    this.rootDirectory = runtimeRootDirectory(options.rootDirectory);
    this.pid = options.pid ?? process.pid;
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.clock = options.clock ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.runtimeDirectory = join(this.rootDirectory, String(this.pid));
    this.sessionsDirectory = join(this.runtimeDirectory, "sessions");
  }

  sessionPath(sessionId: string): string {
    return this.sessionHashPath(checkpointNamespace(sessionId));
  }

  private sessionHashPath(sessionHash: string): string {
    return join(this.sessionsDirectory, `${sessionHash}.json`);
  }

  async initialize(): Promise<void> {
    if (this.shutdownPromise) return;
    if (!this.ready) this.ready = this.initializeInternal();
    await this.ready;
  }

  private async initializeInternal(): Promise<void> {
    let shared = sharedRuntimeDirectories.get(this.runtimeDirectory);
    if (!shared) {
      shared = { users: 0, runtimeId: this.runtimeId, tail: Promise.resolve() };
      sharedRuntimeDirectories.set(this.runtimeDirectory, shared);
    }
    this.shared = shared;
    shared.users += 1;
    if (shared.users === 1) {
      shared.runtimeId = this.runtimeId;
      shared.tail = shared.tail.then(() => this.prepareRuntimeDirectory(shared));
    }
    this.runtimeId = shared.runtimeId;
    await shared.tail;
  }

  private async prepareRuntimeDirectory(shared: SharedRuntimeDirectory): Promise<void> {
    shared.foreign = false;
    let staging: string | null = null;
    try {
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      // A configured root may be a shared directory (`/tmp` as root in a
      // container) whose permissions are not ours to strip; the per-process
      // directories below are owner-only either way.
      if (this.rootDirectory === defaultRuntimeRoot()) await chmod(this.rootDirectory, 0o700);
      // Only a directory a previous process with this pid left (a recycled
      // pid) is replaced. Anything else under that name is not ours to
      // delete; runtime state is observational, so this process skips it.
      if (!(await this.runtimeDirectoryReplaceable())) {
        shared.foreign = true;
        debugLog({ event: "runtime-dir-foreign", dir: this.runtimeDirectory });
        return;
      }
      // Built under a temporary name and renamed into place, so `runtime/<pid>/`
      // never exists without its marker: an unmarked one reads as foreign to
      // every later process with this pid, and the sweep never reaps it.
      staging = this.temporaryRuntimePath();
      const sessions = join(staging, "sessions");
      await mkdir(sessions, { recursive: true, mode: 0o700 });
      await chmod(staging, 0o700);
      await chmod(sessions, 0o700);
      const marker: RuntimeMarker = {
        schemaVersion: RUNTIME_SCHEMA,
        protocol: RUNTIME_PROTOCOL,
        runtimeId: this.runtimeId,
        pid: this.pid,
        hostname: hostname(),
        startedAt: this.clock().toISOString(),
      };
      await this.writeJsonAtomic(join(staging, "runtime.json"), marker);
      await this.discardRuntimeDirectory();
      await renameWithRetry(staging, this.runtimeDirectory);
      staging = null;
    } catch (error) {
      // Runtime state is observational. Keep extension operations independent;
      // a directory this process did not install is not its to write or remove.
      shared.foreign = true;
      debugLog({ event: "runtime-dir-failed", dir: this.runtimeDirectory, error: String(error) });
      if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    } finally {
      // Other processes' leftovers are reaped whether or not this one installed.
      this.scheduleStaleRuntimeSweep();
    }
  }

  /** `<root>/<pid>.<uuid>.tmp`: a runtime directory being installed or discarded.
   *  Not `this.uuid`: tests inject a constant one, and the staging and aside
   *  paths of one replacement must differ. */
  private temporaryRuntimePath(): string {
    return `${this.runtimeDirectory}.${randomUUID()}.tmp`;
  }

  /** Removes `runtime/<pid>/` without ever leaving it there unmarked: it is
   *  renamed aside first (a failed rename leaves it whole), and `sessions/`
   *  goes before the marker, so a leftover that keeps files keeps its marker
   *  and the sweep reaps it once its pid is dead. */
  private async discardRuntimeDirectory(): Promise<void> {
    const aside = this.temporaryRuntimePath();
    try {
      await renameWithRetry(this.runtimeDirectory, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await rm(join(aside, "sessions"), { recursive: true, force: true })
      .then(() => rm(aside, { recursive: true, force: true }))
      .catch(() => undefined);
  }

  /** `runtime/<pid>/` is absent, or holds this extension's runtime marker. */
  private async runtimeDirectoryReplaceable(): Promise<boolean> {
    try {
      await stat(this.runtimeDirectory);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    try {
      const marker = JSON.parse(
        await readFile(join(this.runtimeDirectory, "runtime.json"), "utf8"),
      ) as Partial<RuntimeMarker> | null;
      return marker?.protocol === RUNTIME_PROTOCOL;
    } catch {
      return false;
    }
  }

  private scheduleStaleRuntimeSweep(): void {
    const timer = setTimeout(() => {
      void this.reapStaleRuntimes().catch(() => undefined);
    }, 2_000);
    timer.unref?.();
  }

  private async reapStaleRuntimes(): Promise<void> {
    if (!this.active) return;
    return reapStaleRuntimes(this.rootDirectory, this.pid);
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) return;
    const temporary = join(dirname(path), `.${basename(path)}.${this.uuid()}.tmp`);
    await writeFileAtomic(path, temporary, serialized);
  }

  private enqueue(sessionHash: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(sessionHash) ?? Promise.resolve();
    const current = previous.then(operation, operation).catch(() => undefined);
    this.tails.set(sessionHash, current);
    void current.finally(() => {
      if (this.tails.get(sessionHash) === current) this.tails.delete(sessionHash);
    });
    return current;
  }

  private async writeSession(sessionHash: string): Promise<void> {
    const cached = this.latest.get(sessionHash);
    if (!cached) return;
    const state: StoredActionState = {
      schemaVersion: ACTION_STATE_SCHEMA,
      protocol: ACTION_STATE_PROTOCOL,
      sessionHash,
      runtimeId: this.runtimeId,
      pid: this.pid,
      updatedAt: this.clock().toISOString(),
      actions: [
        { id: "undo", enabled: cached.projection.state.currentIndex >= 0 },
        {
          id: "redo",
          enabled:
            cached.projection.state.currentIndex < cached.projection.state.checkpoints.length - 1,
        },
      ],
      sessionRevision: navigationRevision(
        cached.projection.state,
        cached.projection.activeSessionLeaf,
      ),
      activeSessionLeaf: cached.projection.activeSessionLeaf,
      ...(cached.actionResult ? { actionResult: cached.actionResult } : {}),
    };
    await this.writeJsonAtomic(this.sessionHashPath(sessionHash), state);
  }

  private async publishProjection(
    sessionId: string,
    state: NavigationState,
    activeSessionLeaf: string | null,
    preserveActionResult: boolean,
  ): Promise<void> {
    if (!this.active) return;
    await this.initialize();
    if (!this.active || this.shared?.foreign) return;
    const sessionHash = checkpointNamespace(sessionId);
    const prior = this.latest.get(sessionHash);
    this.latest.set(sessionHash, {
      projection: {
        state: { checkpoints: [...state.checkpoints], currentIndex: state.currentIndex },
        activeSessionLeaf,
      },
      ...(preserveActionResult && prior?.actionResult ? { actionResult: prior.actionResult } : {}),
    });
    await this.enqueue(sessionHash, () => this.writeSession(sessionHash));
  }

  async initializeSession(
    sessionId: string,
    state: NavigationState,
    activeSessionLeaf: string | null,
  ): Promise<void> {
    await this.publishProjection(sessionId, state, activeSessionLeaf, false);
  }

  async publishNavigation(
    sessionId: string,
    state: NavigationState,
    activeSessionLeaf: string | null,
  ): Promise<void> {
    await this.publishProjection(sessionId, state, activeSessionLeaf, true);
  }

  async publishActionResult(
    sessionId: string,
    state: NavigationState,
    activeSessionLeaf: string | null,
    result: ActionInvocationResult,
  ): Promise<void> {
    if (!this.active) return;
    await this.initialize();
    if (!this.active || this.shared?.foreign) return;
    const sessionHash = checkpointNamespace(sessionId);
    this.latest.set(sessionHash, {
      projection: {
        state: { checkpoints: [...state.checkpoints], currentIndex: state.currentIndex },
        activeSessionLeaf,
      },
      actionResult: result,
    });
    await this.enqueue(sessionHash, () => this.writeSession(sessionHash));
  }

  /** Forgets a session this process left (`/new`, `/resume`, fork, handoff):
   *  drops its projection and, behind its queued writes, its state file. A
   *  later publish (resumed again) queues behind this and writes it anew. */
  async releaseSession(sessionId: string): Promise<void> {
    const sessionHash = checkpointNamespace(sessionId);
    if (!this.latest.delete(sessionHash)) return;
    await this.enqueue(sessionHash, () => rm(this.sessionHashPath(sessionHash), { force: true }));
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.active = false;
    this.shutdownPromise = (async () => {
      if (this.ready) await this.ready;
      await Promise.all([...this.tails.values()]);
      const published = [...this.latest.keys()];
      this.latest.clear();
      this.tails.clear();
      const shared = this.shared;
      if (!shared) return;
      this.shared = null;
      shared.users -= 1;
      if (shared.users > 0) {
        await Promise.all(
          published.map((hash) => rm(this.sessionHashPath(hash), { force: true }).catch(() => {})),
        );
        return;
      }
      shared.tail = shared.tail.then(() =>
        shared.foreign ? undefined : this.discardRuntimeDirectory().catch(() => undefined),
      );
      await shared.tail;
    })();
    await this.shutdownPromise;
  }
}
