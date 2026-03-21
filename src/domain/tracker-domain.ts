import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

import {
  type CompactEpicExpandResult,
  type CompactDependencyBatchAddResult,
  type CompactDependencySpec,
  type CompactEntityRef,
  type CompactSubtaskBatchCreateResult,
  type CompactSubtaskSpec,
  type CompactTaskBatchCreateResult,
  type CompactTaskSpec,
  type DependencyRecord,
  type DependencyNodeKind,
  DomainError,
  type EpicTreeDetailed,
  type EpicRecord,
  type EpicTree,
  type NodeKind,
  type ReverseDependencyNode,
  type SearchEntityMatch,
  type SearchField,
  type SearchFieldMatch,
  type SearchNode,
  type SearchSummary,
  type StatusCascadeBlocker,
  type StatusCascadeChange,
  type StatusCascadePlan,
  type StatusCascadeRootKind,
  type StatusCascadeScopeNode,
  type SubtaskRecord,
  type TaskTreeDetailed,
  type TaskRecord,
  VALID_STATUSES,
  VALID_TRANSITIONS,
  type ValidStatus,
} from "./types";

const DEFAULT_STATUS = "todo";
const DEPENDENCY_GATED_STATUSES = new Set<string>(["in_progress", "done"]);

interface EpicRow {
  id: string;
  title: string;
  description: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface TaskRow extends EpicRow {
  epic_id: string;
}

interface SubtaskRow extends EpicRow {
  task_id: string;
}

interface DependencyRow {
  id: string;
  source_id: string;
  source_kind: "task" | "subtask";
  depends_on_id: string;
  depends_on_kind: "task" | "subtask";
  created_at: number;
  updated_at: number;
}

interface ReverseDependencyRow {
  node_id: string;
  node_kind: "task" | "subtask";
  min_distance: number;
}

interface UnresolvedDependencyBlocker {
  readonly id: string;
  readonly kind: DependencyNodeKind;
  readonly status: string;
}

interface ValidatedTaskBatchSpec {
  readonly tempKey: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
}

interface ValidatedSubtaskBatchSpec {
  readonly tempKey: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
}

interface ResolvedDependencyBatchSpec {
  readonly index: number;
  readonly sourceId: string;
  readonly sourceKind: "task" | "subtask";
  readonly dependsOnId: string;
  readonly dependsOnKind: "task" | "subtask";
}

interface DependencyBatchValidationIssue {
  readonly index: number;
  readonly type: "missing_id" | "duplicate" | "cycle";
  readonly sourceId: string;
  readonly dependsOnId: string;
  readonly details: Record<string, unknown>;
}

interface DependencyBatchResolution {
  readonly spec?: ResolvedDependencyBatchSpec;
  readonly issues: readonly DependencyBatchValidationIssue[];
}

interface ResolvedCompactEntity {
  readonly id: string;
  readonly kind: "task" | "subtask";
}

function assertNonEmpty(field: string, value: string | undefined | null): string {
  const normalized: string = (value ?? "").trim();
  if (!normalized) {
    throw new DomainError({
      code: "invalid_input",
      message: `${field} must be a non-empty string`,
      details: { field },
    });
  }

  return normalized;
}

function normalizeStatus(value: string | undefined): string {
  if (value === undefined) {
    return DEFAULT_STATUS;
  }

  return assertNonEmpty("status", value);
}

function normalizeSubtaskDescription(value: string | undefined): string {
  if (value === undefined) {
    return "";
  }

  return value.trim();
}

function isValidStatus(status: string): status is ValidStatus {
  return (VALID_STATUSES as readonly string[]).includes(status);
}

export function validateStatusTransition(fromStatus: string, toStatus: string, entityKind: string, entityId: string): void {
  if (fromStatus === toStatus) {
    return;
  }

  if (!isValidStatus(toStatus)) {
    throw new DomainError({
      code: "status_transition_invalid",
      message: `invalid status '${toStatus}' for ${entityKind} ${entityId}; allowed statuses: ${VALID_STATUSES.join(", ")}`,
      details: { entity: entityKind, id: entityId, fromStatus, toStatus, allowedStatuses: [...VALID_STATUSES] },
    });
  }

  if (!isValidStatus(fromStatus)) {
    // Legacy status being migrated; allow transition to any valid status.
    return;
  }

  const allowed = VALID_TRANSITIONS.get(fromStatus);
  if (!allowed || !allowed.has(toStatus)) {
    throw new DomainError({
      code: "status_transition_invalid",
      message: `cannot transition ${entityKind} ${entityId} from '${fromStatus}' to '${toStatus}'`,
      details: {
        entity: entityKind,
        id: entityId,
        fromStatus,
        toStatus,
        allowedTransitions: allowed ? [...allowed] : [],
      },
    });
  }
}

function mapEpic(row: EpicRow): EpicRecord {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    epicId: row.epic_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSubtask(row: SubtaskRow): SubtaskRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    title: row.title,
    description: row.description,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDependency(row: DependencyRow): DependencyRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceKind: row.source_kind,
    dependsOnId: row.depends_on_id,
    dependsOnKind: row.depends_on_kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function countMatches(value: string, searchText: string): number {
  if (searchText.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset <= value.length - searchText.length) {
    const nextIndex = value.indexOf(searchText, offset);
    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    offset = nextIndex + searchText.length;
  }

  return count;
}

function buildMatchSnippet(value: string, searchText: string, contextSize = 24): string {
  if (searchText.length === 0) {
    return "";
  }

  const matchIndex = value.indexOf(searchText);
  if (matchIndex === -1) {
    return "";
  }

  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(value.length, matchIndex + searchText.length + contextSize);
  const rawSnippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${rawSnippet}${suffix}`;
}

function summarizeMatches(matches: readonly SearchEntityMatch[]): SearchSummary {
  return {
    matchedEntities: matches.length,
    matchedFields: matches.reduce((total, match) => total + match.fields.length, 0),
    totalMatches: matches.reduce(
      (total, match) => total + match.fields.reduce((fieldTotal, field) => fieldTotal + field.count, 0),
      0,
    ),
  };
}

export class TrackerDomain {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  createEpic(input: { title: string; description: string; status?: string | undefined }): EpicRecord {
    const now: number = Date.now();
    const id: string = randomUUID();
    const title: string = assertNonEmpty("title", input.title);
    const description: string = assertNonEmpty("description", input.description);
    const status: string = normalizeStatus(input.status);

    this.#db
      .query(
        "INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);",
      )
      .run(id, title, description, status, now, now);

    return this.getEpicOrThrow(id);
  }

  listEpics(): readonly EpicRecord[] {
    const rows = this.#db
      .query("SELECT id, title, description, status, created_at, updated_at FROM epics ORDER BY created_at ASC, id ASC;")
      .all() as EpicRow[];
    return rows.map(mapEpic);
  }

  getEpic(id: string): EpicRecord | null {
    const row = this.#db
      .query("SELECT id, title, description, status, created_at, updated_at FROM epics WHERE id = ?;")
      .get(id) as EpicRow | null;
    return row ? mapEpic(row) : null;
  }

  getEpicOrThrow(id: string): EpicRecord {
    const epic: EpicRecord | null = this.getEpic(id);
    if (!epic) {
      throw new DomainError({
        code: "not_found",
        message: `epic not found: ${id}`,
        details: { entity: "epic", id },
      });
    }

    return epic;
  }

  updateEpic(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): EpicRecord {
    const existing: EpicRecord = this.getEpicOrThrow(id);
    const nextTitle: string = input.title !== undefined ? assertNonEmpty("title", input.title) : existing.title;
    const nextDescription: string =
      input.description !== undefined ? assertNonEmpty("description", input.description) : existing.description;
    const nextStatus: string = input.status !== undefined ? assertNonEmpty("status", input.status) : existing.status;
    const now: number = Date.now();

    this.#db
      .query("UPDATE epics SET title = ?, description = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
      .run(nextTitle, nextDescription, nextStatus, now, id);

    return this.getEpicOrThrow(id);
  }

  deleteEpic(id: string): void {
    this.getEpicOrThrow(id);
    this.#db.query("DELETE FROM epics WHERE id = ?;").run(id);
  }

  createTask(input: { epicId: string; title: string; description: string; status?: string | undefined }): TaskRecord {
    const now: number = Date.now();
    const id: string = randomUUID();
    const epicId: string = assertNonEmpty("epicId", input.epicId);
    const title: string = assertNonEmpty("title", input.title);
    const description: string = assertNonEmpty("description", input.description);
    const status: string = normalizeStatus(input.status);

    this.getEpicOrThrow(epicId);

    this.#db
      .query(
        "INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(id, epicId, title, description, status, now, now);

    return this.getTaskOrThrow(id);
  }

  createTaskBatch(input: { epicId: string; specs: readonly CompactTaskSpec[] }): CompactTaskBatchCreateResult {
    const epicId: string = assertNonEmpty("epicId", input.epicId);
    this.getEpicOrThrow(epicId);

    const validatedSpecs: ValidatedTaskBatchSpec[] = input.specs.map((spec) => ({
      tempKey: assertNonEmpty("tempKey", spec.tempKey),
      title: assertNonEmpty("title", spec.title),
      description: assertNonEmpty("description", spec.description),
      status: normalizeStatus(spec.status),
    }));

    const tasks: TaskRecord[] = [];
    for (const spec of validatedSpecs) {
      const now: number = Date.now();
      const id: string = randomUUID();

      this.#db
        .query(
          "INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run(id, epicId, spec.title, spec.description, spec.status, now, now);

      tasks.push(this.getTaskOrThrow(id));
    }

    return {
      tasks,
      result: {
        mappings: tasks.map((task, index) => ({
          kind: "task",
          tempKey: validatedSpecs[index]?.tempKey ?? "",
          id: task.id,
        })),
      },
    };
  }

  listTasks(epicId?: string): readonly TaskRecord[] {
    if (epicId) {
      this.getEpicOrThrow(epicId);
      const rows = this.#db
        .query(
          "SELECT id, epic_id, title, description, status, created_at, updated_at FROM tasks WHERE epic_id = ? ORDER BY created_at ASC, id ASC;",
        )
        .all(epicId) as TaskRow[];
      return rows.map(mapTask);
    }

    const rows = this.#db
      .query("SELECT id, epic_id, title, description, status, created_at, updated_at FROM tasks ORDER BY created_at ASC, id ASC;")
      .all() as TaskRow[];
    return rows.map(mapTask);
  }

  getTask(id: string): TaskRecord | null {
    const row = this.#db
      .query("SELECT id, epic_id, title, description, status, created_at, updated_at FROM tasks WHERE id = ?;")
      .get(id) as TaskRow | null;
    return row ? mapTask(row) : null;
  }

  getTaskOrThrow(id: string): TaskRecord {
    const task: TaskRecord | null = this.getTask(id);
    if (!task) {
      throw new DomainError({
        code: "not_found",
        message: `task not found: ${id}`,
        details: { entity: "task", id },
      });
    }

    return task;
  }

  updateTask(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): TaskRecord {
    const existing: TaskRecord = this.getTaskOrThrow(id);
    const nextTitle: string = input.title !== undefined ? assertNonEmpty("title", input.title) : existing.title;
    const nextDescription: string =
      input.description !== undefined ? assertNonEmpty("description", input.description) : existing.description;
    const nextStatus: string = input.status !== undefined ? assertNonEmpty("status", input.status) : existing.status;
    this.assertNoUnresolvedDependenciesForStatusTransition(id, "task", existing.status, nextStatus);
    const now: number = Date.now();

    this.#db
      .query("UPDATE tasks SET title = ?, description = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
      .run(nextTitle, nextDescription, nextStatus, now, id);

    return this.getTaskOrThrow(id);
  }

  deleteTask(id: string): void {
    this.getTaskOrThrow(id);
    this.#db.query("DELETE FROM tasks WHERE id = ?;").run(id);
  }

  createSubtask(
    input: { taskId: string; title: string; description?: string | undefined; status?: string | undefined },
  ): SubtaskRecord {
    const now: number = Date.now();
    const id: string = randomUUID();
    const taskId: string = assertNonEmpty("taskId", input.taskId);
    const title: string = assertNonEmpty("title", input.title);
    const description: string = normalizeSubtaskDescription(input.description);
    const status: string = normalizeStatus(input.status);

    this.getTaskOrThrow(taskId);

    this.#db
      .query(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(id, taskId, title, description, status, now, now);

    return this.getSubtaskOrThrow(id);
  }

  createSubtaskBatch(input: { taskId: string; specs: readonly CompactSubtaskSpec[] }): CompactSubtaskBatchCreateResult {
    const defaultTaskId: string = assertNonEmpty("taskId", input.taskId);
    this.getTaskOrThrow(defaultTaskId);

    const validatedSpecs: ValidatedSubtaskBatchSpec[] = input.specs.map((spec) => {
      const taskId = spec.parent.kind === "id" ? assertNonEmpty("taskId", spec.parent.id) : defaultTaskId;
      this.getTaskOrThrow(taskId);

      return {
        tempKey: assertNonEmpty("tempKey", spec.tempKey),
        taskId,
        title: assertNonEmpty("title", spec.title),
        description: normalizeSubtaskDescription(spec.description),
        status: normalizeStatus(spec.status),
      };
    });

    const subtasks: SubtaskRecord[] = [];
    for (const spec of validatedSpecs) {
      const now: number = Date.now();
      const id: string = randomUUID();

      this.#db
        .query(
          "INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run(id, spec.taskId, spec.title, spec.description, spec.status, now, now);

      subtasks.push(this.getSubtaskOrThrow(id));
    }

    return {
      subtasks,
      result: {
        mappings: subtasks.map((subtask, index) => ({
          kind: "subtask",
          tempKey: validatedSpecs[index]?.tempKey ?? "",
          id: subtask.id,
        })),
      },
    };
  }

  expandEpic(input: {
    epicId: string;
    taskSpecs: readonly CompactTaskSpec[];
    subtaskSpecs: readonly CompactSubtaskSpec[];
    dependencySpecs: readonly CompactDependencySpec[];
  }): CompactEpicExpandResult {
    const createdTasks = this.createTaskBatch({
      epicId: input.epicId,
      specs: input.taskSpecs,
    });

    const resolvedSubtaskSpecs = this.#resolveEpicExpandSubtaskSpecs(input.subtaskSpecs, createdTasks.result.mappings);
    const createdSubtasks = resolvedSubtaskSpecs.length === 0
      ? { subtasks: [], result: { mappings: [] } }
      : this.createSubtaskBatch({
          taskId: resolvedSubtaskSpecs[0]?.parent.kind === "id" ? resolvedSubtaskSpecs[0].parent.id : "",
          specs: resolvedSubtaskSpecs,
        });

    const mappings = [...createdTasks.result.mappings, ...createdSubtasks.result.mappings];
    const resolvedDependencySpecs = this.#resolveEpicExpandDependencySpecs(input.dependencySpecs, mappings);
    const createdDependencies = resolvedDependencySpecs.length === 0
      ? { dependencies: [], result: { mappings: [] } }
      : this.addDependencyBatch({ specs: resolvedDependencySpecs });

    return {
      tasks: createdTasks.tasks,
      subtasks: createdSubtasks.subtasks,
      dependencies: createdDependencies.dependencies,
      result: {
        mappings,
        counts: {
          tasks: createdTasks.tasks.length,
          subtasks: createdSubtasks.subtasks.length,
          dependencies: createdDependencies.dependencies.length,
        },
      },
    };
  }

  listSubtasks(taskId?: string): readonly SubtaskRecord[] {
    if (taskId) {
      this.getTaskOrThrow(taskId);
      const rows = this.#db
        .query(
          "SELECT id, task_id, title, description, status, created_at, updated_at FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC;",
        )
        .all(taskId) as SubtaskRow[];
      return rows.map(mapSubtask);
    }

    const rows = this.#db
      .query(
        "SELECT id, task_id, title, description, status, created_at, updated_at FROM subtasks ORDER BY created_at ASC, id ASC;",
      )
      .all() as SubtaskRow[];
    return rows.map(mapSubtask);
  }

  getSubtask(id: string): SubtaskRecord | null {
    const row = this.#db
      .query("SELECT id, task_id, title, description, status, created_at, updated_at FROM subtasks WHERE id = ?;")
      .get(id) as SubtaskRow | null;
    return row ? mapSubtask(row) : null;
  }

  getSubtaskOrThrow(id: string): SubtaskRecord {
    const subtask: SubtaskRecord | null = this.getSubtask(id);
    if (!subtask) {
      throw new DomainError({
        code: "not_found",
        message: `subtask not found: ${id}`,
        details: { entity: "subtask", id },
      });
    }

    return subtask;
  }

  updateSubtask(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): SubtaskRecord {
    const existing: SubtaskRecord = this.getSubtaskOrThrow(id);
    const nextTitle: string = input.title !== undefined ? assertNonEmpty("title", input.title) : existing.title;
    const nextDescription: string =
      input.description !== undefined ? normalizeSubtaskDescription(input.description) : existing.description;
    const nextStatus: string = input.status !== undefined ? assertNonEmpty("status", input.status) : existing.status;
    this.assertNoUnresolvedDependenciesForStatusTransition(id, "subtask", existing.status, nextStatus);
    const now: number = Date.now();

    this.#db
      .query("UPDATE subtasks SET title = ?, description = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
      .run(nextTitle, nextDescription, nextStatus, now, id);

    return this.getSubtaskOrThrow(id);
  }

  deleteSubtask(id: string): void {
    this.getSubtaskOrThrow(id);
    this.#db.query("DELETE FROM subtasks WHERE id = ?;").run(id);
  }

  buildEpicTree(epicId: string): EpicTree {
    const epic: EpicRecord = this.getEpicOrThrow(epicId);
    const tasks: readonly TaskRecord[] = this.listTasks(epicId);
    const taskIds = new Set(tasks.map((task) => task.id));
    const subtasks = this.#db
      .query(
        "SELECT id, task_id, title, description, status, created_at, updated_at FROM subtasks WHERE task_id IN (SELECT id FROM tasks WHERE epic_id = ?) ORDER BY created_at ASC, id ASC;",
      )
      .all(epicId) as SubtaskRow[];

    const subtasksByTask = new Map<string, SubtaskRecord[]>();
    for (const row of subtasks) {
      if (!taskIds.has(row.task_id)) {
        continue;
      }
      const mapped: SubtaskRecord = mapSubtask(row);
      const existing = subtasksByTask.get(mapped.taskId) ?? [];
      existing.push(mapped);
      subtasksByTask.set(mapped.taskId, existing);
    }

    return {
      id: epic.id,
      title: epic.title,
      status: epic.status,
      tasks: tasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        subtasks: (subtasksByTask.get(task.id) ?? []).map((subtask) => ({
          id: subtask.id,
          title: subtask.title,
          status: subtask.status,
        })),
      })),
    };
  }

  buildTaskTreeDetailed(taskId: string): TaskTreeDetailed {
    const task: TaskRecord = this.getTaskOrThrow(taskId);
    const subtasks: readonly SubtaskRecord[] = this.listSubtasks(task.id);

    return {
      id: task.id,
      epicId: task.epicId,
      title: task.title,
      description: task.description,
      status: task.status,
      subtasks: subtasks.map((subtask) => ({
        id: subtask.id,
        taskId: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
      })),
    };
  }

  buildEpicTreeDetailed(epicId: string): EpicTreeDetailed {
    const epic: EpicRecord = this.getEpicOrThrow(epicId);
    const tasks: readonly TaskRecord[] = this.listTasks(epic.id);

    return {
      id: epic.id,
      title: epic.title,
      description: epic.description,
      status: epic.status,
      tasks: tasks.map((task) => this.buildTaskTreeDetailed(task.id)),
    };
  }

  planStatusCascade(rootKind: StatusCascadeRootKind, rootId: string, targetStatus: string): StatusCascadePlan {
    const normalizedTargetStatus = assertNonEmpty("status", targetStatus);
    const scope = this.#collectStatusCascadeScope(rootKind, rootId);
    const scopeIdSet = new Set(scope.map((node) => node.id));
    const orderedChanges = this.#orderStatusCascadeChanges(scope, normalizedTargetStatus);
    const changedIds = orderedChanges.map((change) => change.id);
    const changedIdSet = new Set(changedIds);
    const unchangedIds = scope
      .filter((node) => !changedIdSet.has(node.id))
      .map((node) => node.id);
    const blockers = this.#collectStatusCascadeBlockers(orderedChanges, scopeIdSet, changedIdSet, normalizedTargetStatus);

    return {
      rootKind,
      rootId,
      targetStatus: normalizedTargetStatus,
      atomic: true,
      scope,
      orderedChanges,
      changedIds,
      unchangedIds,
      blockers,
      counts: {
        scope: scope.length,
        changed: orderedChanges.length,
        unchanged: unchangedIds.length,
        blockers: blockers.length,
        changedEpics: orderedChanges.filter((change) => change.kind === "epic").length,
        changedTasks: orderedChanges.filter((change) => change.kind === "task").length,
        changedSubtasks: orderedChanges.filter((change) => change.kind === "subtask").length,
      },
    };
  }

  collectEpicSearchScope(epicId: string): readonly SearchNode[] {
    const tree = this.buildEpicTreeDetailed(epicId);

    return [
      {
        kind: "epic",
        id: tree.id,
        title: tree.title,
        description: tree.description,
      },
      ...tree.tasks.flatMap((task) => [
        {
          kind: "task" as const,
          id: task.id,
          title: task.title,
          description: task.description,
        },
        ...task.subtasks.map((subtask) => ({
          kind: "subtask" as const,
          id: subtask.id,
          title: subtask.title,
          description: subtask.description,
        })),
      ]),
    ];
  }

  collectTaskSearchScope(taskId: string): readonly SearchNode[] {
    const tree = this.buildTaskTreeDetailed(taskId);

    return [
      {
        kind: "task",
        id: tree.id,
        title: tree.title,
        description: tree.description,
      },
      ...tree.subtasks.map((subtask) => ({
        kind: "subtask" as const,
        id: subtask.id,
        title: subtask.title,
        description: subtask.description,
      })),
    ];
  }

  collectSubtaskSearchScope(subtaskId: string): readonly SearchNode[] {
    const subtask = this.getSubtaskOrThrow(subtaskId);

    return [
      {
        kind: "subtask",
        id: subtask.id,
        title: subtask.title,
        description: subtask.description,
      },
    ];
  }

  searchEpicScope(epicId: string, searchText: string, fields: readonly SearchField[]): { readonly matches: readonly SearchEntityMatch[]; readonly summary: SearchSummary } {
    const matches = this.collectSearchMatches(this.collectEpicSearchScope(epicId), searchText, fields);
    return {
      matches,
      summary: summarizeMatches(matches),
    };
  }

  searchTaskScope(taskId: string, searchText: string, fields: readonly SearchField[]): { readonly matches: readonly SearchEntityMatch[]; readonly summary: SearchSummary } {
    const matches = this.collectSearchMatches(this.collectTaskSearchScope(taskId), searchText, fields);
    return {
      matches,
      summary: summarizeMatches(matches),
    };
  }

  searchSubtaskScope(subtaskId: string, searchText: string, fields: readonly SearchField[]): { readonly matches: readonly SearchEntityMatch[]; readonly summary: SearchSummary } {
    const matches = this.collectSearchMatches(this.collectSubtaskSearchScope(subtaskId), searchText, fields);
    return {
      matches,
      summary: summarizeMatches(matches),
    };
  }

  resolveNodeKind(id: string): "task" | "subtask" {
    const task = this.getTask(id);
    if (task) {
      return "task";
    }

    const subtask = this.getSubtask(id);
    if (subtask) {
      return "subtask";
    }

    throw new DomainError({
      code: "not_found",
      message: `node not found: ${id}`,
      details: { id, expectedKinds: ["task", "subtask"] },
    });
  }

  addDependency(sourceId: string, dependsOnId: string): DependencyRecord {
    const normalizedSourceId: string = assertNonEmpty("sourceId", sourceId);
    const normalizedDependsOnId: string = assertNonEmpty("dependsOnId", dependsOnId);

    if (normalizedSourceId === normalizedDependsOnId) {
      throw new DomainError({
        code: "invalid_dependency",
        message: "dependency cycle detected",
        details: { sourceId: normalizedSourceId, dependsOnId: normalizedDependsOnId },
      });
    }

    const sourceKind = this.resolveNodeKind(normalizedSourceId);
    const dependsOnKind = this.resolveNodeKind(normalizedDependsOnId);

    const existing = this.#db
      .query(
        "SELECT id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at FROM dependencies WHERE source_id = ? AND depends_on_id = ?;",
      )
      .get(normalizedSourceId, normalizedDependsOnId) as DependencyRow | null;

    if (existing) {
      return mapDependency(existing);
    }

    if (this.wouldCreateCycle(normalizedSourceId, normalizedDependsOnId)) {
      throw new DomainError({
        code: "invalid_dependency",
        message: "dependency cycle detected",
        details: { sourceId: normalizedSourceId, dependsOnId: normalizedDependsOnId },
      });
    }

    const id: string = randomUUID();
    const now: number = Date.now();

    this.#db
      .query(
        "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(id, normalizedSourceId, sourceKind, normalizedDependsOnId, dependsOnKind, now, now);

    return this.getDependencyOrThrow(id);
  }

  addDependencyBatch(input: { specs: readonly CompactDependencySpec[] }): CompactDependencyBatchAddResult {
    const resolutions = input.specs.map((spec, index) => this.#resolveDependencyBatchSpec(index, spec));
    const resolvedSpecs = resolutions.flatMap((resolution) => (resolution.spec === undefined ? [] : [resolution.spec]));
    const issues = resolutions.flatMap((resolution) => resolution.issues).concat(this.#collectDependencyBatchIssues(resolvedSpecs));
    if (issues.length > 0) {
      const orderedIssues = issues.sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
      const firstIssue = orderedIssues[0] ?? null;
      throw new DomainError({
        code: "invalid_dependency",
        message:
          firstIssue?.type === "missing_id"
            ? "dependency batch contains missing ids"
            : firstIssue?.type === "duplicate"
              ? "dependency batch contains duplicate edges"
              : "dependency batch contains cycles",
        details: {
          issues: orderedIssues,
          firstIssue,
        },
      });
    }

    const dependencies: DependencyRecord[] = [];
    for (const spec of resolvedSpecs) {
      const existing = this.#getDependencyByEdge(spec.sourceId, spec.dependsOnId);
      if (existing) {
        dependencies.push(existing);
        continue;
      }

      const id: string = randomUUID();
      const now: number = Date.now();

      this.#db
        .query(
          "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run(id, spec.sourceId, spec.sourceKind, spec.dependsOnId, spec.dependsOnKind, now, now);

      dependencies.push(this.getDependencyOrThrow(id));
    }

    return {
      dependencies,
      result: { mappings: [] },
    };
  }

  removeDependency(sourceId: string, dependsOnId: string): number {
    const normalizedSourceId: string = assertNonEmpty("sourceId", sourceId);
    const normalizedDependsOnId: string = assertNonEmpty("dependsOnId", dependsOnId);
    const result = this.#db
      .query("DELETE FROM dependencies WHERE source_id = ? AND depends_on_id = ?;")
      .run(normalizedSourceId, normalizedDependsOnId);

    return result.changes;
  }

  listDependencies(sourceId: string): readonly DependencyRecord[] {
    const normalizedSourceId: string = assertNonEmpty("sourceId", sourceId);
    this.resolveNodeKind(normalizedSourceId);

    const rows = this.#db
      .query(
        "SELECT id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at FROM dependencies WHERE source_id = ? ORDER BY created_at ASC, id ASC;",
      )
      .all(normalizedSourceId) as DependencyRow[];

    return rows.map(mapDependency);
  }

  batchResolveDependencyStatuses(
    taskIds: readonly string[],
  ): Map<string, { totalDependencies: number; blockers: Array<{ id: string; kind: "task" | "subtask"; status: string }> }> {
    const result = new Map<string, { totalDependencies: number; blockers: Array<{ id: string; kind: "task" | "subtask"; status: string }> }>();

    if (taskIds.length === 0) {
      return result;
    }

    const placeholders = taskIds.map(() => "?").join(", ");
    const rows = this.#db
      .query(
        `SELECT d.source_id, d.depends_on_id, d.depends_on_kind, COALESCE(t.status, s.status) AS dep_status
         FROM dependencies d
         LEFT JOIN tasks t ON d.depends_on_kind = 'task' AND d.depends_on_id = t.id
         LEFT JOIN subtasks s ON d.depends_on_kind = 'subtask' AND d.depends_on_id = s.id
         WHERE d.source_id IN (${placeholders})
         ORDER BY d.source_id, d.created_at ASC, d.id ASC;`,
      )
      .all(...taskIds) as Array<{
        source_id: string;
        depends_on_id: string;
        depends_on_kind: "task" | "subtask";
        dep_status: string | null;
      }>;

    // Initialize all requested task IDs so tasks with zero deps are present.
    for (const taskId of taskIds) {
      result.set(taskId, { totalDependencies: 0, blockers: [] });
    }

    for (const row of rows) {
      const entry = result.get(row.source_id);
      if (!entry) {
        continue;
      }

      entry.totalDependencies += 1;

      // Skip orphaned dependency rows (target deleted).
      if (row.dep_status === null) {
        continue;
      }

      if (row.dep_status !== "done") {
        entry.blockers.push({
          id: row.depends_on_id,
          kind: row.depends_on_kind,
          status: row.dep_status,
        });
      }
    }

    return result;
  }

  listReverseDependencies(nodeId: string): readonly ReverseDependencyNode[] {
    const normalizedNodeId: string = assertNonEmpty("nodeId", nodeId);
    this.resolveNodeKind(normalizedNodeId);

    const rows = this.#db
      .query(
        `
        WITH RECURSIVE reverse_paths(node_id, node_kind, distance, visited) AS (
          SELECT d.source_id, d.source_kind, 1, ',' || d.source_id || ','
          FROM dependencies d
          WHERE d.depends_on_id = ?
          UNION ALL
          SELECT d.source_id, d.source_kind, rp.distance + 1, rp.visited || d.source_id || ','
          FROM dependencies d
          INNER JOIN reverse_paths rp ON d.depends_on_id = rp.node_id
          WHERE instr(rp.visited, ',' || d.source_id || ',') = 0
        )
        SELECT node_id, node_kind, MIN(distance) AS min_distance
        FROM reverse_paths
        GROUP BY node_id, node_kind
        ORDER BY min_distance ASC, node_kind ASC, node_id ASC;
        `,
      )
      .all(normalizedNodeId) as ReverseDependencyRow[];

    return rows.map((row) => ({
      id: row.node_id,
      kind: row.node_kind,
      distance: row.min_distance,
      isDirect: row.min_distance === 1,
    }));
  }

  private getDependencyOrThrow(id: string): DependencyRecord {
    const row = this.#db
      .query(
        "SELECT id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at FROM dependencies WHERE id = ?;",
      )
      .get(id) as DependencyRow | null;

    if (!row) {
      throw new DomainError({
        code: "not_found",
        message: `dependency not found: ${id}`,
        details: { entity: "dependency", id },
      });
    }

    return mapDependency(row);
  }

  #getDependencyByEdge(sourceId: string, dependsOnId: string): DependencyRecord | null {
    const row = this.#db
      .query(
        "SELECT id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at FROM dependencies WHERE source_id = ? AND depends_on_id = ?;",
      )
      .get(sourceId, dependsOnId) as DependencyRow | null;

    return row ? mapDependency(row) : null;
  }

  #resolveDependencyBatchSpec(index: number, spec: CompactDependencySpec): DependencyBatchResolution {
    const sourceResolution = this.#resolveDependencyBatchId(spec.source, "source", index);
    const dependsOnResolution = this.#resolveDependencyBatchId(spec.dependsOn, "dependsOn", index);
    const issues = [...sourceResolution.issues, ...dependsOnResolution.issues];
    const sourceId = sourceResolution.id;
    const dependsOnId = dependsOnResolution.id;

    if (sourceId === undefined || dependsOnId === undefined) {
      return {
        issues,
      };
    }

    if (sourceId === dependsOnId) {
      return {
        issues: [
          ...issues,
          {
            index,
            type: "cycle",
            sourceId,
            dependsOnId,
            details: { sourceId, dependsOnId, reason: "self_reference" },
          },
        ],
      };
    }

    return {
      spec: {
        index,
        sourceId,
        sourceKind: this.resolveNodeKind(sourceId),
        dependsOnId,
        dependsOnKind: this.resolveNodeKind(dependsOnId),
      },
      issues,
    };
  }

  #resolveDependencyBatchId(
    reference: CompactEntityRef,
    field: "source" | "dependsOn",
    index: number,
  ): { readonly id?: string; readonly issues: readonly DependencyBatchValidationIssue[] } {
    if (reference.kind === "temp_key") {
      return {
        issues: [
          {
            index,
            type: "missing_id",
            sourceId: field === "source" ? `@${reference.tempKey}` : "",
            dependsOnId: field === "dependsOn" ? `@${reference.tempKey}` : "",
            details: {
              field,
              tempKey: reference.tempKey,
              message: `Unresolved temp key @${reference.tempKey}`,
            },
          },
        ],
      };
    }

    const id = assertNonEmpty(field === "source" ? "sourceId" : "dependsOnId", reference.id);
    const task = this.getTask(id);
    const subtask = this.getSubtask(id);
    if (!task && !subtask) {
      return {
        issues: [
          {
            index,
            type: "missing_id",
            sourceId: field === "source" ? id : "",
            dependsOnId: field === "dependsOn" ? id : "",
            details: {
              field,
              id,
              message: `Node not found: ${id}`,
            },
          },
        ],
      };
    }

    return { id, issues: [] };
  }

  #resolveEpicExpandSubtaskSpecs(
    specs: readonly CompactSubtaskSpec[],
    mappings: readonly { tempKey: string; id: string; kind: "task" | "subtask" }[],
  ): CompactSubtaskSpec[] {
    return specs.map((spec, index) => {
      const parent = this.#resolveEpicExpandEntityRef(spec.parent, mappings, "subtask", index, "parent");
      if (parent.kind !== "task") {
        throw new DomainError({
          code: "invalid_input",
          message: `Subtask parent must resolve to a task in --subtask spec ${index + 1}`,
          details: {
            index,
            field: "parent",
            kind: parent.kind,
            id: parent.id,
          },
        });
      }

      return {
        ...spec,
        parent: {
          kind: "id",
          id: parent.id,
        },
      };
    });
  }

  #resolveEpicExpandDependencySpecs(
    specs: readonly CompactDependencySpec[],
    mappings: readonly { tempKey: string; id: string; kind: "task" | "subtask" }[],
  ): CompactDependencySpec[] {
    return specs.map((spec, index) => ({
      source: {
        kind: "id",
        id: this.#resolveEpicExpandEntityRef(spec.source, mappings, "dep", index, "source").id,
      },
      dependsOn: {
        kind: "id",
        id: this.#resolveEpicExpandEntityRef(spec.dependsOn, mappings, "dep", index, "dependsOn").id,
      },
    }));
  }

  #resolveEpicExpandEntityRef(
    reference: CompactEntityRef,
    mappings: readonly { tempKey: string; id: string; kind: "task" | "subtask" }[],
    option: "subtask" | "dep",
    index: number,
    field: "parent" | "source" | "dependsOn",
  ): ResolvedCompactEntity {
    if (reference.kind === "temp_key") {
      const mapping = mappings.find((candidate) => candidate.tempKey === reference.tempKey);
      if (mapping === undefined) {
        throw new DomainError({
          code: "invalid_input",
          message: `Unknown temp key @${reference.tempKey} in --${option} spec ${index + 1}`,
          details: {
            index,
            field,
            tempKey: reference.tempKey,
            option,
          },
        });
      }

      return {
        id: mapping.id,
        kind: mapping.kind,
      };
    }

    const id = assertNonEmpty(field === "parent" ? "taskId" : `${field}Id`, reference.id);
    return {
      id,
      kind: this.resolveNodeKind(id),
    };
  }

  #collectDependencyBatchIssues(specs: readonly ResolvedDependencyBatchSpec[]): DependencyBatchValidationIssue[] {
    const issues: DependencyBatchValidationIssue[] = [];
    const seenEdges = new Map<string, number>();
    const adjacency = this.#buildDependencyAdjacency();

    for (const spec of specs) {
      const edgeKey = `${spec.sourceId}->${spec.dependsOnId}`;
      const existingIndex = seenEdges.get(edgeKey);
      if (existingIndex !== undefined) {
        issues.push({
          index: spec.index,
          type: "duplicate",
          sourceId: spec.sourceId,
          dependsOnId: spec.dependsOnId,
          details: {
            sourceId: spec.sourceId,
            dependsOnId: spec.dependsOnId,
            firstIndex: existingIndex,
            duplicateIndex: spec.index,
            duplicateKind: "batch",
          },
        });
        continue;
      }

      if (this.#getDependencyByEdge(spec.sourceId, spec.dependsOnId) !== null) {
        issues.push({
          index: spec.index,
          type: "duplicate",
          sourceId: spec.sourceId,
          dependsOnId: spec.dependsOnId,
          details: {
            sourceId: spec.sourceId,
            dependsOnId: spec.dependsOnId,
            duplicateKind: "existing",
          },
        });
        continue;
      }

      if (this.#wouldCreateCycleInAdjacency(adjacency, spec.sourceId, spec.dependsOnId)) {
        issues.push({
          index: spec.index,
          type: "cycle",
          sourceId: spec.sourceId,
          dependsOnId: spec.dependsOnId,
          details: {
            sourceId: spec.sourceId,
            dependsOnId: spec.dependsOnId,
          },
        });
        continue;
      }

      const nextNeighbors = adjacency.get(spec.sourceId) ?? new Set<string>();
      nextNeighbors.add(spec.dependsOnId);
      adjacency.set(spec.sourceId, nextNeighbors);
      seenEdges.set(edgeKey, spec.index);
    }

    return issues.sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
  }

  #buildDependencyAdjacency(): Map<string, Set<string>> {
    const rows = this.#db.query("SELECT source_id, depends_on_id FROM dependencies ORDER BY source_id ASC, depends_on_id ASC;").all() as Array<{
      source_id: string;
      depends_on_id: string;
    }>;
    const adjacency = new Map<string, Set<string>>();

    for (const row of rows) {
      const neighbors = adjacency.get(row.source_id) ?? new Set<string>();
      neighbors.add(row.depends_on_id);
      adjacency.set(row.source_id, neighbors);
    }

    return adjacency;
  }

  #wouldCreateCycleInAdjacency(adjacency: ReadonlyMap<string, ReadonlySet<string>>, sourceId: string, dependsOnId: string): boolean {
    const visited = new Set<string>();
    const queue: string[] = [dependsOnId];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || visited.has(current)) {
        continue;
      }

      if (current === sourceId) {
        return true;
      }

      visited.add(current);
      const neighbors = adjacency.get(current);
      if (neighbors === undefined) {
        continue;
      }

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    return false;
  }

  private collectSearchMatches(
    nodes: readonly SearchNode[],
    searchText: string,
    fields: readonly SearchField[],
  ): readonly SearchEntityMatch[] {
    const matches: SearchEntityMatch[] = [];

    for (const node of nodes) {
      const matchedFields: SearchFieldMatch[] = [];
      for (const field of fields) {
        const count = countMatches(node[field], searchText);
        if (count > 0) {
          matchedFields.push({
            field,
            count,
            snippet: buildMatchSnippet(node[field], searchText),
          });
        }
      }

      if (matchedFields.length === 0) {
        continue;
      }

      matches.push({
        kind: node.kind,
        id: node.id,
        fields: matchedFields,
      });
    }

    return matches;
  }

  private wouldCreateCycle(sourceId: string, dependsOnId: string): boolean {
    const row = this.#db
      .query(
        `
        WITH RECURSIVE reachable(id) AS (
          SELECT ?
          UNION
          SELECT d.depends_on_id
          FROM dependencies d
          INNER JOIN reachable r ON d.source_id = r.id
        )
        SELECT 1 AS has_cycle
        FROM reachable
        WHERE id = ?
        LIMIT 1;
        `,
      )
      .get(dependsOnId, sourceId) as { has_cycle: number } | null;

    return row !== null;
  }

  #collectStatusCascadeScope(rootKind: StatusCascadeRootKind, rootId: string): StatusCascadeScopeNode[] {
    if (rootKind === "task") {
      const tree = this.buildTaskTreeDetailed(rootId);
      return [
        {
          kind: "task",
          id: tree.id,
          parentId: tree.epicId,
          status: tree.status,
        },
        ...tree.subtasks.map((subtask) => ({
          kind: "subtask" as const,
          id: subtask.id,
          parentId: subtask.taskId,
          status: subtask.status,
        })),
      ];
    }

    const tree = this.buildEpicTreeDetailed(rootId);
    return [
      {
        kind: "epic",
        id: tree.id,
        status: tree.status,
      },
      ...tree.tasks.flatMap((task) => [
        {
          kind: "task" as const,
          id: task.id,
          parentId: task.epicId,
          status: task.status,
        },
        ...task.subtasks.map((subtask) => ({
          kind: "subtask" as const,
          id: subtask.id,
          parentId: subtask.taskId,
          status: subtask.status,
        })),
      ]),
    ];
  }

  #orderStatusCascadeChanges(scope: readonly StatusCascadeScopeNode[], targetStatus: string): StatusCascadeChange[] {
    const changes = scope
      .filter((node) => node.status !== targetStatus)
      .map((node) => {
        const change: StatusCascadeChange = {
          kind: node.kind,
          id: node.id,
          previousStatus: node.status,
          nextStatus: targetStatus,
          ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
        };
        return change;
      });

    if (targetStatus !== "done") {
      return changes;
    }

    return this.#topologicallyOrderDoneCascadeChanges(changes);
  }

  #topologicallyOrderDoneCascadeChanges(changes: readonly StatusCascadeChange[]): StatusCascadeChange[] {
    const indexById = new Map<string, number>();
    const changeById = new Map<string, StatusCascadeChange>();
    const dependencyTargetsBySource = new Map<string, Set<string>>();
    const dependents = new Map<string, Set<string>>();
    const indegree = new Map<string, number>();

    changes.forEach((change, index) => {
      indexById.set(change.id, index);
      changeById.set(change.id, change);
      indegree.set(change.id, 0);

      if (change.kind !== "task" && change.kind !== "subtask") {
        return;
      }

      const dependencyTargets = new Set(this.listDependencies(change.id).map((dependency) => dependency.dependsOnId));
      dependencyTargetsBySource.set(change.id, dependencyTargets);
    });

    const addEdge = (fromId: string, toId: string): void => {
      if (fromId === toId || !changeById.has(fromId) || !changeById.has(toId)) {
        return;
      }

      const neighbors = dependents.get(fromId) ?? new Set<string>();
      if (neighbors.has(toId)) {
        return;
      }

      neighbors.add(toId);
      dependents.set(fromId, neighbors);
      indegree.set(toId, (indegree.get(toId) ?? 0) + 1);
    };

    for (const change of changes) {
      const dependencyTargets = dependencyTargetsBySource.get(change.id);

      if (change.kind === "subtask" && change.parentId !== undefined && !dependencyTargets?.has(change.parentId)) {
        addEdge(change.id, change.parentId);
      }

      if (change.kind === "task" && change.parentId !== undefined && !dependencyTargets?.has(change.parentId)) {
        addEdge(change.id, change.parentId);
      }

      if (change.kind !== "task" && change.kind !== "subtask") {
        continue;
      }

      for (const dependencyTargetId of dependencyTargets ?? []) {
        addEdge(dependencyTargetId, change.id);
      }
    }

    const ordered: StatusCascadeChange[] = [];
    const ready = changes
      .filter((change) => (indegree.get(change.id) ?? 0) === 0)
      .sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0));

    while (ready.length > 0) {
      const next = ready.shift();
      if (next === undefined) {
        continue;
      }

      ordered.push(next);
      for (const dependentId of dependents.get(next.id) ?? []) {
        const remaining = (indegree.get(dependentId) ?? 0) - 1;
        indegree.set(dependentId, remaining);
        if (remaining !== 0) {
          continue;
        }

        const dependent = changeById.get(dependentId);
        if (dependent === undefined) {
          continue;
        }

        ready.push(dependent);
        ready.sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0));
      }
    }

    if (ordered.length !== changes.length) {
      throw new DomainError({
        code: "invalid_dependency",
        message: "unable to determine dependency-safe cascade order",
        details: {
          changedIds: changes.map((change) => change.id),
        },
      });
    }

    return ordered;
  }

  #collectStatusCascadeBlockers(
    changes: readonly StatusCascadeChange[],
    scopeIdSet: ReadonlySet<string>,
    changedIdSet: ReadonlySet<string>,
    targetStatus: string,
  ): StatusCascadeBlocker[] {
    if (!DEPENDENCY_GATED_STATUSES.has(targetStatus)) {
      return [];
    }

    const blockers: StatusCascadeBlocker[] = [];
    for (const change of changes) {
      if (change.kind !== "task" && change.kind !== "subtask") {
        continue;
      }

      for (const dependency of this.listDependencies(change.id)) {
        const dependencyNode =
          dependency.dependsOnKind === "task"
            ? this.getTask(dependency.dependsOnId)
            : this.getSubtask(dependency.dependsOnId);

        // Skip orphaned dependency rows where the referenced node no longer exists.
        if (!dependencyNode) {
          continue;
        }

        const dependencyStatus = dependencyNode.status;
        const inScope = scopeIdSet.has(dependency.dependsOnId);
        const willCascade = targetStatus === "done" && changedIdSet.has(dependency.dependsOnId);
        if (dependencyStatus === "done" || willCascade) {
          continue;
        }

        blockers.push({
          sourceId: dependency.sourceId,
          sourceKind: dependency.sourceKind,
          dependsOnId: dependency.dependsOnId,
          dependsOnKind: dependency.dependsOnKind,
          dependsOnStatus: dependencyStatus,
          inScope,
          willCascade,
        });
      }
    }

    return blockers.sort(
      (left, right) =>
        left.sourceId.localeCompare(right.sourceId) ||
        left.dependsOnId.localeCompare(right.dependsOnId) ||
        left.dependsOnKind.localeCompare(right.dependsOnKind),
    );
  }

  private assertNoUnresolvedDependenciesForStatusTransition(
    id: string,
    kind: DependencyNodeKind,
    existingStatus: string,
    nextStatus: string,
  ): void {
    if (existingStatus === nextStatus) {
      return;
    }

    if (!DEPENDENCY_GATED_STATUSES.has(nextStatus)) {
      return;
    }

    const unresolvedDependencies = this.listUnresolvedDependencyBlockers(id);
    if (unresolvedDependencies.length === 0) {
      return;
    }

    throw new DomainError({
      code: "dependency_blocked",
      message: `${kind} cannot transition to ${nextStatus} while dependencies are unresolved`,
      details: {
        entity: kind,
        id,
        status: nextStatus,
        unresolvedDependencyCount: unresolvedDependencies.length,
        unresolvedDependencyIds: unresolvedDependencies.map((dependency) => dependency.id),
        unresolvedDependencies,
      },
    });
  }

  private listUnresolvedDependencyBlockers(sourceId: string): readonly UnresolvedDependencyBlocker[] {
    const dependencies = this.listDependencies(sourceId);
    const unresolved: UnresolvedDependencyBlocker[] = [];

    for (const dependency of dependencies) {
      const dependencyNode =
        dependency.dependsOnKind === "task"
          ? this.getTask(dependency.dependsOnId)
          : this.getSubtask(dependency.dependsOnId);

      // Skip orphaned dependency rows where the referenced node no longer exists.
      if (!dependencyNode) {
        continue;
      }

      if (dependencyNode.status === "done") {
        continue;
      }

      unresolved.push({
        id: dependency.dependsOnId,
        kind: dependency.dependsOnKind,
        status: dependencyNode.status,
      });
    }

    return unresolved;
  }
}

export function parseNodeKind(kind: string): NodeKind {
  if (kind === "epic" || kind === "task" || kind === "subtask") {
    return kind;
  }

  throw new DomainError({
    code: "invalid_input",
    message: `unsupported node kind: ${kind}`,
    details: { kind },
  });
}
