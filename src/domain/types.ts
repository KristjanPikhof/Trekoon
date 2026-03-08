export type NodeKind = "epic" | "task" | "subtask";

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
