import type {
  BlobCheckpoint,
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
import type { BlobApplyResult, BlobStore } from "./blob-store/index.js";

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
  blob(
    checkpoint: BlobCheckpoint,
    sourceTreeId: string,
    targetTreeId: string,
  ): Promise<BlobApplyResult>;
}

export interface CheckpointReleaser {
  git(checkpoints: readonly GitCheckpoint[]): Promise<boolean>;
  blob(checkpoints: readonly BlobCheckpoint[]): Promise<boolean>;
  blobShouldReleaseOnSuspend(checkpoint: BlobCheckpoint): Promise<boolean>;
}

export function blobNavigationApplier(store: BlobStore): Pick<CheckpointApplier, "blob"> {
  return {
    blob: (checkpoint, sourceTreeId, targetTreeId) =>
      store.applySnapshot(
        checkpoint.workspaceRoot,
        checkpoint.sessionHash,
        sourceTreeId,
        targetTreeId,
      ),
  };
}

export function blobNavigationReleaser(
  store: BlobStore,
): Pick<CheckpointReleaser, "blob" | "blobShouldReleaseOnSuspend"> {
  return {
    blob: (checkpoints) =>
      store.releaseCheckpointRefs(
        checkpoints[0]?.sessionHash ?? "",
        checkpoints.map((checkpoint) => checkpoint.checkpointId),
      ),
    blobShouldReleaseOnSuspend: async (checkpoint) =>
      store.hasActiveRefs(checkpoint.sessionHash, checkpoint.checkpointId),
  };
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
      blob: async () => ({ status: "failed" }),
      ...applier,
    };
    this.releaser = {
      git: (checkpoints) => releaseCheckpoints(this.gitForRepository, checkpoints),
      blob: async () => true,
      blobShouldReleaseOnSuspend: async () => true,
      ...releaser,
    };
    if (port.navigateTree) this.navigateTree = port.navigateTree.bind(port);
  }

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
    const expected = this.expectedTreeNavigation;
    if (expected && expected.oldLeafId === oldLeafId && expected.newLeafId === newLeafId) {
      this.expectedTreeNavigation = null;
      return;
    }
    if (oldLeafId === newLeafId) return;
    await this.invalidateRedo();
  }

  async invalidateRedo(): Promise<void> {
    const discarded = this.checkpoints.splice(this.currentIndex + 1);
    await this.persistState();
    await this.releaseFileCheckpoints(discarded);
  }

  private convertEarlierFileCheckpoints(): Array<GitCheckpoint | BlobCheckpoint> {
    const converted: Array<GitCheckpoint | BlobCheckpoint> = [];
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
    await Promise.allSettled([
      this.releaser.git(entries.filter((entry): entry is GitCheckpoint => entry.kind === "git")),
      this.releaser.blob(entries.filter((entry): entry is BlobCheckpoint => entry.kind === "blob")),
    ]);
  }

  async recordTurnEnd(checkpoint: TurnCheckpoint): Promise<void> {
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

  async dispose(release = true): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    if (!release) return;
    await this.persistState();
    await this.releaseFileCheckpoints(checkpoints);
  }

  async suspend(): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    const blobs = checkpoints.filter(
      (checkpoint): checkpoint is BlobCheckpoint => checkpoint.kind === "blob",
    );
    const releasableBlobs: BlobCheckpoint[] = [];
    for (const checkpoint of blobs) {
      if (await this.releaser.blobShouldReleaseOnSuspend(checkpoint))
        releasableBlobs.push(checkpoint);
    }
    await Promise.allSettled([
      this.releaser.git(
        checkpoints.filter(
          (checkpoint): checkpoint is GitCheckpoint =>
            checkpoint.kind === "git" &&
            !checkpoint.beforeRef.startsWith("refs/omp-undo-redo/history/"),
        ),
      ),
      this.releaser.blob(releasableBlobs),
    ]);
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
    checkpoint: GitCheckpoint | BlobCheckpoint,
    source: "before" | "after",
  ): Promise<{ status: "applied"; partial: boolean } | { status: "conflict" | "failed" }> {
    if (checkpoint.kind === "blob") {
      const result = await this.applier.blob(
        checkpoint,
        source === "before" ? checkpoint.afterTreeId : checkpoint.beforeTreeId,
        source === "before" ? checkpoint.beforeTreeId : checkpoint.afterTreeId,
      );
      return result;
    }
    const result = await this.applier.git(
      checkpoint,
      source === "before" ? checkpoint.afterHash : checkpoint.beforeHash,
      source === "before" ? checkpoint.beforeHash : checkpoint.afterHash,
    );
    return result === "applied" ? { status: "applied", partial: false } : { status: result };
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
        status: checkpoint.kind === "blob" ? "blob_failed" : "git_failed",
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
    return { status: "moved", files: applied.partial ? "partially_restored" : "restored" };
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
        status: checkpoint.kind === "blob" ? "blob_failed" : "git_failed",
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
    return { status: "moved", files: applied.partial ? "partially_restored" : "restored" };
  }
}
