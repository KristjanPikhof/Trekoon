export type NodeKind = "epic" | "task" | "subtask";

export const VALID_STATUSES = ["todo", "in_progress", "done", "blocked"] as const;
export type ValidStatus = (typeof VALID_STATUSES)[number];

export const VALID_TRANSITIONS: ReadonlyMap<ValidStatus, ReadonlySet<ValidStatus>> = new Map<ValidStatus, ReadonlySet<ValidStatus>>([
  ["todo", new Set<ValidStatus>(["in_progress", "blocked"])],
  ["in_progress", new Set<ValidStatus>(["done", "blocked"])],
  ["blocked", new Set<ValidStatus>(["in_progress", "todo"])],
  ["done", new Set<ValidStatus>(["in_progress"])],
]);

export const COMPACT_TEMP_KEY_PREFIX = "@";

export type CompactTempKey = string;

export interface CompactTempKeyRef {
  readonly kind: "temp_key";
  readonly tempKey: CompactTempKey;
}

export interface CompactEntityIdRef {
  readonly kind: "id";
  readonly id: string;
}

export type CompactEntityRef = CompactTempKeyRef | CompactEntityIdRef;

export interface CompactTaskSpec {
  readonly tempKey: CompactTempKey;
  readonly title: string;
  readonly description: string;
  readonly status?: string;
}

export interface CompactSubtaskSpec {
  readonly parent: CompactEntityRef;
  readonly tempKey: CompactTempKey;
  readonly title: string;
  readonly description: string;
  readonly status?: string;
}

export interface CompactDependencySpec {
  readonly source: CompactEntityRef;
  readonly dependsOn: CompactEntityRef;
}

export interface CompactTempKeyMapping<TKind extends Extract<NodeKind, "task" | "subtask"> = Extract<NodeKind, "task" | "subtask">> {
  readonly kind: TKind;
  readonly tempKey: CompactTempKey;
  readonly id: string;
}

export interface CompactBatchResultContract {
  readonly mappings: ReadonlyArray<CompactTempKeyMapping>;
}

export interface CompactTaskBatchCreateResult {
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly result: CompactBatchResultContract;
}

export interface CompactSubtaskBatchCreateResult {
  readonly subtasks: ReadonlyArray<SubtaskRecord>;
  readonly result: CompactBatchResultContract;
}

export interface CompactDependencyBatchAddResult {
  readonly dependencies: ReadonlyArray<DependencyRecord>;
  readonly result: CompactBatchResultContract;
}

export interface CompactBatchCounts {
  readonly tasks: number;
  readonly subtasks: number;
  readonly dependencies: number;
}

export interface CompactEpicExpandResult {
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly subtasks: ReadonlyArray<SubtaskRecord>;
  readonly dependencies: ReadonlyArray<DependencyRecord>;
  readonly result: CompactBatchResultContract & {
    readonly counts: CompactBatchCounts;
  };
}

export interface CompactEpicCreateResult extends CompactEpicExpandResult {
  readonly epic: EpicRecord;
}

export interface EpicRecord {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export interface TaskRecord {
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly owner: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export interface SubtaskRecord {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly owner: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly version: number;
}

export interface DependencyRecord {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: Extract<NodeKind, "task" | "subtask">;
  readonly dependsOnId: string;
  readonly dependsOnKind: Extract<NodeKind, "task" | "subtask">;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ReverseDependencyNode {
  readonly id: string;
  readonly kind: Extract<NodeKind, "task" | "subtask">;
  readonly distance: number;
  readonly isDirect: boolean;
}

export interface EpicTree {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly tasks: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly status: string;
    readonly subtasks: ReadonlyArray<{
      readonly id: string;
      readonly title: string;
      readonly status: string;
    }>;
  }>;
}

export interface TaskTreeDetailed {
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly subtasks: ReadonlyArray<{
    readonly id: string;
    readonly taskId: string;
    readonly title: string;
    readonly description: string;
    readonly status: string;
  }>;
}

export interface EpicTreeDetailed {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly tasks: ReadonlyArray<TaskTreeDetailed>;
}

export type SearchField = "title" | "description";

export interface SearchFieldMatch {
  readonly field: SearchField;
  readonly count: number;
  readonly snippet: string;
}

export interface SearchEntityMatch {
  readonly kind: NodeKind;
  readonly id: string;
  readonly fields: readonly SearchFieldMatch[];
}

export interface SearchSummary {
  readonly matchedEntities: number;
  readonly matchedFields: number;
  readonly totalMatches: number;
}

export interface SearchNode {
  readonly kind: NodeKind;
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export type StatusCascadeRootKind = Extract<NodeKind, "epic" | "task">;
export type DependencyNodeKind = Extract<NodeKind, "task" | "subtask">;

export interface StatusCascadeScopeNode {
  readonly kind: NodeKind;
  readonly id: string;
  readonly parentId?: string;
  readonly status: string;
}

export interface StatusCascadeChange {
  readonly kind: NodeKind;
  readonly id: string;
  readonly parentId?: string;
  readonly previousStatus: string;
  readonly nextStatus: string;
}

export interface StatusCascadeBlocker {
  readonly sourceId: string;
  readonly sourceKind: DependencyNodeKind;
  readonly dependsOnId: string;
  readonly dependsOnKind: DependencyNodeKind;
  readonly dependsOnStatus: string;
  readonly inScope: boolean;
  readonly willCascade: boolean;
}

export interface StatusCascadeCounts {
  readonly scope: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly blockers: number;
  readonly changedEpics: number;
  readonly changedTasks: number;
  readonly changedSubtasks: number;
}

export interface StatusCascadePlan {
  readonly rootKind: StatusCascadeRootKind;
  readonly rootId: string;
  readonly targetStatus: string;
  readonly atomic: true;
  readonly scope: ReadonlyArray<StatusCascadeScopeNode>;
  readonly orderedChanges: ReadonlyArray<StatusCascadeChange>;
  readonly changedIds: ReadonlyArray<string>;
  readonly unchangedIds: ReadonlyArray<string>;
  readonly blockers: ReadonlyArray<StatusCascadeBlocker>;
  readonly counts: StatusCascadeCounts;
}

export const ERROR_CODES = {
  ALREADY_DONE: "already_done",
  ALREADY_RESOLVED: "already_resolved",
  AMBIGUOUS_LEGACY_STATE: "ambiguous_legacy_state",
  BACKPRESSURE: "backpressure",
  BACKUP_ALREADY_EXISTS: "backup_already_exists",
  BACKUP_DATABASE_MISSING: "backup_database_missing",
  BACKUP_FAILED: "backup_failed",
  CANCELLED: "cancelled",
  CONFIRMATION_REQUIRED: "confirmation_required",
  CONFLICT_SET_CHANGED: "conflict_set_changed",
  DAEMON_START_FAILED: "daemon_start_failed",
  DATABASE_BUSY: "database_busy",
  DEPENDENCY_BLOCKED: "dependency_blocked",
  DISALLOWED_FIELD: "disallowed_field",
  EVENTS_FAILED: "events_failed",
  INSTALL_FAILED: "install_failed",
  INTERNAL_ERROR: "internal_error",
  INVALID_ARGS: "invalid_args",
  INVALID_DEPENDENCY: "invalid_dependency",
  INVALID_INPUT: "invalid_input",
  INVALID_PATH: "invalid_path",
  INVALID_SOURCE: "invalid_source",
  INVALID_STATE: "invalid_state",
  INVALID_SUBCOMMAND: "invalid_subcommand",
  LEGACY_IMPORT_FAILED: "legacy_import_failed",
  MIGRATE_FAILED: "migrate_failed",
  MIGRATION_DOWN_UNSUPPORTED: "migration_down_unsupported",
  MISSING_ASSET: "missing_asset",
  NO_MATCHING_CONFLICTS: "no_matching_conflicts",
  NOT_FOUND: "not_found",
  ORPHANED_EXTERNAL_NODE: "orphaned_external_node",
  OUTSIDE_REPO_TARGET: "outside_repo_target",
  PERMISSION_DENIED: "permission_denied",
  PRECONDITION_FAILED: "precondition_failed",
  ROW_NOT_FOUND: "row_not_found",
  STATUS_TRANSITION_INVALID: "status_transition_invalid",
  STREAM_UNAVAILABLE: "stream_unavailable",
  SYNC_FAILED: "sync_failed",
  TRACKED_IGNORED_MISMATCH: "tracked_ignored_mismatch",
  UNAUTHORIZED: "unauthorized",
  UNHANDLED_COMMAND: "unhandled_command",
  UNKNOWN_COMMAND: "unknown_command",
  UNKNOWN_OPTION: "unknown_option",
  UNSUPPORTED_ENTITY_KIND: "unsupported_entity_kind",
  UPDATE_FAILED: "update_failed",
  WRONG_ENTITY_TYPE: "wrong_entity_type",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface DomainErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(input: DomainErrorShape) {
    super(input.message);
    this.name = "DomainError";
    this.code = input.code;
    if (input.details !== undefined) {
      this.details = input.details;
    }
  }
}
