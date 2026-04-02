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

interface SnapshotDeltaSelection {
  readonly epicIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly subtaskIds?: readonly string[];
  readonly dependencyIds?: readonly string[];
  readonly deletedSubtaskIds?: readonly string[];
  readonly deletedDependencyIds?: readonly string[];
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

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.length > 0))];
}

function buildDependencyIndexes(dependenciesBySourceId: Map<string, readonly DependencyRecord[]>, sourceIds: readonly string[]) {
  const dependencyIdsBySource = new Map<string, string[]>();
  const blockedByIdsBySource = new Map<string, string[]>();
  const dependentIdsByTarget = new Map<string, string[]>();
  const blocksByTarget = new Map<string, string[]>();
  const dependencies: BoardSnapshotDependency[] = [];

  for (const sourceId of sourceIds) {
    for (const dependency of dependenciesBySourceId.get(sourceId) ?? []) {
      dependencies.push(mapDependency(dependency));
      (dependencyIdsBySource.get(dependency.sourceId) ?? dependencyIdsBySource.set(dependency.sourceId, []).get(dependency.sourceId) ?? []).push(dependency.id);
      (blockedByIdsBySource.get(dependency.sourceId) ?? blockedByIdsBySource.set(dependency.sourceId, []).get(dependency.sourceId) ?? []).push(dependency.dependsOnId);
      (dependentIdsByTarget.get(dependency.dependsOnId) ?? dependentIdsByTarget.set(dependency.dependsOnId, []).get(dependency.dependsOnId) ?? []).push(dependency.id);
      (blocksByTarget.get(dependency.dependsOnId) ?? blocksByTarget.set(dependency.dependsOnId, []).get(dependency.dependsOnId) ?? []).push(dependency.sourceId);
    }
  }

  return { dependencies, dependencyIdsBySource, blockedByIdsBySource, dependentIdsByTarget, blocksByTarget };
}

function mapSnapshotSubtask(subtask: SubtaskRecord, indexes: ReturnType<typeof buildDependencyIndexes>): BoardSnapshotSubtask {
  return {
    id: subtask.id,
    kind: "subtask",
    taskId: subtask.taskId,
    title: subtask.title,
    description: subtask.description,
    status: subtask.status,
    owner: subtask.owner ?? null,
    createdAt: subtask.createdAt,
    updatedAt: subtask.updatedAt,
    blockedBy: indexes.blockedByIdsBySource.get(subtask.id) ?? [],
    blocks: indexes.blocksByTarget.get(subtask.id) ?? [],
    dependencyIds: indexes.dependencyIdsBySource.get(subtask.id) ?? [],
    dependentIds: indexes.dependentIdsByTarget.get(subtask.id) ?? [],
    searchText: [subtask.title, subtask.description, subtask.status].join(" ").toLowerCase(),
  };
}

function mapSnapshotTask(task: TaskRecord, taskSubtasks: readonly BoardSnapshotSubtask[], indexes: ReturnType<typeof buildDependencyIndexes>): BoardSnapshotTask {
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
    blockedBy: indexes.blockedByIdsBySource.get(task.id) ?? [],
    blocks: indexes.blocksByTarget.get(task.id) ?? [],
    dependencyIds: indexes.dependencyIdsBySource.get(task.id) ?? [],
    dependentIds: indexes.dependentIdsByTarget.get(task.id) ?? [],
    subtasks: taskSubtasks,
    searchText: [task.title, task.description, task.status, ...taskSubtasks.map((subtask) => `${subtask.title} ${subtask.description} ${subtask.status}`)].join(" ").toLowerCase(),
  };
}

function mapSnapshotEpic(epic: EpicRecord, epicTasks: readonly BoardSnapshotTask[]): BoardSnapshotEpic {
  return {
    id: epic.id,
    title: epic.title,
    description: epic.description,
    status: epic.status,
    createdAt: epic.createdAt,
    updatedAt: epic.updatedAt,
    taskIds: epicTasks.map((task) => task.id),
    counts: deriveFlatCounts(epicTasks),
    searchText: [epic.title, epic.description, ...epicTasks.map((task) => task.searchText)].join(" ").toLowerCase(),
  };
}

export function buildBoardSnapshotDelta(domain: TrackerDomain, selection: SnapshotDeltaSelection): Record<string, unknown> {
  const epicIds = uniqueIds(selection.epicIds ?? []);
  const requestedTaskIds = uniqueIds(selection.taskIds ?? []);
  const requestedSubtaskIds = uniqueIds(selection.subtaskIds ?? []);
  const requestedDependencyIds = new Set(selection.dependencyIds ?? []);
  const relatedTaskIds = uniqueIds([
    ...requestedTaskIds,
    ...requestedSubtaskIds.map((subtaskId) => domain.getSubtask(subtaskId)?.taskId ?? ""),
  ]);
  const tasks = relatedTaskIds.map((taskId) => domain.getTask(taskId)).filter((task): task is TaskRecord => task !== null);
  const subtasksByTaskId = new Map<string, readonly SubtaskRecord[]>();
  for (const task of tasks) {
    subtasksByTaskId.set(task.id, domain.listSubtasks(task.id));
  }
  const allSubtasks = uniqueIds([
    ...requestedSubtaskIds,
    ...[...subtasksByTaskId.values()].flatMap((taskSubtasks) => taskSubtasks.map((subtask) => subtask.id)),
  ]).map((subtaskId) => domain.getSubtask(subtaskId)).filter((subtask): subtask is SubtaskRecord => subtask !== null);
  const sourceIds = uniqueIds([...tasks.map((task) => task.id), ...allSubtasks.map((subtask) => subtask.id)]);
  const indexes = buildDependencyIndexes(domain.listDependenciesBySourceIds(sourceIds), sourceIds);
  const snapshotSubtasksByTaskId = new Map<string, BoardSnapshotSubtask[]>();
  for (const subtask of allSubtasks) {
    const mappedSubtask = mapSnapshotSubtask(subtask, indexes);
    const taskSubtasks = snapshotSubtasksByTaskId.get(subtask.taskId) ?? [];
    taskSubtasks.push(mappedSubtask);
    snapshotSubtasksByTaskId.set(subtask.taskId, taskSubtasks);
  }
  const snapshotTasks = tasks.map((task) => mapSnapshotTask(task, snapshotSubtasksByTaskId.get(task.id) ?? [], indexes));
  const snapshotEpics = epicIds.map((epicId) => domain.getEpic(epicId)).filter((epic): epic is EpicRecord => epic !== null).map((epic) => mapSnapshotEpic(epic, snapshotTasks.filter((task) => task.epicId === epic.id)));

  return {
    generatedAt: Date.now(),
    epics: snapshotEpics,
    tasks: snapshotTasks.filter((task) => requestedTaskIds.includes(task.id)),
    subtasks: allSubtasks.map((subtask) => mapSnapshotSubtask(subtask, indexes)).filter((subtask) => requestedSubtaskIds.includes(subtask.id)),
    dependencies: indexes.dependencies.filter((dependency) => requestedDependencyIds.has(dependency.id)),
    deletedSubtaskIds: [...(selection.deletedSubtaskIds ?? [])],
    deletedDependencyIds: [...(selection.deletedDependencyIds ?? [])],
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
  const indexes = buildDependencyIndexes(dependenciesBySourceId, sourceIds);

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

  const snapshotSubtasks: BoardSnapshotSubtask[] = subtasks.map((subtask) => mapSnapshotSubtask(subtask, indexes));
  const snapshotSubtasksByTaskId = new Map<string, BoardSnapshotSubtask[]>();
  for (const subtask of snapshotSubtasks) {
    const existing = snapshotSubtasksByTaskId.get(subtask.taskId) ?? [];
    existing.push(subtask);
    snapshotSubtasksByTaskId.set(subtask.taskId, existing);
  }

  const snapshotTasks: BoardSnapshotTask[] = tasks.map((task) => mapSnapshotTask(task, snapshotSubtasksByTaskId.get(task.id) ?? [], indexes));
  const taskSearchTextByEpicId = new Map<string, string[]>();
  for (const task of snapshotTasks) {
    const existing = taskSearchTextByEpicId.get(task.epicId) ?? [];
    existing.push(task.searchText);
    taskSearchTextByEpicId.set(task.epicId, existing);
  }

  const snapshotEpics: BoardSnapshotEpic[] = epics.map((epic) => mapSnapshotEpic(epic, snapshotTasks.filter((task) => task.epicId === epic.id)));

  return {
    generatedAt,
    epics: snapshotEpics,
    tasks: snapshotTasks,
    subtasks: snapshotSubtasks,
    dependencies: indexes.dependencies,
    counts: {
      epics: countStatuses(epics),
      tasks: countStatuses(tasks),
      subtasks: countStatuses(subtasks),
      dependencies: indexes.dependencies.length,
    },
  };
}
