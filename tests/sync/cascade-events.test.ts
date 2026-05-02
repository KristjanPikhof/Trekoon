/**
 * Verifies that deleteEpic and deleteTask emit per-child delete events
 * (task.deleted and subtask.deleted) for each descendant — matching the
 * pattern used by deleteSubtask. Enables full event-log replay.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { MutationService } from "../../src/domain/mutation-service";
import { migrateDatabase } from "../../src/storage/migrations";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type EventRow = {
  id: string;
  entity_kind: string;
  entity_id: string;
  operation: string;
  payload: string;
  created_at: number;
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

function listDeleteEvents(db: Database): EventRow[] {
  return db
    .query(
      `SELECT id, entity_kind, entity_id, operation, payload, created_at
       FROM events
       WHERE operation IN ('epic.deleted', 'task.deleted', 'subtask.deleted')
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as EventRow[];
}

function listAllEvents(db: Database): EventRow[] {
  return db
    .query(
      `SELECT id, entity_kind, entity_id, operation, payload, created_at
       FROM events
       ORDER BY created_at ASC, id ASC`,
    )
    .all() as EventRow[];
}

function payloadFields(row: EventRow): Record<string, unknown> {
  const parsed = JSON.parse(row.payload) as { fields: Record<string, unknown> };
  return parsed.fields;
}

// ---------------------------------------------------------------------------
// deleteTask cascade
// ---------------------------------------------------------------------------

describe("deleteTask cascade events", (): void => {
  test("emits task.deleted and subtask.deleted for each child subtask", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "E1", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T1", description: "d" });
    const sub1 = service.createSubtask({ taskId: task.id, title: "S1", description: "d" });
    const sub2 = service.createSubtask({ taskId: task.id, title: "S2", description: "d" });

    // Clear creation events to isolate deletion events
    db.exec("DELETE FROM events WHERE operation IN ('epic.created','task.created','subtask.created');");

    service.deleteTask(task.id);

    const events = listDeleteEvents(db);

    // Exactly 1 task.deleted + 2 subtask.deleted, no epic.deleted
    const taskDeletedEvents = events.filter((e) => e.operation === "task.deleted");
    const subtaskDeletedEvents = events.filter((e) => e.operation === "subtask.deleted");
    const epicDeletedEvents = events.filter((e) => e.operation === "epic.deleted");

    expect(taskDeletedEvents.length).toBe(1);
    expect(subtaskDeletedEvents.length).toBe(2);
    expect(epicDeletedEvents.length).toBe(0);

    expect(taskDeletedEvents[0]!.entity_id).toBe(task.id);

    const subtaskIds = subtaskDeletedEvents.map((e) => e.entity_id).sort();
    expect(subtaskIds).toEqual([sub1.id, sub2.id].sort());

    // Subtask events carry source_event_id pointing to the task.deleted event
    const taskEventId = taskDeletedEvents[0]!.id;
    for (const subtaskEvent of subtaskDeletedEvents) {
      const fields = payloadFields(subtaskEvent);
      expect(fields.source_event_id).toBe(taskEventId);
      expect(fields.task_id).toBe(task.id);
    }

    db.close(false);
  });

  test("emits only task.deleted when the task has no subtasks", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "E1", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T1", description: "d" });

    db.exec("DELETE FROM events WHERE operation IN ('epic.created','task.created','subtask.created');");

    service.deleteTask(task.id);

    const events = listDeleteEvents(db);
    expect(events.length).toBe(1);
    expect(events[0]!.operation).toBe("task.deleted");
    expect(events[0]!.entity_id).toBe(task.id);

    db.close(false);
  });
});

// ---------------------------------------------------------------------------
// deleteEpic cascade
// ---------------------------------------------------------------------------

describe("deleteEpic cascade events", (): void => {
  test("emits task.deleted and subtask.deleted for all descendants", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "E1", description: "d" });
    const task1 = service.createTask({ epicId: epic.id, title: "T1", description: "d" });
    const task2 = service.createTask({ epicId: epic.id, title: "T2", description: "d" });
    const sub1a = service.createSubtask({ taskId: task1.id, title: "S1a", description: "d" });
    const sub1b = service.createSubtask({ taskId: task1.id, title: "S1b", description: "d" });
    const sub2a = service.createSubtask({ taskId: task2.id, title: "S2a", description: "d" });
    const sub2b = service.createSubtask({ taskId: task2.id, title: "S2b", description: "d" });

    db.exec("DELETE FROM events WHERE operation IN ('epic.created','task.created','subtask.created');");

    service.deleteEpic(epic.id);

    const events = listDeleteEvents(db);

    const epicDeletedEvents = events.filter((e) => e.operation === "epic.deleted");
    const taskDeletedEvents = events.filter((e) => e.operation === "task.deleted");
    const subtaskDeletedEvents = events.filter((e) => e.operation === "subtask.deleted");

    // 1 epic.deleted + 2 task.deleted + 4 subtask.deleted = 7 total
    expect(epicDeletedEvents.length).toBe(1);
    expect(taskDeletedEvents.length).toBe(2);
    expect(subtaskDeletedEvents.length).toBe(4);
    expect(events.length).toBe(7);

    expect(epicDeletedEvents[0]!.entity_id).toBe(epic.id);

    const deletedTaskIds = taskDeletedEvents.map((e) => e.entity_id).sort();
    expect(deletedTaskIds).toEqual([task1.id, task2.id].sort());

    const deletedSubtaskIds = subtaskDeletedEvents.map((e) => e.entity_id).sort();
    expect(deletedSubtaskIds).toEqual([sub1a.id, sub1b.id, sub2a.id, sub2b.id].sort());

    // Each subtask event must reference its parent task's delete event
    for (const subtaskEvent of subtaskDeletedEvents) {
      const fields = payloadFields(subtaskEvent);
      expect(typeof fields.source_event_id).toBe("string");
      expect(typeof fields.task_id).toBe("string");

      // The source_event_id should correspond to a task.deleted event
      const sourceEventId = fields.source_event_id as string;
      const taskDeletedEvent = taskDeletedEvents.find((e) => e.id === sourceEventId);
      expect(taskDeletedEvent).toBeDefined();

      // The task_id should match the task that owns this subtask
      const taskId = fields.task_id as string;
      const taskEvent = taskDeletedEvent!;
      expect(taskEvent.entity_id).toBe(taskId);
    }

    db.close(false);
  });

  test("emits only epic.deleted when the epic has no tasks", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "Empty", description: "d" });

    db.exec("DELETE FROM events WHERE operation IN ('epic.created','task.created','subtask.created');");

    service.deleteEpic(epic.id);

    const events = listDeleteEvents(db);
    expect(events.length).toBe(1);
    expect(events[0]!.operation).toBe("epic.deleted");
    expect(events[0]!.entity_id).toBe(epic.id);

    db.close(false);
  });

  test("emits only epic.deleted and task.deleted when tasks have no subtasks", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "E1", description: "d" });
    const task1 = service.createTask({ epicId: epic.id, title: "T1", description: "d" });
    const task2 = service.createTask({ epicId: epic.id, title: "T2", description: "d" });

    db.exec("DELETE FROM events WHERE operation IN ('epic.created','task.created','subtask.created');");

    service.deleteEpic(epic.id);

    const events = listDeleteEvents(db);
    expect(events.filter((e) => e.operation === "epic.deleted").length).toBe(1);
    expect(events.filter((e) => e.operation === "task.deleted").length).toBe(2);
    expect(events.filter((e) => e.operation === "subtask.deleted").length).toBe(0);

    const deletedTaskIds = events
      .filter((e) => e.operation === "task.deleted")
      .map((e) => e.entity_id)
      .sort();
    expect(deletedTaskIds).toEqual([task1.id, task2.id].sort());

    db.close(false);
  });
});

// ---------------------------------------------------------------------------
// All events emitted inside same transaction (atomicity)
// ---------------------------------------------------------------------------

describe("cascade event atomicity", (): void => {
  test("deleteEpic cascade events share the same transaction timestamp range", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "E1", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T1", description: "d" });
    service.createSubtask({ taskId: task.id, title: "S1", description: "d" });
    service.createSubtask({ taskId: task.id, title: "S2", description: "d" });

    const before = Date.now();
    service.deleteEpic(epic.id);
    const after = Date.now();

    const deleteEvents = listDeleteEvents(db);
    expect(deleteEvents.length).toBe(4); // epic + task + 2 subtasks

    for (const event of deleteEvents) {
      expect(event.created_at).toBeGreaterThanOrEqual(before);
      expect(event.created_at).toBeLessThanOrEqual(after);
    }

    db.close(false);
  });

  test("deleteTask cascade events share the same transaction timestamp range", (): void => {
    const { db, service } = createService();

    const epic = service.createEpic({ title: "E1", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T1", description: "d" });
    service.createSubtask({ taskId: task.id, title: "S1", description: "d" });
    service.createSubtask({ taskId: task.id, title: "S2", description: "d" });

    const before = Date.now();
    service.deleteTask(task.id);
    const after = Date.now();

    const deleteEvents = listDeleteEvents(db);
    expect(deleteEvents.length).toBe(3); // task + 2 subtasks

    for (const event of deleteEvents) {
      expect(event.created_at).toBeGreaterThanOrEqual(before);
      expect(event.created_at).toBeLessThanOrEqual(after);
    }

    db.close(false);
  });
});

// ---------------------------------------------------------------------------
// Replay verification: event log alone can reconstruct post-delete state
// ---------------------------------------------------------------------------

describe("event log replay after cascade delete", (): void => {
  test("deleteEpic: applying events to a fresh DB yields empty entity tables", (): void => {
    const { db: sourceDb, service } = createService();

    // Build a small epic graph
    const epic = service.createEpic({ title: "E1", description: "desc" });
    const task = service.createTask({ epicId: epic.id, title: "T1", description: "desc" });
    service.createSubtask({ taskId: task.id, title: "S1", description: "desc" });

    // Delete the epic — generates cascade events
    service.deleteEpic(epic.id);

    // Collect all events (create + delete) in order
    const allEvents = listAllEvents(sourceDb);

    // Replay into a fresh DB
    const replayDb = createDb();

    for (const event of allEvents) {
      const fields = payloadFields(event);

      if (event.operation === "epic.created") {
        replayDb
          .query(
            `INSERT INTO epics (id, title, description, status, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            event.entity_id,
            fields.title as string,
            fields.description as string,
            fields.status as string,
            event.created_at,
            event.created_at,
          );
      } else if (event.operation === "task.created") {
        replayDb
          .query(
            `INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            event.entity_id,
            fields.epic_id as string,
            fields.title as string,
            fields.description as string,
            fields.status as string,
            event.created_at,
            event.created_at,
          );
      } else if (event.operation === "subtask.created") {
        replayDb
          .query(
            `INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
          )
          .run(
            event.entity_id,
            fields.task_id as string,
            fields.title as string,
            fields.description as string,
            fields.status as string,
            event.created_at,
            event.created_at,
          );
      } else if (event.operation === "subtask.deleted") {
        replayDb.query("DELETE FROM subtasks WHERE id = ?;").run(event.entity_id);
      } else if (event.operation === "task.deleted") {
        replayDb.query("DELETE FROM tasks WHERE id = ?;").run(event.entity_id);
      } else if (event.operation === "epic.deleted") {
        replayDb.query("DELETE FROM epics WHERE id = ?;").run(event.entity_id);
      }
    }

    // After replay the DB should be empty
    const epicCount = (replayDb.query("SELECT COUNT(*) as c FROM epics;").get() as { c: number }).c;
    const taskCount = (replayDb.query("SELECT COUNT(*) as c FROM tasks;").get() as { c: number }).c;
    const subtaskCount = (replayDb.query("SELECT COUNT(*) as c FROM subtasks;").get() as { c: number }).c;

    expect(epicCount).toBe(0);
    expect(taskCount).toBe(0);
    expect(subtaskCount).toBe(0);

    sourceDb.close(false);
    replayDb.close(false);
  });
});
