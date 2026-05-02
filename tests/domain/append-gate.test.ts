import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { migrateDatabase } from "../../src/storage/migrations";

function createInMemoryDb(): { db: Database; service: MutationService; domain: TrackerDomain } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  const service = new MutationService(db, process.cwd());
  const domain = new TrackerDomain(db);
  return { db, service, domain };
}

describe("append+status dependency gate (P0 finding 1)", (): void => {
  test("blocked task with unresolved dep + append+status in_progress — dependency_blocked, row unchanged", (): void => {
    const { service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const upstream = service.createTask({ epicId: epic.id, title: "U", description: "d", status: "todo" });
    const downstream = service.createTask({ epicId: epic.id, title: "D", description: "d", status: "todo" });
    service.addDependency(downstream.id, upstream.id);

    // Capture the canonical "blocked" row — including description and updatedAt
    // — so we can verify nothing changed after the failed mutation.
    const before = service.updateTask(downstream.id, { status: "blocked" });
    expect(before.status).toBe("blocked");
    const beforeDescription = before.description;
    const beforeUpdatedAt = before.updatedAt;

    let caught: unknown;
    try {
      service.appendToTaskDescription({
        taskId: downstream.id,
        append: "\nappended note that should not land",
        status: "in_progress",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const err = caught as { code?: string; details?: { unresolvedDependencyIds?: readonly string[] } };
    expect(err.code).toBe("dependency_blocked");
    expect(err.details?.unresolvedDependencyIds).toEqual([upstream.id]);

    // Atomic rollback: status, description, owner, updatedAt all unchanged.
    const row = domain.getTaskOrThrow(downstream.id);
    expect(row.status).toBe("blocked");
    expect(row.description).toBe(beforeDescription);
    expect(row.owner).toBeNull();
    expect(row.updatedAt).toBe(beforeUpdatedAt);
  });

  test("blocked subtask with unresolved dep + append+status in_progress — dependency_blocked, row unchanged", (): void => {
    const { service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const task = service.createTask({ epicId: epic.id, title: "T", description: "d", status: "todo" });
    const upstream = service.createSubtask({ taskId: task.id, title: "U", description: "d", status: "todo" });
    const downstream = service.createSubtask({ taskId: task.id, title: "D", description: "d", status: "todo" });
    service.addDependency(downstream.id, upstream.id);

    const before = service.updateSubtask(downstream.id, { status: "blocked" });
    expect(before.status).toBe("blocked");
    const beforeDescription = before.description;
    const beforeUpdatedAt = before.updatedAt;

    let caught: unknown;
    try {
      service.appendToSubtaskDescription({
        subtaskId: downstream.id,
        append: "\nappended note that should not land",
        status: "in_progress",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeDefined();
    const err = caught as { code?: string; details?: { unresolvedDependencyIds?: readonly string[] } };
    expect(err.code).toBe("dependency_blocked");
    expect(err.details?.unresolvedDependencyIds).toEqual([upstream.id]);

    const row = domain.getSubtaskOrThrow(downstream.id);
    expect(row.status).toBe("blocked");
    expect(row.description).toBe(beforeDescription);
    expect(row.owner).toBeNull();
    expect(row.updatedAt).toBe(beforeUpdatedAt);
  });

  test("append-only without --status on blocked-with-dep task — succeeds (no gating)", (): void => {
    const { service, domain } = createInMemoryDb();
    const epic = service.createEpic({ title: "E", description: "d" });
    const upstream = service.createTask({ epicId: epic.id, title: "U", description: "d", status: "todo" });
    const downstream = service.createTask({ epicId: epic.id, title: "D", description: "d", status: "todo" });
    service.addDependency(downstream.id, upstream.id);
    service.updateTask(downstream.id, { status: "blocked" });

    // Pure append (no status change) must continue to work even when the row
    // is dependency-blocked — gating only applies to forward-progress
    // transitions into DEPENDENCY_GATED_STATUSES.
    const updated = service.appendToTaskDescription({
      taskId: downstream.id,
      append: "\nblocker investigation note",
    });

    expect(updated.status).toBe("blocked");
    expect(updated.description.endsWith("blocker investigation note")).toBe(true);
    const row = domain.getTaskOrThrow(downstream.id);
    expect(row.status).toBe("blocked");
    expect(row.description).toBe(updated.description);
  });
});
