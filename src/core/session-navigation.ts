import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  GitRunnerFactory,
  NavigationPort,
  NavigationResult,
} from "./types.js";
import { applyCheckpoint, releaseCheckpoints } from "./checkpoints.js";

export type NavigationOutcome = "moved" | "empty" | "cancelled" | "git_failed" | "rollback_failed";

type GitFailure = "conflict" | "failed" | "rollback_failed";

type ExpectedTreeNavigation = {
  oldLeafId: string | null;
  newLeafId: string | null;
};

export class SessionNavigation {
  private checkpoints: GitCheckpoint[] = [];
  private currentIndex = -1;
  private navigateTree: NavigationPort["navigateTree"] = async () => ({ cancelled: true });
  private expectedTreeNavigation: ExpectedTreeNavigation | null = null;
  private lastGitFailure: GitFailure | null = null;
  private readonly gitForRepository: GitRunnerFactory;

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

  private async navigateTo(targetId: string): Promise<NavigationResult> {
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
    await releaseCheckpoints(this.gitForRepository, discarded);
  }

  getLastGitFailure(): GitFailure | null {
    return this.lastGitFailure;
  }

  async recordTurnEnd(checkpoint: GitCheckpoint): Promise<void> {
    const discarded = this.checkpoints.splice(
      this.currentIndex + 1,
      this.checkpoints.length - this.currentIndex - 1,
    );
    this.checkpoints.push(checkpoint);
    this.currentIndex = this.checkpoints.length - 1;
    await releaseCheckpoints(this.gitForRepository, discarded);
  }

  async dispose(): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    await releaseCheckpoints(this.gitForRepository, checkpoints);
  }

  async undo(): Promise<NavigationOutcome> {
    this.lastGitFailure = null;
    if (this.currentIndex < 0) return "empty";
    const checkpoint = this.checkpoints[this.currentIndex];
    const git = this.gitForRepository(checkpoint.repository);
    const applied = await applyCheckpoint(git, checkpoint.afterHash, checkpoint.beforeHash);
    if (applied !== "applied") {
      this.lastGitFailure = applied;
      return "git_failed";
    }
    if (checkpoint.parentLeafId) {
      let result: NavigationResult;
      try {
        result = await this.navigateTo(checkpoint.parentLeafId);
      } catch {
        result = { cancelled: true };
      }
      if (result.cancelled) {
        const compensated = await applyCheckpoint(git, checkpoint.beforeHash, checkpoint.afterHash);
        if (compensated !== "applied") {
          this.lastGitFailure = "rollback_failed";
          return "rollback_failed";
        }
        return "cancelled";
      }
    }
    this.currentIndex--;
    return "moved";
  }

  async redo(): Promise<NavigationOutcome> {
    this.lastGitFailure = null;
    if (this.currentIndex >= this.checkpoints.length - 1) return "empty";
    const checkpoint = this.checkpoints[this.currentIndex + 1];
    const git = this.gitForRepository(checkpoint.repository);
    const applied = await applyCheckpoint(git, checkpoint.beforeHash, checkpoint.afterHash);
    if (applied !== "applied") {
      this.lastGitFailure = applied;
      return "git_failed";
    }
    if (checkpoint.leafId) {
      let result: NavigationResult;
      try {
        result = await this.navigateTo(checkpoint.leafId);
      } catch {
        result = { cancelled: true };
      }
      if (result.cancelled) {
        const compensated = await applyCheckpoint(git, checkpoint.afterHash, checkpoint.beforeHash);
        if (compensated !== "applied") {
          this.lastGitFailure = "rollback_failed";
          return "rollback_failed";
        }
        return "cancelled";
      }
    }
    this.currentIndex++;
    return "moved";
  }
}
