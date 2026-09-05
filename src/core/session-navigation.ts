import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  GitRunnerFactory,
  NavigationPort,
  NavigationResult,
  NavigationState,
  SessionOnlyCheckpoint,
  TreeNavigationResult,
  TurnCheckpoint,
} from "./types.js";
import { applyCheckpoint, releaseCheckpoints, type CheckpointApplyResult } from "./checkpoints.js";

export type NavigationOutcome = NavigationResult;

type ExpectedTreeNavigation = {
  oldLeafId: string | null;
  newLeafId: string | null;
};

export interface CheckpointApplier {
  git(
    checkpoint: GitCheckpoint,
    sourceHash: string,
    targetHash: string,
  ): Promise<CheckpointApplyResult>;
}

export interface CheckpointReleaser {
  git(checkpoints: readonly GitCheckpoint[]): Promise<boolean>;
}

export class SessionNavigation {
  private checkpoints: TurnCheckpoint[] = [];
  private currentIndex = -1;
  private navigateTree: NavigationPort["navigateTree"] = async () => ({ cancelled: true });
  private expectedTreeNavigation: ExpectedTreeNavigation | null = null;
  private readonly gitForRepository: GitRunnerFactory;
  private navigationTail: Promise<void> = Promise.resolve();
  private readonly stateChanged: (state: NavigationState) => Promise<void>;
  private readonly applier: CheckpointApplier;
  private readonly releaser: CheckpointReleaser;

  constructor(
    private readonly port: Omit<NavigationPort, "navigateTree"> & {
      navigateTree?: NavigationPort["navigateTree"];
    },
    git: GitRunner,
    gitFactory?: GitRunnerFactory,
    stateChanged?: (state: NavigationState) => Promise<void>,
    applier?: Partial<CheckpointApplier>,
    releaser?: Partial<CheckpointReleaser>,
  ) {
    this.gitForRepository = gitFactory ?? ((_repository: GitRepository) => git);
    this.stateChanged = stateChanged ?? (async () => undefined);
    this.applier = {
      git: (checkpoint, sourceHash, targetHash) =>
        applyCheckpoint(this.gitForRepository(checkpoint.repository), sourceHash, targetHash),
      ...applier,
    };
    this.releaser = {
      git: (checkpoints) => releaseCheckpoints(this.gitForRepository, checkpoints),
      ...releaser,
    };
    if (port.navigateTree) this.navigateTree = port.navigateTree.bind(port);
  }

  /** Teardown-only: runs outside the navigation chain. Callers guarantee no
   *  concurrent undo/redo/turn finalization touches this instance yet
   *  (initializeNavigation owns the object until it publishes it). */
  restoreState(state: NavigationState): void {
    this.checkpoints = [...state.checkpoints];
    this.currentIndex = state.currentIndex;
  }

  snapshot(): NavigationState {
    return { checkpoints: [...this.checkpoints], currentIndex: this.currentIndex };
  }

  private async persistState(): Promise<void> {
    await this.stateChanged({
      checkpoints: [...this.checkpoints],
      currentIndex: this.currentIndex,
    }).catch(() => undefined);
  }

  setNavigateTree(navigateTree: NavigationPort["navigateTree"]): void {
    this.navigateTree = navigateTree;
  }

  private serializeNavigation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.navigationTail.then(operation);
    this.navigationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async navigateTo(targetId: string): Promise<TreeNavigationResult> {
    this.expectedTreeNavigation = {
      oldLeafId: this.port.getLeafId(),
      newLeafId: targetId,
    };
    try {
      return await this.navigateTree(targetId);
    } catch {
      return { cancelled: true };
    } finally {
      this.expectedTreeNavigation = null;
    }
  }

  async handleSessionTreeNavigation(
    oldLeafId: string | null,
    newLeafId: string | null,
  ): Promise<void> {
    // Must run before any queueing: the host awaits this handler inside its
    // navigateTree call, so an undo/redo's own navigation has to be recognized
    // synchronously or it would deadlock against itself on navigationTail.
    const expected = this.expectedTreeNavigation;
    if (expected && expected.oldLeafId === oldLeafId && expected.newLeafId === newLeafId) {
      this.expectedTreeNavigation = null;
      return;
    }
    if (oldLeafId === newLeafId) return;
    await this.serializeNavigation(() => this.performInvalidateRedo());
  }

  async invalidateRedo(): Promise<void> {
    await this.serializeNavigation(() => this.performInvalidateRedo());
  }

  private async performInvalidateRedo(): Promise<void> {
    const discarded = this.checkpoints.splice(this.currentIndex + 1);
    await this.persistState();
    await this.releaseFileCheckpoints(discarded);
  }

  private convertEarlierFileCheckpoints(): GitCheckpoint[] {
    const converted: GitCheckpoint[] = [];
    for (let index = 0; index < this.checkpoints.length; index++) {
      const entry = this.checkpoints[index];
      if (entry.kind === "session") continue;
      converted.push(entry);
      this.checkpoints[index] = {
        kind: "session",
        reason: "file_history_gap",
        parentLeafId: entry.parentLeafId,
        leafId: entry.leafId,
      };
    }
    return converted;
  }

  private async releaseFileCheckpoints(entries: readonly TurnCheckpoint[]): Promise<void> {
    await this.releaser.git(
      entries.filter((entry): entry is GitCheckpoint => entry.kind === "git"),
    );
  }

  async recordTurnEnd(checkpoint: TurnCheckpoint): Promise<void> {
    await this.serializeNavigation(() => this.performRecordTurnEnd(checkpoint));
  }

  private async performRecordTurnEnd(checkpoint: TurnCheckpoint): Promise<void> {
    const discarded = this.checkpoints.splice(
      this.currentIndex + 1,
      this.checkpoints.length - this.currentIndex - 1,
    );
    const converted = checkpoint.kind === "session" ? this.convertEarlierFileCheckpoints() : [];
    this.checkpoints.push(checkpoint);
    this.currentIndex = this.checkpoints.length - 1;
    await this.persistState();
    await this.releaseFileCheckpoints([...discarded, ...converted]);
  }

  /** Teardown-only: runs outside the navigation chain (session_shutdown /
   *  session_start replacement paths, which exclude concurrent navigation). */
  async dispose(release = true): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    if (!release) return;
    await this.persistState();
    await this.releaseFileCheckpoints(checkpoints);
  }

  /** Teardown-only: runs outside the navigation chain (suspend/resume path). */
  async suspend(): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    await this.releaser.git(
      checkpoints.filter(
        (checkpoint): checkpoint is GitCheckpoint =>
          checkpoint.kind === "git" &&
          !checkpoint.beforeRef.startsWith("refs/omp-undo-redo/history/"),
      ),
    );
  }

  private async navigateSession(targetId: string | null): Promise<boolean> {
    if (!targetId) return true;
    const result = await this.navigateTo(targetId);
    return !result.cancelled;
  }

  private sessionOnlyResult(checkpoint: SessionOnlyCheckpoint): NavigationResult {
    return { status: "moved", files: "unavailable", reason: checkpoint.reason };
  }

  private async applyFileCheckpoint(
    checkpoint: GitCheckpoint,
    source: "before" | "after",
  ): Promise<{ status: "applied" } | { status: "conflict" | "failed" }> {
    const result = await this.applier.git(
      checkpoint,
      source === "before" ? checkpoint.afterHash : checkpoint.beforeHash,
      source === "before" ? checkpoint.beforeHash : checkpoint.afterHash,
    );
    return result === "applied" ? { status: "applied" } : { status: result };
  }

  undo(): Promise<NavigationResult> {
    return this.serializeNavigation(() => this.performUndo());
  }

  private async performUndo(): Promise<NavigationResult> {
    if (this.currentIndex < 0) return { status: "empty" };
    const checkpoint = this.checkpoints[this.currentIndex];
    if (checkpoint.kind === "session") {
      if (!(await this.navigateSession(checkpoint.parentLeafId))) return { status: "cancelled" };
      this.currentIndex--;
      await this.persistState();
      return this.sessionOnlyResult(checkpoint);
    }

    const applied = await this.applyFileCheckpoint(checkpoint, "before");
    if (applied.status !== "applied") {
      return {
        status: "git_failed",
        failure: applied.status === "conflict" ? "conflict" : "failed",
      };
    }
    if (!(await this.navigateSession(checkpoint.parentLeafId))) {
      const compensated = await this.applyFileCheckpoint(checkpoint, "after");
      if (compensated.status !== "applied") return { status: "rollback_failed" };
      return { status: "cancelled" };
    }
    this.currentIndex--;
    await this.persistState();
    return { status: "moved", files: "restored" };
  }

  redo(): Promise<NavigationResult> {
    return this.serializeNavigation(() => this.performRedo());
  }

  private async performRedo(): Promise<NavigationResult> {
    if (this.currentIndex >= this.checkpoints.length - 1) return { status: "empty" };
    const checkpoint = this.checkpoints[this.currentIndex + 1];
    if (checkpoint.kind === "session") {
      if (!(await this.navigateSession(checkpoint.leafId))) return { status: "cancelled" };
      this.currentIndex++;
      await this.persistState();
      return this.sessionOnlyResult(checkpoint);
    }

    const applied = await this.applyFileCheckpoint(checkpoint, "after");
    if (applied.status !== "applied") {
      return {
        status: "git_failed",
        failure: applied.status === "conflict" ? "conflict" : "failed",
      };
    }
    if (!(await this.navigateSession(checkpoint.leafId))) {
      const compensated = await this.applyFileCheckpoint(checkpoint, "before");
      if (compensated.status !== "applied") return { status: "rollback_failed" };
      return { status: "cancelled" };
    }
    this.currentIndex++;
    await this.persistState();
    return { status: "moved", files: "restored" };
  }
}
