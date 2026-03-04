import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";
import { ENTITY_OPERATIONS } from "../../src/domain/mutation-operations";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-mutation-conformance-"));
  tempDirs.push(workspace);
  return workspace;
}

function eventOperationsForEntity(cwd: string, entityKind: string, entityId: string): string[] {
  const storage = openTrekoonDatabase(cwd);
  try {
    const rows = storage.db
      .query("SELECT operation FROM events WHERE entity_kind = ? AND entity_id = ? ORDER BY created_at ASC;")
      .all(entityKind, entityId) as Array<{ operation: string }>;

    return rows.map((row) => row.operation);
  } finally {
    storage.close();
  }
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("mutation conformance", (): void => {
  test("epic task and subtask mutations append canonical events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const updatedEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["update", epicId, "--status", "in_progress"],
    });
    expect(updatedEpic.ok).toBeTrue();

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Code"],
    });
    expect(createdTask.ok).toBeTrue();
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const updatedTask = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "in_progress"],
    });
    expect(updatedTask.ok).toBeTrue();

    const createdSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Write tests"],
    });
    expect(createdSubtask.ok).toBeTrue();
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;

    const updatedSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["update", subtaskId, "--status", "done"],
    });
    expect(updatedSubtask.ok).toBeTrue();

    const deletedSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["delete", subtaskId],
    });
    expect(deletedSubtask.ok).toBeTrue();

    const deletedTask = await runTask({
      cwd,
      mode: "toon",
      args: ["delete", taskId],
    });
    expect(deletedTask.ok).toBeTrue();

    const deletedEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["delete", epicId],
    });
    expect(deletedEpic.ok).toBeTrue();

    expect(eventOperationsForEntity(cwd, "epic", epicId)).toEqual([
      ENTITY_OPERATIONS.epic.created,
      ENTITY_OPERATIONS.epic.updated,
      ENTITY_OPERATIONS.epic.deleted,
    ]);
    expect(eventOperationsForEntity(cwd, "task", taskId)).toEqual([
      ENTITY_OPERATIONS.task.created,
      ENTITY_OPERATIONS.task.updated,
      ENTITY_OPERATIONS.task.deleted,
    ]);
    expect(eventOperationsForEntity(cwd, "subtask", subtaskId)).toEqual([
      ENTITY_OPERATIONS.subtask.created,
      ENTITY_OPERATIONS.subtask.updated,
      ENTITY_OPERATIONS.subtask.deleted,
    ]);
  });

  test("dependency add/remove append canonical events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const epic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    const epicId = (epic.data as { epic: { id: string } }).epic.id;

    const taskA = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Task A", "--description", "A"],
    });
    const taskAId = (taskA.data as { task: { id: string } }).task.id;

    const taskB = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Task B", "--description", "B"],
    });
    const taskBId = (taskB.data as { task: { id: string } }).task.id;

    const added = await runDep({ cwd, mode: "toon", args: ["add", taskAId, taskBId] });
    expect(added.ok).toBeTrue();

    const removed = await runDep({ cwd, mode: "toon", args: ["remove", taskAId, taskBId] });
    expect(removed.ok).toBeTrue();

    const dependencyEventId = `${taskAId}->${taskBId}`;
    expect(eventOperationsForEntity(cwd, "dependency", dependencyEventId)).toEqual([
      ENTITY_OPERATIONS.dependency.removed,
    ]);

    const storage = openTrekoonDatabase(cwd);
    try {
      const addedRow = storage.db
        .query("SELECT operation FROM events WHERE entity_kind = 'dependency' AND operation = ? LIMIT 1;")
        .get(ENTITY_OPERATIONS.dependency.added) as { operation: string } | null;
      expect(addedRow?.operation).toBe(ENTITY_OPERATIONS.dependency.added);
    } finally {
      storage.close();
    }
  });
});
