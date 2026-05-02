import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { MutationService } from "../../src/domain/mutation-service";
import { migrateDatabase } from "../../src/storage/migrations";

type EventRow = {
  entity_kind: string;
  entity_id: string;
  operation: string;
  payload: string;
};

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  return db;
}

function createService(): { db: Database; service: MutationService } {
  const db = createDb();
  const service = new MutationService(db, process.cwd());
  return { db, service };
}

function listEvents(db: Database, entityKind: string, entityId: string, operation: string): EventRow[] {
  return db
    .query(
      `
      SELECT entity_kind, entity_id, operation, payload
      FROM events
      WHERE entity_kind = ? AND entity_id = ? AND operation = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .all(entityKind, entityId, operation) as EventRow[];
}

function listEventsForEntity(db: Database, entityKind: string, entityId: string): EventRow[] {
  return db
    .query(
      `
      SELECT entity_kind, entity_id, operation, payload
      FROM events
      WHERE entity_kind = ? AND entity_id = ?
      ORDER BY created_at ASC, id ASC
      `,
    )
    .all(entityKind, entityId) as EventRow[];
}

function fields(row: EventRow): Record<string, unknown> {
  const parsed = JSON.parse(row.payload) as { fields: Record<string, unknown> };
  return parsed.fields;
}

describe("MutationService event payload shapes", (): void => {
  test("epic.created payload matches { title, description, status }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic A", description: "desc-A", status: "planned" });

    const rows = listEvents(db, "epic", epic.id, "epic.created");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      title: "Epic A",
      description: "desc-A",
      status: "planned",
    });
    db.close(false);
  });

  test("epic.updated payload matches { title, description, status }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic B", description: "desc-B" });
    const updated = service.updateEpic(epic.id, { title: "Epic B prime", description: "desc-B2" });

    const rows = listEvents(db, "epic", epic.id, "epic.updated");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      title: updated.title,
      description: updated.description,
      status: updated.status,
    });
    db.close(false);
  });

  test("epic.deleted payload is empty {}", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic C", description: "desc-C" });
    service.deleteEpic(epic.id);

    const rows = listEvents(db, "epic", epic.id, "epic.deleted");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({});
    db.close(false);
  });

  test("task.created payload matches { epic_id, title, description, status }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic D", description: "desc-D" });
    const task = service.createTask({ epicId: epic.id, title: "Task A", description: "desc-T-A" });

    const rows = listEvents(db, "task", task.id, "task.created");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      epic_id: task.epicId,
      title: "Task A",
      description: "desc-T-A",
      status: task.status,
    });
    db.close(false);
  });

  test("task.updated payload matches { epic_id, title, description, status, owner }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic E", description: "desc-E" });
    const task = service.createTask({ epicId: epic.id, title: "Task B", description: "desc-T-B" });
    const updated = service.updateTask(task.id, { title: "Task B prime", owner: "alice" });

    const rows = listEvents(db, "task", task.id, "task.updated");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      epic_id: updated.epicId,
      title: updated.title,
      description: updated.description,
      status: updated.status,
      owner: updated.owner,
    });
    db.close(false);
  });

  test("task.deleted (no cascading subtasks) payload is empty {}", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic F", description: "desc-F" });
    const task = service.createTask({ epicId: epic.id, title: "Task C", description: "desc-T-C" });
    service.deleteTask(task.id);

    const rows = listEvents(db, "task", task.id, "task.deleted");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({});
    db.close(false);
  });

  test("subtask.created payload matches { task_id, title, description, status }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic G", description: "desc-G" });
    const task = service.createTask({ epicId: epic.id, title: "Task D", description: "desc-T-D" });
    const subtask = service.createSubtask({ taskId: task.id, title: "Subtask A", description: "desc-S-A" });

    const rows = listEvents(db, "subtask", subtask.id, "subtask.created");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      task_id: subtask.taskId,
      title: "Subtask A",
      description: "desc-S-A",
      status: subtask.status,
    });
    db.close(false);
  });

  test("subtask.updated payload matches { task_id, title, description, status, owner }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic H", description: "desc-H" });
    const task = service.createTask({ epicId: epic.id, title: "Task E", description: "desc-T-E" });
    const subtask = service.createSubtask({ taskId: task.id, title: "Subtask B", description: "desc-S-B" });
    const updated = service.updateSubtask(subtask.id, { title: "Subtask B prime", owner: "bob" });

    const rows = listEvents(db, "subtask", subtask.id, "subtask.updated");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      task_id: updated.taskId,
      title: updated.title,
      description: updated.description,
      status: updated.status,
      owner: updated.owner,
    });
    db.close(false);
  });

  test("subtask.deleted (direct) payload is empty {}", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic I", description: "desc-I" });
    const task = service.createTask({ epicId: epic.id, title: "Task F", description: "desc-T-F" });
    const subtask = service.createSubtask({ taskId: task.id, title: "Subtask C", description: "" });
    service.deleteSubtask(subtask.id);

    const rows = listEvents(db, "subtask", subtask.id, "subtask.deleted");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({});
    db.close(false);
  });

  test("subtask.deleted (cascaded from task delete) payload includes { task_id, source_event_id }", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic J", description: "desc-J" });
    const task = service.createTask({ epicId: epic.id, title: "Task G", description: "desc-T-G" });
    const subtask = service.createSubtask({ taskId: task.id, title: "Subtask D", description: "" });
    service.deleteTask(task.id);

    const taskDeletedRows = listEvents(db, "task", task.id, "task.deleted");
    expect(taskDeletedRows.length).toBe(1);
    const taskDeleteEventId = (db
      .query(`SELECT id FROM events WHERE entity_kind = 'task' AND entity_id = ? AND operation = 'task.deleted'`)
      .get(task.id) as { id: string }).id;

    const rows = listEvents(db, "subtask", subtask.id, "subtask.deleted");
    expect(rows.length).toBe(1);
    expect(fields(rows[0]!)).toEqual({
      task_id: task.id,
      source_event_id: taskDeleteEventId,
    });
    db.close(false);
  });

  test("status cascade emits epic.updated and task.updated/subtask.updated with full update payload shapes", (): void => {
    const { db, service } = createService();
    const epic = service.createEpic({ title: "Epic K", description: "desc-K" });
    const task = service.createTask({ epicId: epic.id, title: "Task H", description: "desc-T-H" });
    const subtask = service.createSubtask({ taskId: task.id, title: "Subtask E", description: "" });

    // Drive subtask -> in_progress -> done; then task -> done -> requires subtask done; then epic cascade to done.
    service.updateSubtask(subtask.id, { status: "in_progress" });
    service.updateSubtask(subtask.id, { status: "done" });
    service.updateTask(task.id, { status: "in_progress" });
    service.updateTask(task.id, { status: "done" });
    service.updateEpicStatusCascade(epic.id, "done");

    const epicUpdatedRows = listEvents(db, "epic", epic.id, "epic.updated");
    expect(epicUpdatedRows.length).toBeGreaterThanOrEqual(1);
    const lastEpicUpdate = epicUpdatedRows[epicUpdatedRows.length - 1]!;
    const lastEpicFields = fields(lastEpicUpdate);
    expect(Object.keys(lastEpicFields).sort()).toEqual(["description", "status", "title"]);
    expect(lastEpicFields.status).toBe("done");

    const taskUpdatedRows = listEvents(db, "task", task.id, "task.updated");
    const lastTaskUpdate = taskUpdatedRows[taskUpdatedRows.length - 1]!;
    const lastTaskFields = fields(lastTaskUpdate);
    expect(Object.keys(lastTaskFields).sort()).toEqual(["description", "epic_id", "owner", "status", "title"]);

    const subtaskUpdatedRows = listEvents(db, "subtask", subtask.id, "subtask.updated");
    const lastSubtaskUpdate = subtaskUpdatedRows[subtaskUpdatedRows.length - 1]!;
    const lastSubtaskFields = fields(lastSubtaskUpdate);
    expect(Object.keys(lastSubtaskFields).sort()).toEqual(["description", "owner", "status", "task_id", "title"]);

    db.close(false);
  });

  test("createEpicGraph emits one create event per (epic, task, subtask)", (): void => {
    const { db, service } = createService();
    const result = service.createEpicGraph({
      title: "Graph Epic",
      description: "graph-desc",
      taskSpecs: [{ tempKey: "t1", title: "Graph Task", description: "gt-desc" }],
      subtaskSpecs: [
        { tempKey: "s1", title: "Graph Subtask", description: "gs-desc", parent: { kind: "temp_key", tempKey: "t1" } },
      ],
      dependencySpecs: [],
    });

    const epicRows = listEventsForEntity(db, "epic", result.epic.id);
    expect(epicRows.length).toBe(1);
    expect(epicRows[0]!.operation).toBe("epic.created");
    expect(fields(epicRows[0]!)).toEqual({
      title: "Graph Epic",
      description: "graph-desc",
      status: result.epic.status,
    });

    const task = result.tasks[0]!;
    const taskRows = listEventsForEntity(db, "task", task.id);
    expect(taskRows.length).toBe(1);
    expect(fields(taskRows[0]!)).toEqual({
      epic_id: task.epicId,
      title: task.title,
      description: task.description,
      status: task.status,
    });

    const subtask = result.subtasks[0]!;
    const subtaskRows = listEventsForEntity(db, "subtask", subtask.id);
    expect(subtaskRows.length).toBe(1);
    expect(fields(subtaskRows[0]!)).toEqual({
      task_id: subtask.taskId,
      title: subtask.title,
      description: subtask.description,
      status: subtask.status,
    });

    db.close(false);
  });
});
