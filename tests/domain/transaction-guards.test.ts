import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { TrackerDomain } from "../../src/domain/tracker-domain";
import { DomainError } from "../../src/domain/types";
import { migrateDatabase } from "../../src/storage/migrations";
import { writeTransaction } from "../../src/storage/database";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  return db;
}

function assertTransactionGuard(fn: () => unknown): void {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe("invalid_state");
    expect(domainErr.message).toMatch(/must be called inside a writeTransaction/);
  }
  if (!threw) {
    throw new Error("Expected a DomainError to be thrown, but no error was thrown");
  }
}

describe("TrackerDomain transaction guards", (): void => {
  test("updateEpic throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    // Create an epic inside a transaction first
    let epicId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic A", description: "desc" });
      epicId = epic.id;
    });

    assertTransactionGuard(() => domain.updateEpic(epicId, { title: "Updated" }));
    db.close(false);
  });

  test("deleteEpic throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let epicId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic B", description: "desc" });
      epicId = epic.id;
    });

    assertTransactionGuard(() => domain.deleteEpic(epicId));
    db.close(false);
  });

  test("updateTask throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic C", description: "desc" });
      const task = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      taskId = task.id;
    });

    assertTransactionGuard(() => domain.updateTask(taskId, { title: "Updated" }));
    db.close(false);
  });

  test("deleteTask throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic D", description: "desc" });
      const task = domain.createTask({ epicId: epic.id, title: "Task B", description: "desc" });
      taskId = task.id;
    });

    assertTransactionGuard(() => domain.deleteTask(taskId));
    db.close(false);
  });

  test("updateSubtask throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let subtaskId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic E", description: "desc" });
      const task = domain.createTask({ epicId: epic.id, title: "Task C", description: "desc" });
      const subtask = domain.createSubtask({ taskId: task.id, title: "Subtask A" });
      subtaskId = subtask.id;
    });

    assertTransactionGuard(() => domain.updateSubtask(subtaskId, { title: "Updated" }));
    db.close(false);
  });

  test("deleteSubtask throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let subtaskId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic F", description: "desc" });
      const task = domain.createTask({ epicId: epic.id, title: "Task D", description: "desc" });
      const subtask = domain.createSubtask({ taskId: task.id, title: "Subtask B" });
      subtaskId = subtask.id;
    });

    assertTransactionGuard(() => domain.deleteSubtask(subtaskId));
    db.close(false);
  });

  test("addDependency throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId1!: string;
    let taskId2!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic G", description: "desc" });
      const task1 = domain.createTask({ epicId: epic.id, title: "Task E", description: "desc" });
      const task2 = domain.createTask({ epicId: epic.id, title: "Task F", description: "desc" });
      taskId1 = task1.id;
      taskId2 = task2.id;
    });

    assertTransactionGuard(() => domain.addDependency(taskId1, taskId2));
    db.close(false);
  });

  test("addDependencyBatch throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId1!: string;
    let taskId2!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic H", description: "desc" });
      const task1 = domain.createTask({ epicId: epic.id, title: "Task G", description: "desc" });
      const task2 = domain.createTask({ epicId: epic.id, title: "Task H", description: "desc" });
      taskId1 = task1.id;
      taskId2 = task2.id;
    });

    assertTransactionGuard(() =>
      domain.addDependencyBatch({
        specs: [
          { source: { kind: "id", id: taskId1 }, dependsOn: { kind: "id", id: taskId2 } },
        ],
      }),
    );
    db.close(false);
  });

  test("removeDependency throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId1!: string;
    let taskId2!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic I", description: "desc" });
      const task1 = domain.createTask({ epicId: epic.id, title: "Task I", description: "desc" });
      const task2 = domain.createTask({ epicId: epic.id, title: "Task J", description: "desc" });
      taskId1 = task1.id;
      taskId2 = task2.id;
      domain.addDependency(taskId1, taskId2);
    });

    assertTransactionGuard(() => domain.removeDependency(taskId1, taskId2));
    db.close(false);
  });

  test("createEpic throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    assertTransactionGuard(() => domain.createEpic({ title: "Outside Epic", description: "desc" }));
    db.close(false);
  });

  test("createTask throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let epicId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic Singular Task", description: "desc" });
      epicId = epic.id;
    });

    assertTransactionGuard(() => domain.createTask({ epicId, title: "Outside Task", description: "desc" }));
    db.close(false);
  });

  test("createSubtask throws outside transaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic Singular Subtask", description: "desc" });
      const task = domain.createTask({ epicId: epic.id, title: "Task Singular Subtask", description: "desc" });
      taskId = task.id;
    });

    assertTransactionGuard(() => domain.createSubtask({ taskId, title: "Outside Subtask" }));
    db.close(false);
  });

  test("createTaskBatch throws outside transaction when specs are non-empty", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let epicId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic J", description: "desc" });
      epicId = epic.id;
    });

    assertTransactionGuard(() =>
      domain.createTaskBatch({
        epicId,
        specs: [{ tempKey: "t1", title: "Task K", description: "desc" }],
      }),
    );
    db.close(false);
  });

  test("createSubtaskBatch throws outside transaction when specs are non-empty", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskId!: string;
    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic K", description: "desc" });
      const task = domain.createTask({ epicId: epic.id, title: "Task L", description: "desc" });
      taskId = task.id;
    });

    assertTransactionGuard(() =>
      domain.createSubtaskBatch({
        taskId,
        specs: [{ tempKey: "s1", title: "Subtask C", description: "", parent: { kind: "id", id: taskId } }],
      }),
    );
    db.close(false);
  });

  test("all mutators succeed when called inside a writeTransaction", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic L", description: "desc" });
      expect(epic.title).toBe("Epic L");

      const updatedEpic = domain.updateEpic(epic.id, { title: "Epic L Updated" });
      expect(updatedEpic.title).toBe("Epic L Updated");

      const task = domain.createTask({ epicId: epic.id, title: "Task M", description: "desc" });
      const updatedTask = domain.updateTask(task.id, { title: "Task M Updated" });
      expect(updatedTask.title).toBe("Task M Updated");

      const subtask = domain.createSubtask({ taskId: task.id, title: "Subtask D" });
      const updatedSubtask = domain.updateSubtask(subtask.id, { title: "Subtask D Updated" });
      expect(updatedSubtask.title).toBe("Subtask D Updated");

      domain.deleteSubtask(subtask.id);

      const task2 = domain.createTask({ epicId: epic.id, title: "Task N", description: "desc" });
      domain.addDependency(task2.id, task.id);
      const removed = domain.removeDependency(task2.id, task.id);
      expect(removed).toBe(1);

      domain.addDependencyBatch({
        specs: [{ source: { kind: "id", id: task2.id }, dependsOn: { kind: "id", id: task.id } }],
      });

      domain.deleteTask(task.id);
      domain.deleteEpic(epic.id);
    });

    db.close(false);
  });
});
