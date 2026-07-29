import type { GitCheckpoint, GitRunner, NavigationPort } from "./types.js";
import { releaseCheckpoint, restoreCheckpoint } from "./checkpoints.js";

export type NavigationOutcome = "moved" | "empty" | "cancelled" | "git_failed";

export class SessionNavigation {
  private checkpoints: GitCheckpoint[] = [];
  private currentIndex = -1;
  private navigateTree: NavigationPort["navigateTree"] = async () => ({ cancelled: true });

  constructor(
    private readonly port: Omit<NavigationPort, "navigateTree"> & {
      navigateTree?: NavigationPort["navigateTree"];
    },
    private readonly git: GitRunner,
  ) {
    if (port.navigateTree) this.navigateTree = port.navigateTree.bind(port);
  }

  setNavigateTree(navigateTree: NavigationPort["navigateTree"]): void {
    this.navigateTree = navigateTree;
  }

  async recordTurnEnd(checkpoint: GitCheckpoint): Promise<void> {
    const discarded = this.checkpoints.splice(
      this.currentIndex + 1,
      this.checkpoints.length - this.currentIndex - 1,
    );
    this.checkpoints.push(checkpoint);
    this.currentIndex = this.checkpoints.length - 1;
    await Promise.all(discarded.map((entry) => releaseCheckpoint(this.git, entry)));
  }

  async dispose(): Promise<void> {
    const checkpoints = this.checkpoints;
    this.checkpoints = [];
    this.currentIndex = -1;
    await Promise.all(checkpoints.map((entry) => releaseCheckpoint(this.git, entry)));
  }

  async undo(): Promise<NavigationOutcome> {
    if (this.currentIndex < 0) return "empty";
    const checkpoint = this.checkpoints[this.currentIndex];
    if (!(await restoreCheckpoint(this.git, checkpoint, checkpoint.beforeHash)))
      return "git_failed";
    if (checkpoint.parentLeafId) {
      const result = await this.navigateTree(checkpoint.parentLeafId);
      if (result.cancelled) return "cancelled";
    }
    this.currentIndex--;
    return "moved";
  }

  async redo(): Promise<NavigationOutcome> {
    if (this.currentIndex >= this.checkpoints.length - 1) return "empty";
    const checkpoint = this.checkpoints[this.currentIndex + 1];
    if (!(await restoreCheckpoint(this.git, checkpoint, checkpoint.afterHash))) return "git_failed";
    if (checkpoint.leafId) {
      const result = await this.navigateTree(checkpoint.leafId);
      if (result.cancelled) return "cancelled";
    }
    this.currentIndex++;
    return "moved";
  }
}
