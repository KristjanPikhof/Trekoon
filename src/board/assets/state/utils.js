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
    const normalizedTask = {
      id: getId(task),
      kind: "task",
      epicId: task.epicId ?? task.epic?.id ?? null,
      title: String(task.title ?? "Untitled task"),
      description: String(task.description ?? "").replace(/\\n/g, "\n"),
      status: normalizeStatus(task.status),
      createdAt: Number(task.createdAt ?? Date.now()),
      updatedAt: Number(task.updatedAt ?? task.createdAt ?? Date.now()),
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
    const normalizedSubtask = {
      id: getId(subtask),
      kind: "subtask",
      taskId: subtask.taskId ?? subtask.task?.id ?? null,
      title: String(subtask.title ?? "Untitled subtask"),
      description: String(subtask.description ?? "").replace(/\\n/g, "\n"),
      status: normalizeStatus(subtask.status),
      createdAt: Number(subtask.createdAt ?? Date.now()),
      updatedAt: Number(subtask.updatedAt ?? subtask.createdAt ?? Date.now()),
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
    const normalizedEpic = {
      id: epicId,
      title: String(epic.title ?? "Untitled epic"),
      description: String(epic.description ?? "").replace(/\\n/g, "\n"),
      status: String(epic.status ?? "todo"),
      createdAt: Number(epic.createdAt ?? Date.now()),
      updatedAt: Number(epic.updatedAt ?? epic.createdAt ?? Date.now()),
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

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * Format a timestamp into a human-readable date string.
 * Uses a cached Intl.DateTimeFormat instance for performance.
 * @param {number|null|undefined} timestamp
 * @returns {string}
 */
export function formatDate(timestamp) {
  if (!timestamp) return "Unknown";
  return dateFormatter.format(timestamp);
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
