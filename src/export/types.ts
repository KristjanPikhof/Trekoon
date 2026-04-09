import type { DependencyRecord, EpicRecord, SubtaskRecord, TaskRecord } from "../domain/types";

export const EXPORT_SCHEMA_VERSION = 1;

export type ExportNodeKind = "task" | "subtask";

export interface ExportDependencyEdge {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: ExportNodeKind;
  readonly dependsOnId: string;
  readonly dependsOnKind: ExportNodeKind;
  readonly internal: boolean;
}

export interface ExportExternalNode {
  readonly id: string;
  readonly kind: ExportNodeKind;
  readonly title: string | null;
  readonly status: string | null;
  readonly epicId: string | null;
}

export interface ExportWarning {
  readonly code: string;
  readonly message: string;
  readonly entityId?: string;
}

export interface ExportStatusCounts {
  readonly total: number;
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
  readonly blocked: number;
  readonly other: number;
}

export interface ExportSummary {
  readonly taskCount: number;
  readonly subtaskCount: number;
  readonly dependencyCount: number;
  readonly externalNodeCount: number;
  readonly warningCount: number;
  readonly taskStatuses: ExportStatusCounts;
  readonly subtaskStatuses: ExportStatusCounts;
}

export interface ExportBundle {
  readonly schemaVersion: number;
  readonly exportedAt: number;
  readonly epic: EpicRecord;
  readonly tasks: readonly TaskRecord[];
  readonly subtasks: readonly SubtaskRecord[];
  readonly dependencies: readonly ExportDependencyEdge[];
  readonly externalNodes: readonly ExportExternalNode[];
  readonly blockedBy: ReadonlyMap<string, readonly string[]>;
  readonly blocks: ReadonlyMap<string, readonly string[]>;
  readonly warnings: readonly ExportWarning[];
  readonly summary: ExportSummary;
}
