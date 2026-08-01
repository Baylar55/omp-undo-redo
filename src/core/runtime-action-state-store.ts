import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { checkpointNamespace } from "./checkpoints.js";
import type { ActionInvocationResult, NavigationState, RuntimeActionState } from "./types.js";

const RUNTIME_SCHEMA = 1;
const ACTION_STATE_SCHEMA = 2;
const RUNTIME_PROTOCOL = "omp-undo-redo/runtime";
const ACTION_STATE_PROTOCOL = "omp-undo-redo/action-state";
const MAX_STATE_BYTES = 64 * 1024;

type RuntimeMarker = {
  schemaVersion: typeof RUNTIME_SCHEMA;
  protocol: typeof RUNTIME_PROTOCOL;
  runtimeId: string;
  pid: number;
  startedAt: string;
};

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
  now?: () => Date;
  uuid?: () => string;
  maxStateBytes?: number;
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

export function runtimeRootDirectory(
  rootDirectory = process.env.OMP_UNDO_REDO_RUNTIME_DIR,
): string {
  return resolve(rootDirectory ?? join(homedir(), ".omp", "omp-undo-redo", "runtime"));
}

export class RuntimeActionStateStore {
  readonly runtimeId: string;
  readonly pid: number;
  readonly runtimeDirectory: string;
  readonly sessionsDirectory: string;

  private readonly rootDirectory: string;
  private readonly clock: () => Date;
  private readonly uuid: () => string;
  private readonly maxStateBytes: number;
  private readonly tails = new Map<string, Promise<void>>();
  private readonly latest = new Map<
    string,
    { projection: Projection; actionResult?: ActionInvocationResult }
  >();
  private ready: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private active = true;
  private ownsRuntimeDirectory = false;

  constructor(options: RuntimeActionStateStoreOptions = {}) {
    this.rootDirectory = runtimeRootDirectory(options.rootDirectory);
    this.pid = options.pid ?? process.pid;
    this.runtimeId = options.runtimeId ?? randomUUID();
    this.clock = options.clock ?? options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.maxStateBytes = options.maxStateBytes ?? MAX_STATE_BYTES;
    this.runtimeDirectory = join(this.rootDirectory, String(this.pid));
    this.sessionsDirectory = join(this.runtimeDirectory, "sessions");
  }

  get isActive(): boolean {
    return this.active;
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
    try {
      await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.rootDirectory, 0o700);
      await rm(this.runtimeDirectory, { recursive: true, force: true });
      await mkdir(this.sessionsDirectory, { recursive: true, mode: 0o700 });
      await chmod(this.runtimeDirectory, 0o700);
      await chmod(this.sessionsDirectory, 0o700);
      this.ownsRuntimeDirectory = true;
      const marker: RuntimeMarker = {
        schemaVersion: RUNTIME_SCHEMA,
        protocol: RUNTIME_PROTOCOL,
        runtimeId: this.runtimeId,
        pid: this.pid,
        startedAt: this.clock().toISOString(),
      };
      await this.writeJsonAtomic(join(this.runtimeDirectory, "runtime.json"), marker);
    } catch {
      // Runtime state is observational. Keep extension operations independent.
    }
  }

  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > this.maxStateBytes) return;
    const temporary = join(dirname(path), `.${basename(path)}.${this.uuid()}.tmp`);
    try {
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
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
    if (!this.active) return;
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
    if (!this.active) return;
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

  async removeSession(sessionId: string): Promise<void> {
    if (!this.active) return;
    await this.initialize();
    const sessionHash = checkpointNamespace(sessionId);
    this.latest.delete(sessionHash);
    await this.enqueue(sessionHash, async () => {
      await rm(this.sessionHashPath(sessionHash), { force: true });
    });
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.active = false;
    this.shutdownPromise = (async () => {
      if (this.ready) await this.ready;
      await Promise.all([...this.tails.values()]);
      this.latest.clear();
      this.tails.clear();
      if (this.ownsRuntimeDirectory) {
        await rm(this.runtimeDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
      this.ownsRuntimeDirectory = false;
    })();
    await this.shutdownPromise;
  }
}

export { MAX_STATE_BYTES };
