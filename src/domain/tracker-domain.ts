import { randomUUID } from "node:crypto";

import { Database } from "bun:sqlite";

import {
  type DependencyRecord,
  DomainError,
  type EpicTreeDetailed,
  type EpicRecord,
  type EpicTree,
  type NodeKind,
  type ReverseDependencyNode,
  type SubtaskRecord,
  type TaskTreeDetailed,
  type TaskRecord,
} from "./types";

const DEFAULT_STATUS = "todo";

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
    const description: string = input.description === undefined ? "" : assertNonEmpty("description", input.description);
    const status: string = normalizeStatus(input.status);

    this.getTaskOrThrow(taskId);

    this.#db
      .query(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(id, taskId, title, description, status, now, now);

    return this.getSubtaskOrThrow(id);
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
      input.description !== undefined ? assertNonEmpty("description", input.description) : existing.description;
    const nextStatus: string = input.status !== undefined ? assertNonEmpty("status", input.status) : existing.status;
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
