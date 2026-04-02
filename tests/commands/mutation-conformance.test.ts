import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createBoardApiHandler } from "../../src/board/routes";
import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";
import { ENTITY_OPERATIONS } from "../../src/domain/mutation-operations";
import { MutationService } from "../../src/domain/mutation-service";
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

    const updatedSubtaskInProgress = await runSubtask({
      cwd,
      mode: "toon",
      args: ["update", subtaskId, "--status", "in_progress"],
    });
    expect(updatedSubtaskInProgress.ok).toBeTrue();

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

  test("subtask update events preserve explicit empty descriptions", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Scope" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Code" });
      const subtask = mutations.createSubtask({
        taskId: task.id,
        title: "Write tests",
        description: "Regression coverage",
      });

      mutations.updateSubtask(subtask.id, {
        status: "in_progress",
      });

      const updatedSubtask = mutations.updateSubtask(subtask.id, {
        description: "",
        status: "done",
      });

      expect(updatedSubtask).toEqual(expect.objectContaining({ description: "", status: "done" }));
      expect(eventRowsForEntity(cwd, "subtask", subtask.id)).toEqual([
        {
          operation: ENTITY_OPERATIONS.subtask.created,
          payload: {
            fields: {
              task_id: task.id,
              title: "Write tests",
              description: "Regression coverage",
              status: "todo",
            },
          },
        },
        {
          operation: ENTITY_OPERATIONS.subtask.updated,
          payload: {
            fields: {
              task_id: task.id,
              title: "Write tests",
              description: "Regression coverage",
              status: "in_progress",
              owner: null,
            },
          },
        },
        {
          operation: ENTITY_OPERATIONS.subtask.updated,
          payload: {
            fields: {
              task_id: task.id,
              title: "Write tests",
              description: "",
              status: "done",
              owner: null,
            },
          },
        },
      ]);
    } finally {
      storage.close();
    }
  });

  test("subtask delete emits dependency removal events for touching rows", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Scope" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "First" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Code" });
      const subtask = mutations.createSubtask({ taskId: task.id, title: "Write tests", description: "Coverage" });
      const helper = mutations.createSubtask({ taskId: task.id, title: "Prep fixtures", description: "Setup" });

      mutations.addDependency(subtask.id, blocker.id);
      mutations.addDependency(helper.id, subtask.id);

      const result = mutations.deleteSubtask(subtask.id);

      expect(result.deletedDependencyIds).toHaveLength(2);
      expect(eventOperationsForEntity(cwd, "dependency", `${subtask.id}->${blocker.id}`)).toEqual([
        ENTITY_OPERATIONS.dependency.removed,
      ]);
      expect(eventOperationsForEntity(cwd, "dependency", `${helper.id}->${subtask.id}`)).toEqual([
        ENTITY_OPERATIONS.dependency.removed,
      ]);
    } finally {
      storage.close();
    }
  });

  test("batch create and dependency add-many append canonical events atomically", async (): Promise<void> => {
    const cwd = createWorkspace();

    const epic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    const epicId = (epic.data as { epic: { id: string } }).epic.id;

    const createdTasks = await runTask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--epic",
        epicId,
        "--task",
        "task-1|Task A|A|todo",
        "--task",
        "task-2|Task B|B|todo",
      ],
    });
    expect(createdTasks.ok).toBeTrue();
    const [taskAId, taskBId] = (createdTasks.data as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);

    const createdSubtasks = await runSubtask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--task",
        taskAId ?? "",
        "--subtask",
        "sub-1|Subtask A|desc|todo",
        "--subtask",
        "sub-2|Subtask B|desc|done",
      ],
    });
    expect(createdSubtasks.ok).toBeTrue();
    const [subtaskAId, subtaskBId] = (createdSubtasks.data as { subtasks: Array<{ id: string }> }).subtasks.map((subtask) => subtask.id);

    const addedDeps = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", "--dep", `${taskBId}|${taskAId}`, "--dep", `${subtaskBId}|${subtaskAId}`],
    });
    expect(addedDeps.ok).toBeTrue();

    expect(eventRowsForEntity(cwd, "task", taskAId ?? "")).toEqual([
      {
        operation: ENTITY_OPERATIONS.task.created,
        payload: {
          fields: {
            epic_id: epicId,
            title: "Task A",
            description: "A",
            status: "todo",
          },
        },
      },
    ]);
    expect(eventRowsForEntity(cwd, "task", taskBId ?? "")).toEqual([
      {
        operation: ENTITY_OPERATIONS.task.created,
        payload: {
          fields: {
            epic_id: epicId,
            title: "Task B",
            description: "B",
            status: "todo",
          },
        },
      },
    ]);
    expect(eventRowsForEntity(cwd, "subtask", subtaskAId ?? "")).toEqual([
      {
        operation: ENTITY_OPERATIONS.subtask.created,
        payload: {
          fields: {
            task_id: taskAId,
            title: "Subtask A",
            description: "desc",
            status: "todo",
          },
        },
      },
    ]);
    expect(eventRowsForEntity(cwd, "subtask", subtaskBId ?? "")).toEqual([
      {
        operation: ENTITY_OPERATIONS.subtask.created,
        payload: {
          fields: {
            task_id: taskAId,
            title: "Subtask B",
            description: "desc",
            status: "done",
          },
        },
      },
    ]);

    const storage = openTrekoonDatabase(cwd);
    try {
      const dependencyIds = (addedDeps.data as { dependencies: Array<{ id: string }> }).dependencies.map((dependency) => dependency.id);
      const addedRows = storage.db
        .query("SELECT entity_id, payload FROM events WHERE entity_kind = 'dependency' AND operation = ? ORDER BY created_at ASC, id ASC;")
        .all(ENTITY_OPERATIONS.dependency.added) as Array<{ entity_id: string; payload: string }>;
      expect(addedRows.map((row) => ({ entityId: row.entity_id, payload: JSON.parse(row.payload) }))).toEqual([
        {
          entityId: dependencyIds[0] ?? "",
          payload: {
            fields: {
              source_id: taskBId,
              source_kind: "task",
              depends_on_id: taskAId,
              depends_on_kind: "task",
            },
          },
        },
        {
          entityId: dependencyIds[1] ?? "",
          payload: {
            fields: {
              source_id: subtaskBId,
              source_kind: "subtask",
              depends_on_id: subtaskAId,
              depends_on_kind: "subtask",
            },
          },
        },
      ]);
    } finally {
      storage.close();
    }
  });

  test("epic expand rolls back task and subtask creates when dependency refs are unresolved", async (): Promise<void> => {
    const cwd = createWorkspace();

    const epic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    const epicId = (epic.data as { epic: { id: string } }).epic.id;

    const expanded = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "expand",
        epicId,
        "--task",
        "task-1|Task A|A|todo",
        "--subtask",
        "@task-1|sub-1|Subtask A|desc|todo",
        "--dep",
        "@task-1|@missing-subtask",
      ],
    });

    expect(expanded.ok).toBeFalse();
    expect(expanded.error?.code).toBe("invalid_input");
    expect(expanded.human).toContain("Unknown temp key @missing-subtask");

    const storage = openTrekoonDatabase(cwd);
    try {
      const tasks = storage.db.query("SELECT COUNT(*) AS count FROM tasks WHERE epic_id = ?;").get(epicId) as { count: number };
      const subtasks = storage.db.query("SELECT COUNT(*) AS count FROM subtasks;").get() as { count: number };
      const deps = storage.db.query("SELECT COUNT(*) AS count FROM dependencies;").get() as { count: number };
      const nonEpicEvents = storage.db
        .query("SELECT entity_kind FROM events WHERE entity_kind IN ('task', 'subtask', 'dependency');")
        .all() as Array<{ entity_kind: string }>;

      expect(tasks.count).toBe(0);
      expect(subtasks.count).toBe(0);
      expect(deps.count).toBe(0);
      expect(nonEpicEvents).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("epic expand appends task, subtask, then dependency events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const epic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    const epicId = (epic.data as { epic: { id: string } }).epic.id;

    const expanded = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "expand",
        epicId,
        "--task",
        "task-1|Task A|A|todo",
        "--subtask",
        "@task-1|sub-1|Subtask A|desc|todo",
        "--dep",
        "@task-1|@sub-1",
      ],
    });
    expect(expanded.ok).toBeTrue();

    const storage = openTrekoonDatabase(cwd);
    try {
      const rows = storage.db
        .query("SELECT entity_kind, operation FROM events WHERE entity_kind IN ('task', 'subtask', 'dependency') ORDER BY created_at ASC;")
        .all() as Array<{ entity_kind: string; operation: string }>;

      expect(rows).toEqual([
        { entity_kind: "task", operation: ENTITY_OPERATIONS.task.created },
        { entity_kind: "subtask", operation: ENTITY_OPERATIONS.subtask.created },
        { entity_kind: "dependency", operation: ENTITY_OPERATIONS.dependency.added },
      ]);
    } finally {
      storage.close();
    }
  });

  test("one-shot epic create appends epic, task, subtask, then dependency events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const created = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Roadmap",
        "--description",
        "Scope",
        "--task",
        "task-1|Task A|A|todo",
        "--subtask",
        "@task-1|sub-1|Subtask A|desc|todo",
        "--dep",
        "@task-1|@sub-1",
      ],
    });
    expect(created.ok).toBeTrue();

    const data = created.data as {
      epic: { id: string };
      tasks: Array<{ id: string }>;
      subtasks: Array<{ id: string }>;
      dependencies: Array<{ id: string }>;
    };
    expect(eventRowsForEntity(cwd, "epic", data.epic.id)).toEqual([
      {
        operation: ENTITY_OPERATIONS.epic.created,
        payload: {
          fields: {
            title: "Roadmap",
            description: "Scope",
            status: "todo",
          },
        },
      },
    ]);

    const storage = openTrekoonDatabase(cwd);
    try {
      const rows = storage.db
        .query("SELECT entity_kind, operation FROM events ORDER BY created_at ASC, id ASC;")
        .all() as Array<{ entity_kind: string; operation: string }>;

      expect(rows).toEqual([
        { entity_kind: "epic", operation: ENTITY_OPERATIONS.epic.created },
        { entity_kind: "task", operation: ENTITY_OPERATIONS.task.created },
        { entity_kind: "subtask", operation: ENTITY_OPERATIONS.subtask.created },
        { entity_kind: "dependency", operation: ENTITY_OPERATIONS.dependency.added },
      ]);
    } finally {
      storage.close();
    }
  });

  test("one-shot epic create rolls back epic and events on unresolved refs", async (): Promise<void> => {
    const cwd = createWorkspace();

    const created = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Roadmap",
        "--description",
        "Scope",
        "--task",
        "task-1|Task A|A|todo",
        "--dep",
        "@task-1|@missing-subtask",
      ],
    });
    expect(created.ok).toBeFalse();
    expect(created.error?.code).toBe("invalid_input");

    const storage = openTrekoonDatabase(cwd);
    try {
      const counts = {
        epics: (storage.db.query("SELECT COUNT(*) AS count FROM epics;").get() as { count: number }).count,
        tasks: (storage.db.query("SELECT COUNT(*) AS count FROM tasks;").get() as { count: number }).count,
        subtasks: (storage.db.query("SELECT COUNT(*) AS count FROM subtasks;").get() as { count: number }).count,
        dependencies: (storage.db.query("SELECT COUNT(*) AS count FROM dependencies;").get() as { count: number }).count,
        events: (storage.db.query("SELECT COUNT(*) AS count FROM events;").get() as { count: number }).count,
      };

      expect(counts).toEqual({ epics: 0, tasks: 0, subtasks: 0, dependencies: 0, events: 0 });
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
          owner: null,
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
          owner: null,
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

  test("board mutation routes append canonical task update events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Ship board"],
    });
    expect(createdTask.ok).toBeTrue();
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const storage = openTrekoonDatabase(cwd);
    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "board-token" });
      const response = await handler(new Request(`http://board.test/api/tasks/${taskId}?token=board-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "in_progress" }),
      }));

      expect(response.status).toBe(200);
    } finally {
      storage.close();
    }

    expect(eventOperationsForEntity(cwd, "task", taskId)).toEqual([
      ENTITY_OPERATIONS.task.created,
      ENTITY_OPERATIONS.task.updated,
    ]);
  });

  test("board routes append subtask and dependency mutation events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Ship board"],
    });
    expect(createdTask.ok).toBeTrue();
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const createdOtherTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Blocker", "--description", "Finish first"],
    });
    expect(createdOtherTask.ok).toBeTrue();
    const blockerTaskId = (createdOtherTask.data as { task: { id: string } }).task.id;

    const createdSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Write tests", "--description", "Cover board API"],
    });
    expect(createdSubtask.ok).toBeTrue();
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;

    const storage = openTrekoonDatabase(cwd);
    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "board-token" });

      const updatedSubtask = await handler(new Request(`http://board.test/api/subtasks/${subtaskId}?token=board-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "blocked" }),
      }));
      expect(updatedSubtask.status).toBe(200);

      const addedDependency = await handler(new Request("http://board.test/api/dependencies?token=board-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourceId: taskId, dependsOnId: blockerTaskId }),
      }));
      expect(addedDependency.status).toBe(201);

      const removedDependency = await handler(new Request(`http://board.test/api/dependencies?token=board-token&sourceId=${encodeURIComponent(taskId)}&dependsOnId=${encodeURIComponent(blockerTaskId)}`, {
        method: "DELETE",
      }));
      expect(removedDependency.status).toBe(200);
    } finally {
      storage.close();
    }

    expect(eventOperationsForEntity(cwd, "subtask", subtaskId)).toEqual([
      ENTITY_OPERATIONS.subtask.created,
      ENTITY_OPERATIONS.subtask.updated,
    ]);

    const dependencyRows = eventRowsForEntity(cwd, "dependency", `${taskId}->${blockerTaskId}`);
    expect(dependencyRows.at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.dependency.removed,
      payload: {
        fields: {
          source_id: taskId,
          depends_on_id: blockerTaskId,
        },
      },
    });

    const storageCheck = openTrekoonDatabase(cwd);
    try {
      const addedDependencyRow = storageCheck.db
        .query("SELECT operation FROM events WHERE entity_kind = 'dependency' AND operation = ? LIMIT 1;")
        .get(ENTITY_OPERATIONS.dependency.added) as { operation: string } | null;
      expect(addedDependencyRow?.operation).toBe(ENTITY_OPERATIONS.dependency.added);
    } finally {
      storageCheck.close();
    }
  });

  test("board epic cascade route appends canonical update events for every changed record", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Ship board"],
    });
    expect(createdTask.ok).toBeTrue();
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const createdSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Write tests", "--description", "Cover board API"],
    });
    expect(createdSubtask.ok).toBeTrue();
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;

    const storage = openTrekoonDatabase(cwd);
    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "board-token" });
      const response = await handler(new Request(`http://board.test/api/epics/${epicId}/cascade?token=board-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "done" }),
      }));

      expect(response.status).toBe(200);
    } finally {
      storage.close();
    }

    expect(eventRowsForEntity(cwd, "epic", epicId).at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.epic.updated,
      payload: {
        fields: {
          title: "Roadmap",
          description: "Scope",
          status: "done",
        },
      },
    });
    expect(eventRowsForEntity(cwd, "task", taskId).at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.task.updated,
      payload: {
        fields: {
          epic_id: epicId,
          title: "Implement",
          description: "Ship board",
          status: "done",
          owner: null,
        },
      },
    });
    expect(eventRowsForEntity(cwd, "subtask", subtaskId).at(-1)).toEqual({
      operation: ENTITY_OPERATIONS.subtask.updated,
      payload: {
        fields: {
          task_id: taskId,
          title: "Write tests",
          description: "Cover board API",
          status: "done",
          owner: null,
        },
      },
    });
  });

  test("board epic cascade route rolls back without partial update events", async (): Promise<void> => {
    const cwd = createWorkspace();

    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Scope"],
    });
    expect(createdEpic.ok).toBeTrue();
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const blockerTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Blocker", "--description", "Finish first"],
    });
    expect(blockerTask.ok).toBeTrue();
    const blockerTaskId = (blockerTask.data as { task: { id: string } }).task.id;

    const blockedTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Ship board"],
    });
    expect(blockedTask.ok).toBeTrue();
    const blockedTaskId = (blockedTask.data as { task: { id: string } }).task.id;

    const blockedSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", blockedTaskId, "--title", "Write tests", "--description", "Cover board API"],
    });
    expect(blockedSubtask.ok).toBeTrue();
    const blockedSubtaskId = (blockedSubtask.data as { subtask: { id: string } }).subtask.id;

    const dependency = await runDep({ cwd, mode: "toon", args: ["add", blockedTaskId, blockerTaskId] });
    expect(dependency.ok).toBeTrue();

    const storage = openTrekoonDatabase(cwd);
    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "board-token" });
      const response = await handler(new Request(`http://board.test/api/epics/${epicId}/cascade?token=board-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "in_progress" }),
      }));

      expect(response.status).toBe(409);
    } finally {
      storage.close();
    }

    expect(eventOperationsForEntity(cwd, "epic", epicId)).toEqual([ENTITY_OPERATIONS.epic.created]);
    expect(eventOperationsForEntity(cwd, "task", blockerTaskId)).toEqual([ENTITY_OPERATIONS.task.created]);
    expect(eventOperationsForEntity(cwd, "task", blockedTaskId)).toEqual([ENTITY_OPERATIONS.task.created]);
    expect(eventOperationsForEntity(cwd, "subtask", blockedSubtaskId)).toEqual([ENTITY_OPERATIONS.subtask.created]);
  });
});
