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
  return eventRowsForEntity(cwd, entityKind, entityId).map((row) => row.operation);
}

function eventRowsForEntity(
  cwd: string,
  entityKind: string,
  entityId: string,
): Array<{ operation: string; payload: { fields?: Record<string, unknown> } }> {
  const storage = openTrekoonDatabase(cwd);
  try {
    const rows = storage.db
      .query("SELECT operation, payload FROM events WHERE entity_kind = ? AND entity_id = ? ORDER BY created_at ASC;")
      .all(entityKind, entityId) as Array<{ operation: string; payload: string }>;

    return rows.map((row) => ({
      operation: row.operation,
      payload: JSON.parse(row.payload) as { fields?: Record<string, unknown> },
    }));
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

  test("scoped replace appends canonical update events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap alpha", "--description", "Epic alpha desc"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Task alpha", "--description", "Task alpha desc"],
    });
    expect(createdTask.ok).toBeTrue();
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const createdSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Subtask alpha", "--description", "Subtask alpha desc"],
    });
    expect(createdSubtask.ok).toBeTrue();
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;

    const replaced = await runEpic({
      cwd,
      mode: "toon",
      args: ["replace", epicId, "--search", "alpha", "--replace", "beta", "--apply"],
    });

    expect(replaced.ok).toBeTrue();

    const epicEvents = eventRowsForEntity(cwd, "epic", epicId);
    const taskEvents = eventRowsForEntity(cwd, "task", taskId);
    const subtaskEvents = eventRowsForEntity(cwd, "subtask", subtaskId);

    expect(epicEvents.at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.epic.updated,
      payload: {
        fields: {
          title: "Roadmap beta",
          description: "Epic beta desc",
          status: "todo",
        },
      },
    });
    expect(taskEvents.at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.task.updated,
      payload: {
        fields: {
          epic_id: epicId,
          title: "Task beta",
          description: "Task beta desc",
          status: "todo",
        },
      },
    });
    expect(subtaskEvents.at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.subtask.updated,
      payload: {
        fields: {
          task_id: taskId,
          title: "Subtask beta",
          description: "Subtask beta desc",
          status: "todo",
        },
      },
    });
  });

  test("scoped replace rolls back without partial update events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap alpha", "--description", "Epic alpha desc"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Task alpha", "--description", "Task alpha desc"],
    });
    expect(createdTask.ok).toBeTrue();
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const createdSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Subtask alpha", "--description", "Subtask alpha desc"],
    });
    expect(createdSubtask.ok).toBeTrue();
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;

    const storage = openTrekoonDatabase(cwd);
    try {
      storage.db.exec(`
        CREATE TRIGGER fail_task_replace
        BEFORE UPDATE ON tasks
        WHEN NEW.title = 'Task beta'
        BEGIN
          SELECT RAISE(ABORT, 'blocked task replace');
        END;
      `);
    } finally {
      storage.close();
    }

    const replaced = await runEpic({
      cwd,
      mode: "toon",
      args: ["replace", epicId, "--search", "alpha", "--replace", "beta", "--apply"],
    });

    expect(replaced.ok).toBeFalse();
    expect(replaced.error?.code).toBe("internal_error");

    const shown = await runEpic({ cwd, mode: "toon", args: ["show", epicId, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as {
      tree: {
        id: string;
        title: string;
        description: string;
        status: string;
        tasks: Array<{
          id: string;
          epicId: string;
          title: string;
          description: string;
          status: string;
          subtasks: Array<{
            id: string;
            taskId: string;
            title: string;
            description: string;
            status: string;
          }>;
        }>;
      };
    }).tree).toEqual({
      id: epicId,
      title: "Roadmap alpha",
      description: "Epic alpha desc",
      status: "todo",
      tasks: [
        {
          id: taskId,
          epicId,
          title: "Task alpha",
          description: "Task alpha desc",
          status: "todo",
          subtasks: [
            {
              id: subtaskId,
              taskId,
              title: "Subtask alpha",
              description: "Subtask alpha desc",
              status: "todo",
            },
          ],
        },
      ],
    });

    expect(eventOperationsForEntity(cwd, "epic", epicId)).toEqual([ENTITY_OPERATIONS.epic.created]);
    expect(eventOperationsForEntity(cwd, "task", taskId)).toEqual([ENTITY_OPERATIONS.task.created]);
    expect(eventOperationsForEntity(cwd, "subtask", subtaskId)).toEqual([ENTITY_OPERATIONS.subtask.created]);
  });
});
