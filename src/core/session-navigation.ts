import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  GitRunnerFactory,
  NavigationPort,
  NavigationResult,
  SessionOnlyCheckpoint,
  TreeNavigationResult,
  TurnCheckpoint,
} from "./types.js";
import { applyCheckpoint, releaseCheckpoints } from "./checkpoints.js";

export type NavigationOutcome = NavigationResult;

type ExpectedTreeNavigation = {
  oldLeafId: string | null;
  newLeafId: string | null;
};

export class SessionNavigation {
  private checkpoints: TurnCheckpoint[] = [];
  private currentIndex = -1;
  private navigateTree: NavigationPort["navigateTree"] = async () => ({ cancelled: true });
  private expectedTreeNavigation: ExpectedTreeNavigation | null = null;
  private readonly gitForRepository: GitRunnerFactory;
  private navigationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly port: Omit<NavigationPort, "navigateTree"> & {
      navigateTree?: NavigationPort["navigateTree"];
    },
    git: GitRunner,
    gitFactory?: GitRunnerFactory,
  ) {
    this.gitForRepository = gitFactory ?? ((_repository: GitRepository) => git);
    if (port.navigateTree) this.navigateTree = port.navigateTree.bind(port);
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
    await releaseCheckpoints(
      this.gitForRepository,
      discarded.filter((checkpoint): checkpoint is GitCheckpoint => checkpoint.kind === "git"),
    );
  }

  private convertEarlierGitCheckpoints(): GitCheckpoint[] {
    const converted: GitCheckpoint[] = [];
    for (let index = 0; index < this.checkpoints.length; index++) {
      const entry = this.checkpoints[index];
      if (entry.kind !== "git") continue;
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

  async recordTurnEnd(checkpoint: TurnCheckpoint): Promise<void> {
    const discarded = this.checkpoints.splice(
      this.currentIndex + 1,
      this.checkpoints.length - this.currentIndex - 1,
    );
    const converted = checkpoint.kind === "session" ? this.convertEarlierGitCheckpoints() : [];
    this.checkpoints.push(checkpoint);
    this.currentIndex = this.checkpoints.length - 1;
    await releaseCheckpoints(this.gitForRepository, [
      ...discarded.filter((entry): entry is GitCheckpoint => entry.kind === "git"),
      ...converted,
    ]);
  }

  async dispose(): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    await releaseCheckpoints(
      this.gitForRepository,
      checkpoints.filter((checkpoint): checkpoint is GitCheckpoint => checkpoint.kind === "git"),
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

  undo(): Promise<NavigationResult> {
    return this.serializeNavigation(() => this.performUndo());
  }

  private async performUndo(): Promise<NavigationResult> {
    if (this.currentIndex < 0) return { status: "empty" };
    const checkpoint = this.checkpoints[this.currentIndex];
    if (checkpoint.kind === "session") {
      if (!(await this.navigateSession(checkpoint.parentLeafId))) return { status: "cancelled" };
      this.currentIndex--;
      return this.sessionOnlyResult(checkpoint);
    }

    const git = this.gitForRepository(checkpoint.repository);
    const applied = await applyCheckpoint(git, checkpoint.afterHash, checkpoint.beforeHash);
    if (applied !== "applied") {
      return { status: "git_failed", failure: applied === "conflict" ? "conflict" : "failed" };
    }
    if (!(await this.navigateSession(checkpoint.parentLeafId))) {
      const compensated = await applyCheckpoint(git, checkpoint.beforeHash, checkpoint.afterHash);
      if (compensated !== "applied") return { status: "rollback_failed" };
      return { status: "cancelled" };
    }
    this.currentIndex--;
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
      return this.sessionOnlyResult(checkpoint);
    }

    const git = this.gitForRepository(checkpoint.repository);
    const applied = await applyCheckpoint(git, checkpoint.beforeHash, checkpoint.afterHash);
    if (applied !== "applied") {
      return { status: "git_failed", failure: applied === "conflict" ? "conflict" : "failed" };
    }
    if (!(await this.navigateSession(checkpoint.leafId))) {
      const compensated = await applyCheckpoint(git, checkpoint.afterHash, checkpoint.beforeHash);
      if (compensated !== "applied") return { status: "rollback_failed" };
      return { status: "cancelled" };
    }
    this.currentIndex++;
    return { status: "moved", files: "restored" };
  }
}
