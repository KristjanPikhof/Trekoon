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

    const epic = domain.createEpic({ title: "Export test", description: "A test epic" });
    const task1 = domain.createTask({ epicId: epic.id, title: "Task one", description: "First task" });
    domain.createTask({ epicId: epic.id, title: "Task two", description: "Second task" });
    const sub1 = domain.createSubtask({ taskId: task1.id, title: "Sub one", description: "First subtask" });

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

    const epic = domain.createEpic({ title: "Dep test", description: "Test deps" });
    const task1 = domain.createTask({ epicId: epic.id, title: "Task A", description: "First" });
    const task2 = domain.createTask({ epicId: epic.id, title: "Task B", description: "Second" });
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

    const epicA = domain.createEpic({ title: "Epic A", description: "First epic" });
    const epicB = domain.createEpic({ title: "Epic B", description: "Second epic" });
    const taskA = domain.createTask({ epicId: epicA.id, title: "Task in A", description: "Belongs to A" });
    const taskB = domain.createTask({ epicId: epicB.id, title: "Task in B", description: "Belongs to B" });
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

    const epic = domain.createEpic({ title: "Empty epic", description: "No tasks here" });
    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.tasks).toHaveLength(0);
    expect(bundle.subtasks).toHaveLength(0);
    expect(bundle.dependencies).toHaveLength(0);
    expect(bundle.summary.taskCount).toBe(0);
  });

  test("counts mixed statuses correctly", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic({ title: "Status test", description: "Mixed statuses" });
    const t1 = domain.createTask({ epicId: epic.id, title: "T1", description: "D1" });
    domain.createTask({ epicId: epic.id, title: "T2", description: "D2" });
    domain.updateTask(t1.id, { status: "in_progress" });

    const bundle = buildEpicExportBundle(domain, epic.id);

    expect(bundle.summary.taskStatuses.inProgress).toBe(1);
    expect(bundle.summary.taskStatuses.todo).toBe(1);
    expect(bundle.summary.taskStatuses.total).toBe(2);
  });

  test("includes all tasks with stable ordering", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    const epic = domain.createEpic({ title: "Order test", description: "Check ordering" });
    const t1 = domain.createTask({ epicId: epic.id, title: "First", description: "A" });
    const t2 = domain.createTask({ epicId: epic.id, title: "Second", description: "B" });

    const bundle = buildEpicExportBundle(domain, epic.id);

    const ids = new Set(bundle.tasks.map((t) => t.id));
    expect(ids.has(t1.id)).toBe(true);
    expect(ids.has(t2.id)).toBe(true);
    expect(bundle.tasks).toHaveLength(2);
  });

  test("throws for non-existent epic", () => {
    const cwd = createWorkspace();
    const domain = createDomain(cwd);

    expect(() => buildEpicExportBundle(domain, "non-existent-id")).toThrow();
  });
});
