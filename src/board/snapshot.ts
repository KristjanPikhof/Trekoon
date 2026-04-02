import { TrackerDomain } from "../domain/tracker-domain";
import { type DependencyRecord, type EpicRecord, type SubtaskRecord, type TaskRecord } from "../domain/types";

type BoardStatus = "todo" | "blocked" | "in_progress" | "done";

interface StatusCounts {
  readonly total: number;
  readonly todo: number;
  readonly blocked: number;
  readonly inProgress: number;
  readonly done: number;
  readonly other: number;
}

interface FlatCounts extends Record<BoardStatus, number> {}

export interface BoardSnapshotDependency {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: "task" | "subtask";
  readonly dependsOnId: string;
  readonly dependsOnKind: "task" | "subtask";
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface BoardSnapshotSubtask {
  readonly id: string;
  readonly kind: "subtask";
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly owner: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly dependentIds: readonly string[];
  readonly searchText: string;
}

interface BoardSnapshotTask {
  readonly id: string;
  readonly kind: "task";
  readonly epicId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly owner: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly blockedBy: readonly string[];
  readonly blocks: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly dependentIds: readonly string[];
  readonly subtasks: readonly BoardSnapshotSubtask[];
  readonly searchText: string;
}

interface BoardSnapshotEpic {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly taskIds: readonly string[];
  readonly counts: FlatCounts;
  readonly searchText: string;
}

export interface BoardSnapshot {
  readonly generatedAt: number;
  readonly epics: readonly BoardSnapshotEpic[];
  readonly tasks: readonly BoardSnapshotTask[];
  readonly subtasks: readonly BoardSnapshotSubtask[];
  readonly dependencies: readonly BoardSnapshotDependency[];
  readonly counts: {
    readonly epics: StatusCounts;
    readonly tasks: StatusCounts;
    readonly subtasks: StatusCounts;
    readonly dependencies: number;
  };
}

function normalizeStatusBucket(status: string): keyof Omit<StatusCounts, "total"> {
  if (status === "todo") return "todo";
  if (status === "blocked") return "blocked";
  if (status === "in_progress" || status === "in-progress") return "inProgress";
  if (status === "done") return "done";
  return "other";
}

function countStatuses(records: readonly { readonly status: string }[]): StatusCounts {
  const counts = { total: records.length, todo: 0, blocked: 0, inProgress: 0, done: 0, other: 0 };
  for (const record of records) {
    counts[normalizeStatusBucket(record.status)] += 1;
  }
  return counts;
}

function deriveFlatCounts(records: readonly { readonly status: string }[]): FlatCounts {
  return records.reduce<FlatCounts>(
    (counts, record) => {
      if (record.status === "todo" || record.status === "blocked" || record.status === "in_progress" || record.status === "done") {
        counts[record.status] += 1;
      }
      return counts;
    },
    { todo: 0, blocked: 0, in_progress: 0, done: 0 },
  );
}

function mapDependency(record: DependencyRecord): BoardSnapshotDependency {
  return {
    id: record.id,
    sourceId: record.sourceId,
    sourceKind: record.sourceKind,
    dependsOnId: record.dependsOnId,
    dependsOnKind: record.dependsOnKind,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function buildBoardSnapshot(domain: TrackerDomain): BoardSnapshot {
  const generatedAt = Date.now();
  const epics = domain.listEpics();
  const tasks = domain.listTasks();
  const subtasks = domain.listSubtasks();
  const sourceIds = [...tasks.map((task) => task.id), ...subtasks.map((subtask) => subtask.id)];
  const dependenciesBySourceId = domain.listDependenciesBySourceIds(sourceIds);
  const subtasksByTaskId = new Map<string, SubtaskRecord[]>();
  const tasksByEpicId = new Map<string, TaskRecord[]>();
  const dependencyIdsBySource = new Map<string, string[]>();
  const blockedByIdsBySource = new Map<string, string[]>();
  const dependentIdsByTarget = new Map<string, string[]>();
  const blocksByTarget = new Map<string, string[]>();
  const dependencies: BoardSnapshotDependency[] = [];

  for (const task of tasks) {
    const existing = tasksByEpicId.get(task.epicId) ?? [];
    existing.push(task);
    tasksByEpicId.set(task.epicId, existing);
  }

  for (const subtask of subtasks) {
    const existing = subtasksByTaskId.get(subtask.taskId) ?? [];
    existing.push(subtask);
    subtasksByTaskId.set(subtask.taskId, existing);
  }

  for (const sourceId of sourceIds) {
    for (const dependency of dependenciesBySourceId.get(sourceId) ?? []) {
      dependencies.push(mapDependency(dependency));

      const sourceDependencyIds = dependencyIdsBySource.get(dependency.sourceId) ?? [];
      sourceDependencyIds.push(dependency.id);
      dependencyIdsBySource.set(dependency.sourceId, sourceDependencyIds);

      const sourceBlockedBy = blockedByIdsBySource.get(dependency.sourceId) ?? [];
      sourceBlockedBy.push(dependency.dependsOnId);
      blockedByIdsBySource.set(dependency.sourceId, sourceBlockedBy);

      const targetDependentIds = dependentIdsByTarget.get(dependency.dependsOnId) ?? [];
      targetDependentIds.push(dependency.id);
      dependentIdsByTarget.set(dependency.dependsOnId, targetDependentIds);

      const targetBlocks = blocksByTarget.get(dependency.dependsOnId) ?? [];
      targetBlocks.push(dependency.sourceId);
      blocksByTarget.set(dependency.dependsOnId, targetBlocks);
    }
  }

  const snapshotSubtasks: BoardSnapshotSubtask[] = subtasks.map((subtask) => ({
    id: subtask.id,
    kind: "subtask",
    taskId: subtask.taskId,
    title: subtask.title,
    description: subtask.description,
    status: subtask.status,
    owner: subtask.owner ?? null,
    createdAt: subtask.createdAt,
    updatedAt: subtask.updatedAt,
    blockedBy: blockedByIdsBySource.get(subtask.id) ?? [],
    blocks: blocksByTarget.get(subtask.id) ?? [],
    dependencyIds: dependencyIdsBySource.get(subtask.id) ?? [],
    dependentIds: dependentIdsByTarget.get(subtask.id) ?? [],
    searchText: [subtask.title, subtask.description, subtask.status].join(" ").toLowerCase(),
  }));
  const snapshotSubtasksByTaskId = new Map<string, BoardSnapshotSubtask[]>();
  for (const subtask of snapshotSubtasks) {
    const existing = snapshotSubtasksByTaskId.get(subtask.taskId) ?? [];
    existing.push(subtask);
    snapshotSubtasksByTaskId.set(subtask.taskId, existing);
  }

  const snapshotTasks: BoardSnapshotTask[] = tasks.map((task) => {
    const taskSubtasks = snapshotSubtasksByTaskId.get(task.id) ?? [];
    return {
      id: task.id,
      kind: "task",
      epicId: task.epicId,
      title: task.title,
      description: task.description,
      status: task.status,
      owner: task.owner ?? null,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      blockedBy: blockedByIdsBySource.get(task.id) ?? [],
      blocks: blocksByTarget.get(task.id) ?? [],
      dependencyIds: dependencyIdsBySource.get(task.id) ?? [],
      dependentIds: dependentIdsByTarget.get(task.id) ?? [],
      subtasks: taskSubtasks,
      searchText: [
        task.title,
        task.description,
        task.status,
        ...taskSubtasks.map((subtask) => `${subtask.title} ${subtask.description} ${subtask.status}`),
      ].join(" ").toLowerCase(),
    };
  });
  const taskSearchTextByEpicId = new Map<string, string[]>();
  for (const task of snapshotTasks) {
    const existing = taskSearchTextByEpicId.get(task.epicId) ?? [];
    existing.push(task.searchText);
    taskSearchTextByEpicId.set(task.epicId, existing);
  }

  const snapshotEpics: BoardSnapshotEpic[] = epics.map((epic) => {
    const epicTasks = tasksByEpicId.get(epic.id) ?? [];
    return {
      id: epic.id,
      title: epic.title,
      description: epic.description,
      status: epic.status,
      createdAt: epic.createdAt,
      updatedAt: epic.updatedAt,
      taskIds: epicTasks.map((task) => task.id),
      counts: deriveFlatCounts(epicTasks),
      searchText: [epic.title, epic.description, ...(taskSearchTextByEpicId.get(epic.id) ?? [])].join(" ").toLowerCase(),
    };
  });

  return {
    generatedAt,
    epics: snapshotEpics,
    tasks: snapshotTasks,
    subtasks: snapshotSubtasks,
    dependencies,
    counts: {
      epics: countStatuses(epics),
      tasks: countStatuses(tasks),
      subtasks: countStatuses(subtasks),
      dependencies: dependencies.length,
    },
  };
}
