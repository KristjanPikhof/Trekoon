import { TrackerDomain } from "../domain/tracker-domain";
import { type DependencyRecord, type EpicRecord, type SubtaskRecord, type TaskRecord } from "../domain/types";

interface SearchFields {
  readonly title: string;
  readonly description: string;
  readonly text: string;
}

interface StatusCounts {
  readonly total: number;
  readonly todo: number;
  readonly inProgress: number;
  readonly done: number;
  readonly other: number;
}

export interface BoardSnapshotEpic {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly taskIds: readonly string[];
  readonly counts: {
    readonly tasks: StatusCounts;
    readonly subtasks: StatusCounts;
  };
  readonly search: SearchFields;
}

export interface BoardSnapshotTask {
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly subtaskIds: readonly string[];
  readonly dependencyIds: readonly string[];
  readonly dependentIds: readonly string[];
  readonly counts: {
    readonly subtasks: StatusCounts;
    readonly dependencies: number;
    readonly dependents: number;
  };
  readonly search: SearchFields;
}

export interface BoardSnapshotSubtask {
  readonly id: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly dependencyIds: readonly string[];
  readonly dependentIds: readonly string[];
  readonly counts: {
    readonly dependencies: number;
    readonly dependents: number;
  };
  readonly search: SearchFields;
}

export interface BoardSnapshotDependency {
  readonly id: string;
  readonly sourceId: string;
  readonly sourceKind: "task" | "subtask";
  readonly dependsOnId: string;
  readonly dependsOnKind: "task" | "subtask";
  readonly createdAt: number;
  readonly updatedAt: number;
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
  if (status === "todo") {
    return "todo";
  }

  if (status === "in_progress" || status === "in-progress") {
    return "inProgress";
  }

  if (status === "done") {
    return "done";
  }

  return "other";
}

function countStatuses(records: readonly { readonly status: string }[]): StatusCounts {
  const counts: {
    total: number;
    todo: number;
    inProgress: number;
    done: number;
    other: number;
  } = {
    total: records.length,
    todo: 0,
    inProgress: 0,
    done: 0,
    other: 0,
  };

  for (const record of records) {
    const bucket = normalizeStatusBucket(record.status);
    counts[bucket] += 1;
  }

  return counts;
}

function buildSearchFields(title: string, description: string): SearchFields {
  return {
    title,
    description,
    text: `${title}\n${description}`.trim(),
  };
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
  const generatedAt: number = Date.now();
  const epics: readonly EpicRecord[] = domain.listEpics();
  const tasks: readonly TaskRecord[] = domain.listTasks();
  const subtasks: readonly SubtaskRecord[] = domain.listSubtasks();
  const dependencies: BoardSnapshotDependency[] = [];

  const tasksByEpic = new Map<string, TaskRecord[]>();
  for (const task of tasks) {
    const existing = tasksByEpic.get(task.epicId) ?? [];
    existing.push(task);
    tasksByEpic.set(task.epicId, existing);
  }

  const subtasksByTask = new Map<string, SubtaskRecord[]>();
  for (const subtask of subtasks) {
    const existing = subtasksByTask.get(subtask.taskId) ?? [];
    existing.push(subtask);
    subtasksByTask.set(subtask.taskId, existing);
  }

  const dependencyIdsBySource = new Map<string, string[]>();
  const dependentIdsByTarget = new Map<string, string[]>();
  for (const task of tasks) {
    for (const dependency of domain.listDependencies(task.id)) {
      dependencies.push(mapDependency(dependency));
      const sourceIds = dependencyIdsBySource.get(dependency.sourceId) ?? [];
      sourceIds.push(dependency.id);
      dependencyIdsBySource.set(dependency.sourceId, sourceIds);
      const dependentIds = dependentIdsByTarget.get(dependency.dependsOnId) ?? [];
      dependentIds.push(dependency.id);
      dependentIdsByTarget.set(dependency.dependsOnId, dependentIds);
    }
  }

  for (const subtask of subtasks) {
    for (const dependency of domain.listDependencies(subtask.id)) {
      dependencies.push(mapDependency(dependency));
      const sourceIds = dependencyIdsBySource.get(dependency.sourceId) ?? [];
      sourceIds.push(dependency.id);
      dependencyIdsBySource.set(dependency.sourceId, sourceIds);
      const dependentIds = dependentIdsByTarget.get(dependency.dependsOnId) ?? [];
      dependentIds.push(dependency.id);
      dependentIdsByTarget.set(dependency.dependsOnId, dependentIds);
    }
  }

  return {
    generatedAt,
    epics: epics.map((epic) => {
      const epicTasks = tasksByEpic.get(epic.id) ?? [];
      const epicSubtasks = epicTasks.flatMap((task) => subtasksByTask.get(task.id) ?? []);
      return {
        id: epic.id,
        title: epic.title,
        description: epic.description,
        status: epic.status,
        createdAt: epic.createdAt,
        updatedAt: epic.updatedAt,
        taskIds: epicTasks.map((task) => task.id),
        counts: {
          tasks: countStatuses(epicTasks),
          subtasks: countStatuses(epicSubtasks),
        },
        search: buildSearchFields(epic.title, epic.description),
      };
    }),
    tasks: tasks.map((task) => {
      const taskSubtasks = subtasksByTask.get(task.id) ?? [];
      const dependencyIds = dependencyIdsBySource.get(task.id) ?? [];
      const dependentIds = dependentIdsByTarget.get(task.id) ?? [];
      return {
        id: task.id,
        epicId: task.epicId,
        title: task.title,
        description: task.description,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        subtaskIds: taskSubtasks.map((subtask) => subtask.id),
        dependencyIds,
        dependentIds,
        counts: {
          subtasks: countStatuses(taskSubtasks),
          dependencies: dependencyIds.length,
          dependents: dependentIds.length,
        },
        search: buildSearchFields(task.title, task.description),
      };
    }),
    subtasks: subtasks.map((subtask) => {
      const dependencyIds = dependencyIdsBySource.get(subtask.id) ?? [];
      const dependentIds = dependentIdsByTarget.get(subtask.id) ?? [];
      return {
        id: subtask.id,
        taskId: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
        createdAt: subtask.createdAt,
        updatedAt: subtask.updatedAt,
        dependencyIds,
        dependentIds,
        counts: {
          dependencies: dependencyIds.length,
          dependents: dependentIds.length,
        },
        search: buildSearchFields(subtask.title, subtask.description),
      };
    }),
    dependencies,
    counts: {
      epics: countStatuses(epics),
      tasks: countStatuses(tasks),
      subtasks: countStatuses(subtasks),
      dependencies: dependencies.length,
    },
  };
}
