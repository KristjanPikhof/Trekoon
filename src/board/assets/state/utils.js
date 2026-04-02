/** @type {readonly string[]} */
export const STATUS_ORDER = ["todo", "blocked", "in_progress", "done"];

/** @type {readonly string[]} */
export const VIEW_MODES = ["kanban", "list"];

const VALID_STATUSES = new Set(STATUS_ORDER);

/**
 * Normalize a raw status string into one of the canonical status values.
 * @param {string} rawStatus
 * @returns {"todo"|"blocked"|"in_progress"|"done"}
 */
export function normalizeStatus(rawStatus) {
  if (rawStatus === "in-progress") return "in_progress";
  if (VALID_STATUSES.has(rawStatus)) return rawStatus;
  return "todo";
}

/**
 * @param {unknown} value
 * @returns {any[]}
 */
function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {{ id?: string }} record
 * @returns {string}
 */
function getId(record) {
  return typeof record?.id === "string" && record.id.length > 0 ? record.id : crypto.randomUUID();
}

function normalizeTimestamp(value, fallback) {
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function normalizeText(value, fallback = "") {
  return String(value ?? fallback).replace(/\\n/g, "\n");
}

/**
 * @param {any[]} tasks
 * @returns {Record<string, number>}
 */
function deriveCounts(tasks) {
  return STATUS_ORDER.reduce((counts, status) => {
    counts[status] = tasks.filter((task) => task.status === status).length;
    return counts;
  }, {});
}

/**
 * Normalize a raw board snapshot into the canonical shape with search text,
 * dependency cross-references, and epic counts.
 * @param {object} rawSnapshot
 * @returns {object}
 */
export function normalizeSnapshot(rawSnapshot) {
  const rawEpics = normalizeArray(rawSnapshot?.epics);
  const rawTasks = normalizeArray(rawSnapshot?.tasks);
  const rawSubtasks = normalizeArray(rawSnapshot?.subtasks);
  const rawDependencies = normalizeArray(rawSnapshot?.dependencies);

  const taskIndex = new Map();
  const subtaskIndex = new Map();

  const tasks = rawTasks.map((task) => {
    const createdAt = normalizeTimestamp(task.createdAt, Date.now());
    const normalizedTask = {
      id: getId(task),
      kind: "task",
      epicId: task.epicId ?? task.epic?.id ?? null,
      title: normalizeText(task.title, "Untitled task"),
      description: normalizeText(task.description),
      status: normalizeStatus(task.status),
      createdAt,
      updatedAt: normalizeTimestamp(task.updatedAt, createdAt),
      blockedBy: [],
      blocks: [],
      dependencyIds: [],
      dependentIds: [],
      subtasks: [],
      searchText: "",
    };

    taskIndex.set(normalizedTask.id, normalizedTask);
    return normalizedTask;
  });

  const subtasks = rawSubtasks.map((subtask) => {
    const createdAt = normalizeTimestamp(subtask.createdAt, Date.now());
    const normalizedSubtask = {
      id: getId(subtask),
      kind: "subtask",
      taskId: subtask.taskId ?? subtask.task?.id ?? null,
      title: normalizeText(subtask.title, "Untitled subtask"),
      description: normalizeText(subtask.description),
      status: normalizeStatus(subtask.status),
      createdAt,
      updatedAt: normalizeTimestamp(subtask.updatedAt, createdAt),
      blockedBy: [],
      blocks: [],
      dependencyIds: [],
      dependentIds: [],
      searchText: "",
    };

    subtaskIndex.set(normalizedSubtask.id, normalizedSubtask);
    return normalizedSubtask;
  });

  for (const subtask of subtasks) {
    const parentTask = taskIndex.get(subtask.taskId);
    if (parentTask) {
      parentTask.subtasks.push(subtask);
    }
  }

  const dependencies = rawDependencies.map((dependency) => ({
    id: getId(dependency),
    sourceId: String(dependency.sourceId ?? ""),
    sourceKind: dependency.sourceKind === "subtask" ? "subtask" : "task",
    dependsOnId: String(dependency.dependsOnId ?? ""),
    dependsOnKind: dependency.dependsOnKind === "subtask" ? "subtask" : "task",
  }));

  const lookupNode = (kind, id) => {
    if (kind === "subtask") {
      return subtaskIndex.get(id) ?? null;
    }
    return taskIndex.get(id) ?? null;
  };

  for (const dependency of dependencies) {
    const source = lookupNode(dependency.sourceKind, dependency.sourceId);
    const target = lookupNode(dependency.dependsOnKind, dependency.dependsOnId);
    if (source) {
      source.blockedBy.push(dependency.dependsOnId);
      source.dependencyIds.push(dependency.id);
    }
    if (target) {
      target.blocks.push(dependency.sourceId);
      target.dependentIds.push(dependency.id);
    }
  }

  const epics = rawEpics.map((epic) => {
    const epicId = getId(epic);
    const epicTasks = tasks.filter((task) => task.epicId === epicId);
    const createdAt = normalizeTimestamp(epic.createdAt, Date.now());
    const normalizedEpic = {
      id: epicId,
      title: String(epic.title ?? "Untitled epic"),
      description: normalizeText(epic.description),
      status: normalizeStatus(String(epic.status ?? "todo")),
      createdAt,
      updatedAt: normalizeTimestamp(epic.updatedAt, createdAt),
      taskIds: epicTasks.map((task) => task.id),
      counts: deriveCounts(epicTasks),
      searchText: "",
    };

    normalizedEpic.searchText = [normalizedEpic.title, normalizedEpic.description, ...epicTasks.map((task) => task.title)].join(" ").toLowerCase();
    return normalizedEpic;
  });

  for (const subtask of subtasks) {
    subtask.searchText = [subtask.title, subtask.description, subtask.status].join(" ").toLowerCase();
  }

  for (const task of tasks) {
    task.searchText = [
      task.title,
      task.description,
      task.status,
      ...task.subtasks.map((subtask) => `${subtask.title} ${subtask.description} ${subtask.status}`),
    ].join(" ").toLowerCase();
  }

  const taskSearchTextByEpicId = new Map();
  for (const task of tasks) {
    if (!task.epicId) {
      continue;
    }

    const entries = taskSearchTextByEpicId.get(task.epicId) ?? [];
    entries.push(task.searchText);
    taskSearchTextByEpicId.set(task.epicId, entries);
  }

  return {
    generatedAt: rawSnapshot?.generatedAt ?? null,
    epics: epics.map((epic) => ({
      ...epic,
      searchText: [
        epic.title,
        epic.description,
        ...(taskSearchTextByEpicId.get(epic.id) ?? []),
      ].join(" ").toLowerCase(),
    })),
    tasks,
    subtasks,
    dependencies,
  };
}

function mergeRecordsById(existingRecords, incomingRecords, deletedIds = []) {
  const deletedIdSet = new Set(deletedIds);
  const nextRecords = existingRecords.filter((record) => !deletedIdSet.has(record.id));
  const indexById = new Map(nextRecords.map((record, index) => [record.id, index]));

  for (const record of incomingRecords) {
    const existingIndex = indexById.get(record.id);
    if (existingIndex === undefined) {
      indexById.set(record.id, nextRecords.length);
      nextRecords.push(record);
      continue;
    }

    nextRecords[existingIndex] = record;
  }

  return nextRecords;
}

export function applySnapshotDelta(snapshot, delta) {
  const baseSnapshot = snapshot && typeof snapshot === "object"
    ? snapshot
    : { generatedAt: null, epics: [], tasks: [], subtasks: [], dependencies: [] };

  if (!delta || typeof delta !== "object") {
    return baseSnapshot;
  }

  return {
    generatedAt: delta.generatedAt ?? baseSnapshot.generatedAt ?? null,
    epics: mergeRecordsById(baseSnapshot.epics ?? [], normalizeArray(delta.epics), normalizeArray(delta.deletedEpicIds)),
    tasks: mergeRecordsById(baseSnapshot.tasks ?? [], normalizeArray(delta.tasks), normalizeArray(delta.deletedTaskIds)),
    subtasks: mergeRecordsById(baseSnapshot.subtasks ?? [], normalizeArray(delta.subtasks), normalizeArray(delta.deletedSubtaskIds)),
    dependencies: mergeRecordsById(
      baseSnapshot.dependencies ?? [],
      normalizeArray(delta.dependencies),
      normalizeArray(delta.deletedDependencyIds),
    ),
  };
}

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Format a timestamp into a human-readable date string.
 * Uses a cached Intl.DateTimeFormat instance for performance.
 * @param {number|null|undefined} timestamp
 * @returns {string}
 */
export function formatDate(timestamp) {
  const normalized = Number(timestamp);
  if (!Number.isFinite(normalized) || normalized <= 0) return "Unknown";

  try {
    return dateFormatter.format(normalized);
  } catch {
    return "Unknown";
  }
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Valid status transitions mirroring the backend state machine (src/domain/types.ts).
 * @type {Map<string, Set<string>>}
 */
export const VALID_TRANSITIONS = new Map([
  ["todo", new Set(["in_progress", "blocked"])],
  ["in_progress", new Set(["done", "blocked"])],
  ["blocked", new Set(["in_progress", "todo"])],
  ["done", new Set(["in_progress"])],
]);

/**
 * Get the list of statuses a node can transition to from its current status.
 * @param {string} currentStatus
 * @returns {string[]}
 */
export function getValidTargets(currentStatus) {
  const targets = VALID_TRANSITIONS.get(currentStatus);
  return targets ? Array.from(targets) : [];
}

/**
 * Check whether transitioning from one status to another is valid.
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidTransition(from, to) {
  const targets = VALID_TRANSITIONS.get(from);
  return targets ? targets.has(to) : false;
}

/**
 * Return the current status plus all valid targets, useful for populating
 * status select dropdowns.
 * @param {string} currentStatus
 * @returns {string[]}
 */
export function getSelectableStatuses(currentStatus) {
  return [currentStatus, ...getValidTargets(currentStatus)];
}
