import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { TrackerDomain } from "../../src/domain/tracker-domain";
import { migrateDatabase } from "../../src/storage/migrations";
import { writeTransaction } from "../../src/storage/database";

function createDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  migrateDatabase(db);
  return db;
}

/**
 * Seeds an epic with `taskCount` tasks.  Each task (except the first) depends
 * on the previous one, forming a linear dependency chain.  This exercises the
 * chunked IN-clause path in batchResolveDependencyStatuses for all tasks.
 */
function seedTasks(db: Database, domain: TrackerDomain, taskCount: number): string[] {
  const taskIds: string[] = [];

  writeTransaction(db, (): void => {
    const epic = domain.createEpic({ title: "Perf Epic", description: "perf test" });

    for (let i = 0; i < taskCount; i++) {
      const task = domain.createTask({
        epicId: epic.id,
        title: `Task ${i}`,
        description: `desc ${i}`,
      });
      taskIds.push(task.id);
    }

    // Each task i (i > 0) depends on task i-1 — linear chain of deps.
    for (let i = 1; i < taskCount; i++) {
      domain.addDependency(taskIds[i]!, taskIds[i - 1]!);
    }
  });

  return taskIds;
}

describe("batchResolveDependencyStatuses perf", (): void => {
  const TASK_COUNT = 200;
  const WALL_TIME_LIMIT_MS = 50;

  test("correctness: returns expected dependency map for 200 tasks", (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);
    const taskIds = seedTasks(db, domain, TASK_COUNT);

    const result = domain.batchResolveDependencyStatuses(taskIds);

    expect(result.size).toBe(TASK_COUNT);

    // First task has no dependencies.
    const first = result.get(taskIds[0]!);
    expect(first).toBeDefined();
    expect(first!.totalDependencies).toBe(0);
    expect(first!.blockers).toHaveLength(0);

    // Every other task has exactly 1 dependency (linear chain).
    for (let i = 1; i < TASK_COUNT; i++) {
      const entry = result.get(taskIds[i]!);
      expect(entry).toBeDefined();
      expect(entry!.totalDependencies).toBe(1);
      // The predecessor is todo/not done, so it's a blocker.
      expect(entry!.blockers).toHaveLength(1);
      expect(entry!.blockers[0]!.id).toBe(taskIds[i - 1]!);
      expect(entry!.blockers[0]!.kind).toBe("task");
    }

    db.close(false);
  });

  test(`wall-time: 200-task readiness completes under ${WALL_TIME_LIMIT_MS}ms`, (): void => {
    const db = createDb();
    const domain = new TrackerDomain(db);
    const taskIds = seedTasks(db, domain, TASK_COUNT);

    // Warm-up call — mitigates JIT / SQLite statement-prepare overhead.
    domain.batchResolveDependencyStatuses(taskIds);

    const start = performance.now();
    const result = domain.batchResolveDependencyStatuses(taskIds);
    const elapsed = performance.now() - start;

    expect(result.size).toBe(TASK_COUNT);
    expect(elapsed).toBeLessThan(WALL_TIME_LIMIT_MS);

    db.close(false);
  });
});
