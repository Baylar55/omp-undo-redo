import type { GitCheckpoint, GitRunner, NavigationPort } from "./types.js";
import { restoreCheckpoint } from "./checkpoints.js";

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

  recordTurnEnd(checkpoint: GitCheckpoint): void {
    if (this.currentIndex < this.checkpoints.length - 1) {
      this.checkpoints.splice(this.currentIndex + 1);
    }
    this.checkpoints.push(checkpoint);
    this.currentIndex = this.checkpoints.length - 1;
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
