import type {
  GitCheckpoint,
  GitRepository,
  GitRunner,
  GitRunnerFactory,
  NavigationPort,
  NavigationResult,
} from "./types.js";
import { applyCheckpoint, releaseCheckpoint } from "./checkpoints.js";

export type NavigationOutcome = "moved" | "empty" | "cancelled" | "git_failed" | "rollback_failed";

type GitFailure = "conflict" | "failed" | "rollback_failed";

export class SessionNavigation {
  private checkpoints: GitCheckpoint[] = [];
  private currentIndex = -1;
  private navigateTree: NavigationPort["navigateTree"] = async () => ({ cancelled: true });
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
    await Promise.all(
      discarded.map((entry) => releaseCheckpoint(this.gitForRepository(entry.repository), entry)),
    );
  }

  async dispose(): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    await Promise.all(
      checkpoints.map((entry) => releaseCheckpoint(this.gitForRepository(entry.repository), entry)),
    );
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
        result = await this.navigateTree(checkpoint.parentLeafId);
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
        result = await this.navigateTree(checkpoint.leafId);
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
