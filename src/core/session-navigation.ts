import type { Checkpoint, GitRunner, NavigationPort } from "./types.js";
import { previousCheckpoint } from "./checkpoints.js";
import { capturePostTurnCheckpoint, restoreToCheckpoint } from "./checkpoints.js";

export type NavigationOutcome = "moved" | "empty" | "invalid" | "cancelled" | "git_failed";

export class SessionNavigation {
  private checkpoints: Checkpoint[] = [];
  private currentIndex: number = -1;
  private initialSet: boolean = false;

  constructor(
    private readonly port: NavigationPort,
    private readonly git: GitRunner,
  ) {}

  setInitialCheckpoint(commitHash: string): void {
    this.checkpoints = [{ commitHash, leafId: null }];
    this.currentIndex = 0;
    this.initialSet = true;
  }

  async recordTurnEnd(turnIndex: number): Promise<void> {
    const leafId = this.port.getLeafId();
    const hash = await capturePostTurnCheckpoint(this.git, turnIndex);
    if (!hash) return;

    if (this.currentIndex < this.checkpoints.length - 1) {
      this.checkpoints.splice(this.currentIndex + 1);
    }

    if (!this.initialSet && this.checkpoints.length === 0) {
      this.checkpoints.push({ commitHash: hash, leafId });
      this.currentIndex = 0;
      this.initialSet = true;
      return;
    }

    this.checkpoints.push({ commitHash: hash, leafId });
    this.currentIndex = this.checkpoints.length - 1;
  }

  async undo(): Promise<NavigationOutcome> {
    if (this.currentIndex < 1) return "empty";

    const target = this.checkpoints[this.currentIndex - 1];
    const ok = await restoreToCheckpoint(this.git, target.commitHash);
    if (!ok) return "git_failed";

    const userMessageId = previousCheckpoint(this.port);
    if (userMessageId) {
      const result = await this.port.navigateTree(userMessageId);
      if (result.cancelled) return "cancelled";
    }

    this.currentIndex--;
    return "moved";
  }

  async redo(): Promise<NavigationOutcome> {
    if (this.currentIndex >= this.checkpoints.length - 1) return "empty";

    const target = this.checkpoints[this.currentIndex + 1];
    const ok = await restoreToCheckpoint(this.git, target.commitHash);
    if (!ok) return "git_failed";

    if (target.leafId) {
      const result = await this.port.navigateTree(target.leafId);
      if (result.cancelled) return "cancelled";
    }

    this.currentIndex++;
    return "moved";
  }
}
