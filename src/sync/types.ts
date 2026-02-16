export type SyncResolution = "ours" | "theirs";

export interface GitContextSnapshot {
  readonly worktreePath: string;
  readonly branchName: string | null;
  readonly headSha: string | null;
}

export interface SyncStatusSummary {
  readonly sourceBranch: string;
  readonly ahead: number;
  readonly behind: number;
  readonly pendingConflicts: number;
  readonly git: GitContextSnapshot;
}

export interface PullSummary {
  readonly sourceBranch: string;
  readonly scannedEvents: number;
  readonly appliedEvents: number;
  readonly createdConflicts: number;
  readonly cursorToken: string | null;
}

export interface ResolveSummary {
  readonly conflictId: string;
  readonly resolution: SyncResolution;
  readonly entityKind: string;
  readonly entityId: string;
  readonly fieldName: string;
}
