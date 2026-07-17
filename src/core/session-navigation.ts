import type { NavigationPort, SnapshotStore, WorkspaceSnapshot } from "./types.js";
import { previousCheckpoint } from "./checkpoints.js";

export type NavigationOutcome = "moved" | "empty" | "invalid" | "cancelled" | "snapshot_failed";

export class SessionNavigation {
  private checkpoints: Array<{ snapshot: WorkspaceSnapshot; leafId: string | null }> = [];
  private currentIndex = -1;
  private navigateTree: NavigationPort["navigateTree"] = async () => ({ cancelled: true });

  constructor(
    private readonly port: Omit<NavigationPort, "navigateTree"> & {
      navigateTree?: NavigationPort["navigateTree"];
    },
    private readonly snapshots: SnapshotStore,
  ) {
    if (port.navigateTree) this.navigateTree = port.navigateTree.bind(port);
  }

  setNavigateTree(navigateTree: NavigationPort["navigateTree"]): void {
    this.navigateTree = navigateTree;
  }

  setInitialCheckpoint(snapshot: WorkspaceSnapshot): void {
    this.checkpoints = [{ snapshot, leafId: null }];
    this.currentIndex = 0;
  }

  async recordTurnEnd(snapshot: WorkspaceSnapshot): Promise<void> {
    const leafId = this.port.getLeafId();
    if (this.currentIndex < this.checkpoints.length - 1) {
      this.checkpoints.splice(this.currentIndex + 1);
    }
    this.checkpoints.push({ snapshot, leafId });
    this.currentIndex = this.checkpoints.length - 1;
  }

  async undo(): Promise<NavigationOutcome> {
    if (this.currentIndex < 1) return "empty";
    const target = this.checkpoints[this.currentIndex - 1];
    if (!(await this.snapshots.restore(target.snapshot))) return "snapshot_failed";
    const userMessageId = previousCheckpoint(this.port);
    if (userMessageId) {
      const result = await this.navigateTree(userMessageId);
      if (result.cancelled) return "cancelled";
    }
    this.currentIndex--;
    return "moved";
  }

  async redo(): Promise<NavigationOutcome> {
    if (this.currentIndex >= this.checkpoints.length - 1) return "empty";
    const target = this.checkpoints[this.currentIndex + 1];
    if (!(await this.snapshots.restore(target.snapshot))) return "snapshot_failed";
    if (target.leafId) {
      const result = await this.navigateTree(target.leafId);
      if (result.cancelled) return "cancelled";
    }
    this.currentIndex++;
    return "moved";
  }
}
