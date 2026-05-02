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

describe("parent-child dependency rejection", (): void => {
  test("addDependency: task A → subtask A1 (parent to child) is rejected with invalid_dependency", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskAId!: string;
    let subtaskA1Id!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic", description: "desc" });
      const taskA = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      const subtaskA1 = domain.createSubtask({ taskId: taskA.id, title: "Subtask A1" });
      taskAId = taskA.id;
      subtaskA1Id = subtaskA1.id;
    });

    let err: unknown;
    try {
      writeTransaction(db, (): void => {
        domain.addDependency(taskAId, subtaskA1Id);
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe("invalid_dependency");
    expect(domainErr.message).toMatch(/parent task to its own subtask/);
    const details = domainErr.details as Record<string, unknown>;
    expect((details.source as Record<string, string>).kind).toBe("task");
    expect((details.source as Record<string, string>).id).toBe(taskAId);
    expect((details.target as Record<string, string>).kind).toBe("subtask");
    expect((details.target as Record<string, string>).id).toBe(subtaskA1Id);
    expect(details.reason).toBe("parent_to_child");

    db.close(false);
  });

  test("addDependency: subtask A1 → task A (child to parent) is rejected with invalid_dependency", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskAId!: string;
    let subtaskA1Id!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic", description: "desc" });
      const taskA = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      const subtaskA1 = domain.createSubtask({ taskId: taskA.id, title: "Subtask A1" });
      taskAId = taskA.id;
      subtaskA1Id = subtaskA1.id;
    });

    let err: unknown;
    try {
      writeTransaction(db, (): void => {
        domain.addDependency(subtaskA1Id, taskAId);
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe("invalid_dependency");
    expect(domainErr.message).toMatch(/subtask to its own parent task/);
    const details = domainErr.details as Record<string, unknown>;
    expect((details.source as Record<string, string>).kind).toBe("subtask");
    expect((details.source as Record<string, string>).id).toBe(subtaskA1Id);
    expect((details.target as Record<string, string>).kind).toBe("task");
    expect((details.target as Record<string, string>).id).toBe(taskAId);
    expect(details.reason).toBe("parent_to_child");

    db.close(false);
  });

  test("addDependency: independent task A → task B is allowed", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskAId!: string;
    let taskBId!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic", description: "desc" });
      const taskA = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      const taskB = domain.createTask({ epicId: epic.id, title: "Task B", description: "" });
      taskAId = taskA.id;
      taskBId = taskB.id;
    });

    let dep!: unknown;
    writeTransaction(db, (): void => {
      dep = domain.addDependency(taskAId, taskBId);
    });

    expect(dep).toBeDefined();
    expect((dep as { sourceId: string }).sourceId).toBe(taskAId);
    expect((dep as { dependsOnId: string }).dependsOnId).toBe(taskBId);

    db.close(false);
  });

  test("addDependency: subtask under task A → subtask under task B (different parents) is allowed", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let subtaskA1Id!: string;
    let subtaskB1Id!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic", description: "desc" });
      const taskA = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      const taskB = domain.createTask({ epicId: epic.id, title: "Task B", description: "" });
      const subtaskA1 = domain.createSubtask({ taskId: taskA.id, title: "Subtask A1" });
      const subtaskB1 = domain.createSubtask({ taskId: taskB.id, title: "Subtask B1" });
      subtaskA1Id = subtaskA1.id;
      subtaskB1Id = subtaskB1.id;
    });

    let dep!: unknown;
    writeTransaction(db, (): void => {
      dep = domain.addDependency(subtaskA1Id, subtaskB1Id);
    });

    expect(dep).toBeDefined();
    expect((dep as { sourceId: string }).sourceId).toBe(subtaskA1Id);
    expect((dep as { dependsOnId: string }).dependsOnId).toBe(subtaskB1Id);

    db.close(false);
  });

  test("addDependencyBatch: batch with a parent-child edge is rejected; details name the offending edge", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskAId!: string;
    let taskBId!: string;
    let subtaskA1Id!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic", description: "desc" });
      const taskA = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      const taskB = domain.createTask({ epicId: epic.id, title: "Task B", description: "" });
      const subtaskA1 = domain.createSubtask({ taskId: taskA.id, title: "Subtask A1" });
      taskAId = taskA.id;
      taskBId = taskB.id;
      subtaskA1Id = subtaskA1.id;
    });

    let err: unknown;
    try {
      writeTransaction(db, (): void => {
        domain.addDependencyBatch({
          specs: [
            // valid edge
            { source: { kind: "id", id: taskAId }, dependsOn: { kind: "id", id: taskBId } },
            // parent-to-child edge — should cause rejection of the whole batch
            { source: { kind: "id", id: taskAId }, dependsOn: { kind: "id", id: subtaskA1Id } },
          ],
        });
      });
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(DomainError);
    const domainErr = err as DomainError;
    expect(domainErr.code).toBe("invalid_dependency");
    expect(domainErr.message).toMatch(/parent-to-child/);

    const details = domainErr.details as { issues: Array<Record<string, unknown>>; firstIssue: Record<string, unknown> };
    const parentChildIssues = details.issues.filter((i) => i.type === "parent_to_child");
    expect(parentChildIssues.length).toBeGreaterThan(0);

    const offendingIssue = parentChildIssues[0];
    expect(offendingIssue).toBeDefined();
    expect(offendingIssue?.sourceId).toBe(taskAId);
    expect(offendingIssue?.dependsOnId).toBe(subtaskA1Id);

    const issueDetails = offendingIssue?.details as Record<string, unknown>;
    expect((issueDetails?.source as Record<string, string>)?.kind).toBe("task");
    expect((issueDetails?.target as Record<string, string>)?.kind).toBe("subtask");
    expect(issueDetails?.reason).toBe("parent_to_child");

    db.close(false);
  });

  test("addDependencyBatch: task A → unrelated subtask B1 (different parent) is allowed", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);

    let taskAId!: string;
    let subtaskB1Id!: string;

    writeTransaction(db, (): void => {
      const epic = domain.createEpic({ title: "Epic", description: "desc" });
      const taskA = domain.createTask({ epicId: epic.id, title: "Task A", description: "desc" });
      const taskB = domain.createTask({ epicId: epic.id, title: "Task B", description: "" });
      const subtaskB1 = domain.createSubtask({ taskId: taskB.id, title: "Subtask B1" });
      taskAId = taskA.id;
      subtaskB1Id = subtaskB1.id;
    });

    let result!: unknown;
    writeTransaction(db, (): void => {
      result = domain.addDependencyBatch({
        specs: [{ source: { kind: "id", id: taskAId }, dependsOn: { kind: "id", id: subtaskB1Id } }],
      });
    });

    expect(result).toBeDefined();
    const batchResult = result as { dependencies: Array<{ sourceId: string; dependsOnId: string }> };
    expect(batchResult.dependencies.length).toBe(1);
    expect(batchResult.dependencies[0]?.sourceId).toBe(taskAId);
    expect(batchResult.dependencies[0]?.dependsOnId).toBe(subtaskB1Id);

    db.close(false);
  });
});
