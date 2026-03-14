export type NodeKind = "epic" | "task" | "subtask";

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
}

export interface TaskRecord {
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SubtaskRecord {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
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

export interface DomainErrorShape {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export class DomainError extends Error {
  readonly code: string;
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
