export type SyncResolution = "ours" | "theirs";
export type SyncConflictMode = "pending" | "all";

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
  readonly sameBranch: boolean;
  readonly git: GitContextSnapshot;
}

export interface PullSummary {
  readonly sourceBranch: string;
  readonly scannedEvents: number;
  readonly appliedEvents: number;
  readonly createdConflicts: number;
  readonly cursorToken: string | null;
  readonly sameBranch: boolean;
  readonly diagnostics: SyncPullDiagnostics;
}

export interface SyncPullDiagnostics {
  readonly malformedPayloadEvents: number;
  readonly applyRejectedEvents: number;
  readonly quarantinedEvents: number;
  readonly conflictEvents: number;
  readonly staleCursor: boolean;
  readonly errorHints: readonly string[];
}

export interface ResolveSummary {
  readonly conflictId: string;
  readonly resolution: SyncResolution;
  readonly entityKind: string;
  readonly entityId: string;
  readonly fieldName: string;
}

export interface SyncConflictListItem {
  readonly id: string;
  readonly event_id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly field_name: string;
  readonly ours_value: string | null;
  readonly theirs_value: string | null;
  readonly resolution: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface SyncConflictDetail {
  readonly id: string;
  readonly eventId: string;
  readonly entityKind: string;
  readonly entityId: string;
  readonly fieldName: string;
  readonly oursValue: unknown;
  readonly theirsValue: unknown;
  readonly resolution: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly event: {
    readonly id: string;
    readonly operation: string;
    readonly payload: string;
    readonly git_branch: string | null;
    readonly git_head: string | null;
    readonly created_at: number;
  } | null;
}
