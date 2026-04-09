import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { TrackerDomain } from "../../src/domain/tracker-domain";
import { buildEpicExportBundle } from "../../src/export/build-epic-export-bundle";
import { EXPORT_SCHEMA_VERSION } from "../../src/export/types";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "trekoon-export-"));
  tempDirs.push(dir);
  return dir;
}

function createDomain(cwd: string): TrackerDomain {
  const db = openTrekoonDatabase(cwd);
  return new TrackerDomain(db.db);
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("buildEpicExportBundle", () => {
  test("exports an epic with tasks and subtasks", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic("Export test", "A test epic");
    const task1 = domain.createTask(epic.id, "Task one", "First task");
    const task2 = domain.createTask(epic.id, "Task two", "Second task");
    const sub1 = domain.createSubtask(task1.id, "Sub one", "First subtask");

    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(bundle.epic.id).toBe(epic.id);
    expect(bundle.tasks).toHaveLength(2);
    expect(bundle.subtasks).toHaveLength(1);
    expect(bundle.subtasks[0].id).toBe(sub1.id);
    expect(bundle.summary.taskCount).toBe(2);
    expect(bundle.summary.subtaskCount).toBe(1);
    expect(bundle.summary.taskStatuses.todo).toBe(2);
    expect(bundle.warnings).toHaveLength(0);
  });

  test("classifies internal dependencies correctly", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic("Dep test", "Test deps");
    const task1 = domain.createTask(epic.id, "Task A", "First");
    const task2 = domain.createTask(epic.id, "Task B", "Second");
    domain.addDependency(task2.id, task1.id);

    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.dependencies).toHaveLength(1);
    expect(bundle.dependencies[0].internal).toBe(true);
    expect(bundle.dependencies[0].sourceId).toBe(task2.id);
    expect(bundle.dependencies[0].dependsOnId).toBe(task1.id);
    expect(bundle.blockedBy.get(task2.id)).toEqual([task1.id]);
    expect(bundle.blocks.get(task1.id)).toEqual([task2.id]);
    expect(bundle.externalNodes).toHaveLength(0);
  });

  test("classifies external dependencies and resolves stubs", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epicA = domain.createEpic("Epic A", "First epic");
    const epicB = domain.createEpic("Epic B", "Second epic");
    const taskA = domain.createTask(epicA.id, "Task in A", "Belongs to A");
    const taskB = domain.createTask(epicB.id, "Task in B", "Belongs to B");
    domain.addDependency(taskA.id, taskB.id);

    const bundle = buildEpicExportBundle(domain, epicA.id);

    expect(bundle.dependencies).toHaveLength(1);
    expect(bundle.dependencies[0].internal).toBe(false);
    expect(bundle.externalNodes).toHaveLength(1);
    expect(bundle.externalNodes[0].id).toBe(taskB.id);
    expect(bundle.externalNodes[0].kind).toBe("task");
    expect(bundle.externalNodes[0].title).toBe("Task in B");
    expect(bundle.externalNodes[0].epicId).toBe(epicB.id);
    expect(bundle.warnings).toHaveLength(0);
  });

  test("handles epic with no tasks", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic("Empty epic", "No tasks here");
    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.tasks).toHaveLength(0);
    expect(bundle.subtasks).toHaveLength(0);
    expect(bundle.dependencies).toHaveLength(0);
    expect(bundle.summary.taskCount).toBe(0);
  });

  test("counts mixed statuses correctly", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic("Status test", "Mixed statuses");
    const t1 = domain.createTask(epic.id, "T1", "D1");
    domain.createTask(epic.id, "T2", "D2");
    domain.updateTask(t1.id, { status: "in_progress" });

    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.summary.taskStatuses.inProgress).toBe(1);
    expect(bundle.summary.taskStatuses.todo).toBe(1);
    expect(bundle.summary.taskStatuses.total).toBe(2);
  });

  test("stable ordering by createdAt then id", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic("Order test", "Check ordering");
    const t1 = domain.createTask(epic.id, "First", "A");
    const t2 = domain.createTask(epic.id, "Second", "B");

    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.tasks[0].id).toBe(t1.id);
    expect(bundle.tasks[1].id).toBe(t2.id);
  });

  test("throws for non-existent epic", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    expect(() => buildEpicExportBundle(domain, "non-existent-id")).toThrow();
  });
});
