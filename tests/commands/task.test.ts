import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-task-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("task command", (): void => {
  test("requires description on create", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const result = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("supports create/show/update/delete lifecycle", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it", "--status", "custom"],
    });
    expect(created.ok).toBeTrue();
    const taskId = (created.data as { task: { id: string; status: string } }).task.id;
    expect((created.data as { task: { status: string } }).task.status).toBe("custom");

    const shown = await runTask({ cwd, mode: "human", args: ["show", taskId] });
    expect(shown.ok).toBeTrue();

    const updated = await runTask({ cwd, mode: "human", args: ["update", taskId, "--status", "in-progress"] });
    expect(updated.ok).toBeTrue();
    expect((updated.data as { task: { status: string } }).task.status).toBe("in-progress");

    const removed = await runTask({ cwd, mode: "human", args: ["delete", taskId] });
    expect(removed.ok).toBeTrue();

    const afterDelete = await runTask({ cwd, mode: "human", args: ["show", taskId] });
    expect(afterDelete.ok).toBeFalse();
    expect(afterDelete.error?.code).toBe("not_found");
  });

  test("create-many creates tasks in input order with compact mappings", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--epic",
        epicId,
        "--task",
        "seed-1|First|Desc one|todo",
        "--task",
        "seed-2|Second|Desc two|in_progress",
      ],
    });

    expect(created.ok).toBeTrue();
    expect((created.data as { tasks: Array<{ title: string; status: string }> }).tasks).toMatchObject([
      { title: "First", status: "todo" },
      { title: "Second", status: "in_progress" },
    ]);
    expect((created.data as { result: { mappings: Array<{ kind: string; tempKey: string; id: string }> } }).result.mappings).toMatchObject([
      { kind: "task", tempKey: "seed-1" },
      { kind: "task", tempKey: "seed-2" },
    ]);
    expect(created.human).toContain("Created 2 task(s)");
    expect(created.human.indexOf("First")).toBeLessThan(created.human.indexOf("Second"));
  });

  test("create-many prevalidates full batch before inserting tasks", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--epic",
        epicId,
        "--task",
        "seed-1|First|Desc one|todo",
        "--task",
        "seed-2|Second||todo",
      ],
    });

    expect(created.ok).toBeFalse();
    expect(created.error?.code).toBe("invalid_input");
    expect(created.human).toContain("Task spec 2 is missing a description.");

    const listed = await runTask({ cwd, mode: "toon", args: ["list", "--all", "--epic", epicId] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test("create-many rejects unexpected positional args", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: ["create-many", "unexpected", "--epic", epicId, "--task", "seed-1|First|Desc one|todo"],
    });

    expect(created.ok).toBeFalse();
    expect(created.error?.code).toBe("invalid_input");
    expect(created.human).toContain("Unexpected positional arguments: unexpected.");
  });

  test("create-many rejects duplicate temp keys without partial inserts", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--epic",
        epicId,
        "--task",
        "seed-1|First|Desc one|todo",
        "--task",
        "seed-1|Second|Desc two|done",
      ],
    });

    expect(created.ok).toBeFalse();
    expect(created.error?.code).toBe("invalid_input");
    expect(created.human).toContain("Duplicate temp key 'seed-1'");

    const listed = await runTask({ cwd, mode: "toon", args: ["list", "--all", "--epic", epicId] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test("task show --all returns subtasks with descriptions", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Do part A", "--description", "subtask details"],
    });

    const shown = await runTask({ cwd, mode: "toon", args: ["show", taskId, "--all"] });
    expect(shown.ok).toBeTrue();

    const task = (shown.data as { task: { description: string; subtasks: Array<{ description: string }> } }).task;
    expect(task.description).toBe("build it");
    expect(task.subtasks.length).toBe(1);
    expect(task.subtasks[0]?.description).toBe("subtask details");
    expect((shown.data as { subtasksCount: number }).subtasksCount).toBe(1);
  });

  test("show defaults to tree in machine mode", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Do part A", "--description", "subtask details"],
    });

    const shown = await runTask({ cwd, mode: "toon", args: ["show", taskId] });
    expect(shown.ok).toBeTrue();
    expect(shown.human).toContain("subtask");
    expect(shown.human).not.toContain("desc=");
  });

  test("list defaults to table and show supports table view", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    const listed = await runTask({ cwd, mode: "human", args: ["list"] });
    expect(listed.ok).toBeTrue();
    expect(listed.human).toContain("ID");
    expect(listed.human).toContain("EPIC");
    expect(listed.human).toContain("TITLE");

    const shown = await runTask({ cwd, mode: "human", args: ["show", taskId, "--view", "table"] });
    expect(shown.ok).toBeTrue();
    expect(shown.human).toContain("TASK");
    expect(shown.human).toContain("SUBTASKS");
    expect(shown.human).toContain("DESCRIPTION");
  });

  test("default list returns only open statuses and max 10", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    for (let index = 0; index < 9; index += 1) {
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", `Todo ${index}`, "--description", "todo", "--status", "todo"],
      });
    }

    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "In progress", "--description", "active", "--status", "in_progress"],
    });

    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "In-progress", "--description", "active", "--status", "in-progress"],
    });

    for (let index = 0; index < 5; index += 1) {
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", `Done ${index}`, "--description", "done", "--status", "done"],
      });
    }

    const listed = await runTask({ cwd, mode: "human", args: ["list"] });
    expect(listed.ok).toBeTrue();

    const tasks = (listed.data as { tasks: Array<{ status: string }> }).tasks;
    expect(tasks.length).toBe(10);
    expect(tasks.every((task) => task.status === "in_progress" || task.status === "in-progress" || task.status === "todo")).toBeTrue();
  });

  test("default ordering puts in_progress and in-progress before todo", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Todo", "--description", "todo", "--status", "todo"],
    });
    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "In-progress", "--description", "active", "--status", "in-progress"],
    });
    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "In progress", "--description", "active", "--status", "in_progress"],
    });

    const listed = await runTask({ cwd, mode: "human", args: ["list"] });
    expect(listed.ok).toBeTrue();

    const statuses = (listed.data as { tasks: Array<{ status: string }> }).tasks.map((task) => task.status);
    expect(statuses).toEqual(["in-progress", "in_progress", "todo"]);
  });

  test("list uses id tie-break when timestamps match", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const originalNow = Date.now;
    Date.now = (): number => 1_700_000_000_000;

    try {
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", "C", "--description", "desc", "--status", "todo"],
      });
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", "A", "--description", "desc", "--status", "todo"],
      });
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", "B", "--description", "desc", "--status", "todo"],
      });
    } finally {
      Date.now = originalNow;
    }

    const listed = await runTask({ cwd, mode: "toon", args: ["list", "--all"] });
    expect(listed.ok).toBeTrue();

    const ids = (listed.data as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("list --status done returns done items", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Done", "--description", "done", "--status", "done"],
    });
    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Todo", "--description", "todo", "--status", "todo"],
    });

    const listed = await runTask({ cwd, mode: "human", args: ["list", "--status", "done"] });
    expect(listed.ok).toBeTrue();

    const statuses = (listed.data as { tasks: Array<{ status: string }> }).tasks.map((task) => task.status);
    expect(statuses).toEqual(["done"]);
  });

  test("list --all includes done items and bypasses default limit", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    for (let index = 0; index < 12; index += 1) {
      await runTask({
        cwd,
        mode: "human",
        args: [
          "create",
          "--epic",
          epicId,
          "--title",
          `Task ${index}`,
          "--description",
          "desc",
          "--status",
          index % 2 === 0 ? "done" : "todo",
        ],
      });
    }

    const listed = await runTask({ cwd, mode: "human", args: ["list", "--all"] });
    expect(listed.ok).toBeTrue();

    const tasks = (listed.data as { tasks: Array<{ status: string }> }).tasks;
    expect(tasks.length).toBe(12);
    expect(tasks.some((task) => task.status === "done")).toBeTrue();
  });

  test("machine list exposes pagination metadata", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    for (let index = 0; index < 3; index += 1) {
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", `Task ${index}`, "--description", "desc", "--status", "todo"],
      });
    }

    const firstPage = await runTask({ cwd, mode: "toon", args: ["list", "--status", "todo", "--limit", "2"] });
    expect(firstPage.ok).toBeTrue();
    expect(firstPage.meta).toMatchObject({
      pagination: { hasMore: true, nextCursor: "2" },
      defaults: { statuses: null, limit: null, cursor: 0, view: "table" },
      filters: { statuses: ["todo"], includeAll: false },
      truncation: { applied: true, returned: 2, limit: 2 },
    });
    expect((firstPage.data as { tasks: unknown[] }).tasks.length).toBe(2);

    const secondPage = await runTask({
      cwd,
      mode: "toon",
      args: ["list", "--status", "todo", "--limit", "2", "--cursor", "2"],
    });
    expect(secondPage.ok).toBeTrue();
    expect(secondPage.meta).toMatchObject({
      pagination: { hasMore: false, nextCursor: null },
      defaults: { statuses: null, limit: null, cursor: null, view: "table" },
      filters: { statuses: ["todo"], includeAll: false },
      truncation: { applied: false, returned: 1, limit: 2 },
    });
    expect((secondPage.data as { tasks: unknown[] }).tasks.length).toBe(1);
  });

  test("list rejects --all with --status", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runTask({ cwd, mode: "human", args: ["list", "--all", "--status", "done"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("list rejects --all with --limit", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runTask({ cwd, mode: "human", args: ["list", "--all", "--limit", "5"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("list rejects invalid --limit values", async (): Promise<void> => {
    const cwd = createWorkspace();

    const zeroLimit = await runTask({ cwd, mode: "human", args: ["list", "--limit", "0"] });
    expect(zeroLimit.ok).toBeFalse();
    expect(zeroLimit.error?.code).toBe("invalid_input");

    const nonNumericLimit = await runTask({ cwd, mode: "human", args: ["list", "--limit", "abc"] });
    expect(nonNumericLimit.ok).toBeFalse();
    expect(nonNumericLimit.error?.code).toBe("invalid_input");

    const leadingZeroLimit = await runTask({ cwd, mode: "human", args: ["list", "--limit", "01"] });
    expect(leadingZeroLimit.ok).toBeFalse();
    expect(leadingZeroLimit.error?.code).toBe("invalid_input");
  });

  test("errors when value-required task options are missing values", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const taskCreated = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (taskCreated.data as { task: { id: string } }).task.id;

    const missingEpic = await runTask({ cwd, mode: "human", args: ["create", "--epic", "--title", "Implement", "--description", "x"] });
    expect(missingEpic.ok).toBeFalse();
    expect(missingEpic.error?.code).toBe("invalid_input");
    expect((missingEpic.data as { option: string }).option).toBe("epic");

    const missingLimit = await runTask({ cwd, mode: "human", args: ["list", "--limit"] });
    expect(missingLimit.ok).toBeFalse();
    expect(missingLimit.error?.code).toBe("invalid_input");
    expect((missingLimit.data as { option: string }).option).toBe("limit");

    const missingView = await runTask({ cwd, mode: "human", args: ["show", taskId, "--view"] });
    expect(missingView.ok).toBeFalse();
    expect(missingView.error?.code).toBe("invalid_input");
    expect((missingView.data as { option: string }).option).toBe("view");

    const missingIds = await runTask({ cwd, mode: "human", args: ["update", "--ids", "--append", "note"] });
    expect(missingIds.ok).toBeFalse();
    expect(missingIds.error?.code).toBe("invalid_input");
    expect((missingIds.data as { option: string }).option).toBe("ids");
  });

  test("show returns helpful error when id is an epic", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const shown = await runTask({ cwd, mode: "human", args: ["show", epicId] });
    expect(shown.ok).toBeFalse();
    expect(shown.error?.code).toBe("wrong_entity_type");
    expect(shown.human).toContain("trekoon epic show");
  });

  test("task show --all exposes zero subtask count", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const shown = await runTask({ cwd, mode: "toon", args: ["show", taskId, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { subtasksCount: number }).subtasksCount).toBe(0);
  });

  test("bulk update supports --ids with --append and --status", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const first = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement A", "--description", "build it"],
    });
    const second = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement B", "--description", "ship it"],
    });
    const firstId = (first.data as { task: { id: string } }).task.id;
    const secondId = (second.data as { task: { id: string } }).task.id;

    const updated = await runTask({
      cwd,
      mode: "human",
      args: ["update", "--ids", `${firstId},${secondId}`, "--append", "follow policy", "--status", "blocked"],
    });

    expect(updated.ok).toBeTrue();
    expect((updated.data as { ids: string[] }).ids).toEqual([firstId, secondId]);
    const tasks = (updated.data as { tasks: Array<{ description: string; status: string }> }).tasks;
    expect(tasks[0]?.description).toContain("follow policy");
    expect(tasks[1]?.description).toContain("follow policy");
    expect(tasks[0]?.status).toBe("blocked");
    expect(tasks[1]?.status).toBe("blocked");
  });

  test("bulk update rejects --all with --ids", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const created = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    const result = await runTask({
      cwd,
      mode: "human",
      args: ["update", "--all", "--ids", taskId, "--append", "follow policy"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("update <id> --all --status done cascades subtasks with machine metadata", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it", "--status", "todo"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;
    const todoSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Write tests", "--status", "todo"],
    });
    const todoSubtaskId = (todoSubtask.data as { subtask: { id: string } }).subtask.id;
    const doneSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Ship docs", "--status", "done"],
    });
    const doneSubtaskId = (doneSubtask.data as { subtask: { id: string } }).subtask.id;

    const updated = await runTask({ cwd, mode: "toon", args: ["update", taskId, "--all", "--status", "done"] });
    expect(updated.ok).toBeTrue();

    const data = updated.data as {
      task: { status: string };
      cascade: {
        mode: string;
        root: { kind: string; id: string };
        targetStatus: string;
        atomic: boolean;
        changedIds: string[];
        unchangedIds: string[];
        counts: {
          scope: number;
          changed: number;
          unchanged: number;
          changedTasks: number;
          changedSubtasks: number;
        };
      };
    };
    expect(data.task.status).toBe("done");
    expect(data.cascade).toMatchObject({
      mode: "descendants",
      root: { kind: "task", id: taskId },
      targetStatus: "done",
      atomic: true,
      counts: {
        scope: 3,
        changed: 2,
        unchanged: 1,
        changedTasks: 1,
        changedSubtasks: 1,
      },
    });
    expect(data.cascade.changedIds).toEqual(expect.arrayContaining([taskId, todoSubtaskId]));
    expect(data.cascade.unchangedIds).toEqual([doneSubtaskId]);

    const shown = await runTask({ cwd, mode: "toon", args: ["show", taskId] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { task: { status: string; subtasks: Array<{ status: string }> } }).task).toMatchObject({
      status: "done",
      subtasks: [{ status: "done" }, { status: "done" }],
    });
  });

  test("update <id> --all --status todo resets done descendants", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it", "--status", "done"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;
    await runSubtask({ cwd, mode: "toon", args: ["create", "--task", taskId, "--title", "Write tests", "--status", "done"] });
    await runSubtask({ cwd, mode: "toon", args: ["create", "--task", taskId, "--title", "Ship docs", "--status", "done"] });

    const updated = await runTask({ cwd, mode: "toon", args: ["update", taskId, "--all", "--status", "todo"] });
    expect(updated.ok).toBeTrue();
    expect((updated.data as { cascade: { targetStatus: string; counts: { changed: number } } }).cascade).toMatchObject({
      targetStatus: "todo",
      counts: { changed: 3 },
    });

    const shown = await runTask({ cwd, mode: "toon", args: ["show", taskId] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { task: { status: string; subtasks: Array<{ status: string }> } }).task).toMatchObject({
      status: "todo",
      subtasks: [{ status: "todo" }, { status: "todo" }],
    });
  });

  test("update <id> --all rejects non-status cascade fields", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const missingStatus = await runTask({ cwd, mode: "toon", args: ["update", taskId, "--all"] });
    expect(missingStatus.ok).toBeFalse();
    expect(missingStatus.error?.code).toBe("invalid_input");

    const withAppend = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--all", "--status", "done", "--append", "note"],
    });
    expect(withAppend.ok).toBeFalse();
    expect(withAppend.error?.code).toBe("invalid_input");
  });

  test("update <id> --all fails atomically when descendant has external blocker", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const targetTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "build it", "--status", "todo"],
    });
    const taskId = (targetTask.data as { task: { id: string } }).task.id;
    const blockedSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Blocked child", "--status", "todo"],
    });
    const blockedSubtaskId = (blockedSubtask.data as { subtask: { id: string } }).subtask.id;
    const blockerTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "External blocker", "--description", "desc", "--status", "todo"],
    });
    const blockerTaskId = (blockerTask.data as { task: { id: string } }).task.id;
    await runDep({ cwd, mode: "toon", args: ["add", blockedSubtaskId, blockerTaskId] });

    const updated = await runTask({ cwd, mode: "toon", args: ["update", taskId, "--all", "--status", "done"] });
    expect(updated.ok).toBeFalse();
    expect(updated.error?.code).toBe("dependency_blocked");
    expect((updated.data as { atomic: boolean }).atomic).toBeTrue();
    expect((updated.data as { blockedNodeIds: string[] }).blockedNodeIds).toEqual([blockedSubtaskId]);

    const shown = await runTask({ cwd, mode: "toon", args: ["show", taskId] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { task: { status: string; subtasks: Array<{ status: string }> } }).task).toMatchObject({
      status: "todo",
      subtasks: [{ status: "todo" }],
    });
  });

  test("update blocks in_progress/done when dependencies unresolved", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const blockedTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Blocked", "--description", "desc", "--status", "todo"],
    });
    const blockerTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Blocker", "--description", "desc", "--status", "todo"],
    });
    const blockedTaskId = (blockedTask.data as { task: { id: string } }).task.id;
    const blockerTaskId = (blockerTask.data as { task: { id: string } }).task.id;

    await runDep({ cwd, mode: "human", args: ["add", blockedTaskId, blockerTaskId] });

    const inProgress = await runTask({ cwd, mode: "toon", args: ["update", blockedTaskId, "--status", "in_progress"] });
    expect(inProgress.ok).toBeFalse();
    expect(inProgress.error?.code).toBe("dependency_blocked");
    expect((inProgress.data as { unresolvedDependencyCount: number }).unresolvedDependencyCount).toBe(1);
    expect((inProgress.data as { unresolvedDependencyIds: string[] }).unresolvedDependencyIds).toEqual([blockerTaskId]);

    const done = await runTask({ cwd, mode: "toon", args: ["update", blockedTaskId, "--status", "done"] });
    expect(done.ok).toBeFalse();
    expect(done.error?.code).toBe("dependency_blocked");
    expect((done.data as { unresolvedDependencyCount: number }).unresolvedDependencyCount).toBe(1);
    expect((done.data as { unresolvedDependencyIds: string[] }).unresolvedDependencyIds).toEqual([blockerTaskId]);
  });

  test("update allows in_progress once dependencies are done", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const blockedTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Blocked", "--description", "desc", "--status", "todo"],
    });
    const blockerTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Blocker", "--description", "desc", "--status", "todo"],
    });
    const blockedTaskId = (blockedTask.data as { task: { id: string } }).task.id;
    const blockerTaskId = (blockerTask.data as { task: { id: string } }).task.id;

    await runDep({ cwd, mode: "human", args: ["add", blockedTaskId, blockerTaskId] });
    await runTask({ cwd, mode: "human", args: ["update", blockerTaskId, "--status", "done"] });

    const updated = await runTask({ cwd, mode: "toon", args: ["update", blockedTaskId, "--status", "in_progress"] });
    expect(updated.ok).toBeTrue();
    expect((updated.data as { task: { status: string } }).task.status).toBe("in_progress");
  });

  test("ready returns unblocked candidates with blocker summary", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const blockedTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Blocked", "--description", "desc", "--status", "todo"],
    });
    const inProgressTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Active", "--description", "desc", "--status", "in_progress"],
    });
    const todoTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Todo", "--description", "desc", "--status", "todo"],
    });

    const blockedTaskId = (blockedTask.data as { task: { id: string } }).task.id;
    const inProgressTaskId = (inProgressTask.data as { task: { id: string } }).task.id;
    const todoTaskId = (todoTask.data as { task: { id: string } }).task.id;

    const blocker = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", todoTaskId, "--title", "Unfinished blocker", "--description", "desc", "--status", "todo"],
    });
    const blockerId = (blocker.data as { subtask: { id: string } }).subtask.id;

    await runDep({ cwd, mode: "human", args: ["add", blockedTaskId, blockerId] });

    const ready = await runTask({ cwd, mode: "toon", args: ["ready"] });
    expect(ready.ok).toBeTrue();

    const data = ready.data as {
      candidates: Array<{
        task: { id: string };
        readiness: { isReady: boolean; reason: string };
        blockerSummary: { blockedByCount: number; totalDependencies: number };
        ranking: { rank: number; blockerCount: number; statusPriority: number };
      }>;
      blocked: Array<{
        task: { id: string };
        blockerSummary: { blockedByCount: number; blockedBy: Array<{ id: string; kind: string; status: string }> };
      }>;
      summary: {
        totalOpenTasks: number;
        readyCount: number;
        returnedCount: number;
        appliedLimit: number | null;
        blockedCount: number;
        unresolvedDependencyCount: number;
      };
    };

    expect(data.candidates.map((item) => item.task.id)).toEqual([inProgressTaskId, todoTaskId]);
    expect(data.candidates.every((item) => item.readiness.isReady)).toBeTrue();
    expect(data.candidates.every((item) => item.readiness.reason === "all_dependencies_done")).toBeTrue();
    expect(data.candidates.map((item) => item.ranking.rank)).toEqual([1, 2]);
    expect(data.candidates.every((item) => item.ranking.blockerCount === 0)).toBeTrue();
    expect(data.summary).toEqual({
      totalOpenTasks: 3,
      readyCount: 2,
      returnedCount: 2,
      appliedLimit: null,
      blockedCount: 1,
      unresolvedDependencyCount: 1,
    });
    expect(data.blocked.length).toBe(1);
    expect(data.blocked[0]?.task.id).toBe(blockedTaskId);
    expect(data.blocked[0]?.blockerSummary.blockedByCount).toBe(1);
    expect(data.blocked[0]?.blockerSummary.blockedBy[0]).toEqual({ id: blockerId, kind: "subtask", status: "todo" });
  });

  test("ready ordering uses id tie-break for equal ranks", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const originalNow = Date.now;
    Date.now = (): number => 1_700_000_000_000;

    try {
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", "C", "--description", "desc", "--status", "todo"],
      });
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", "A", "--description", "desc", "--status", "todo"],
      });
      await runTask({
        cwd,
        mode: "human",
        args: ["create", "--epic", epicId, "--title", "B", "--description", "desc", "--status", "todo"],
      });
    } finally {
      Date.now = originalNow;
    }

    const ready = await runTask({ cwd, mode: "toon", args: ["ready"] });
    expect(ready.ok).toBeTrue();

    const ids = (ready.data as { candidates: Array<{ task: { id: string } }> }).candidates.map((item) => item.task.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("ready keeps total readyCount when --limit slices candidates", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "A", "--description", "desc", "--status", "in_progress"],
    });
    await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "B", "--description", "desc", "--status", "todo"],
    });

    const ready = await runTask({ cwd, mode: "toon", args: ["ready", "--limit", "1"] });
    expect(ready.ok).toBeTrue();

    const summary = (ready.data as {
      summary: {
        readyCount: number;
        returnedCount: number;
        appliedLimit: number | null;
      };
      candidates: Array<{ task: { id: string } }>;
    }).summary;
    const candidates = (ready.data as { candidates: Array<{ task: { id: string } }> }).candidates;

    expect(candidates.length).toBe(1);
    expect(summary.readyCount).toBe(2);
    expect(summary.returnedCount).toBe(1);
    expect(summary.appliedLimit).toBe(1);
  });

  test("next returns top candidate and null when none are ready", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const first = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "First", "--description", "desc", "--status", "in-progress"],
    });
    const second = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Second", "--description", "desc", "--status", "todo"],
    });
    const firstId = (first.data as { task: { id: string } }).task.id;
    const secondId = (second.data as { task: { id: string } }).task.id;

    const next = await runTask({ cwd, mode: "toon", args: ["next"] });
    expect(next.ok).toBeTrue();
    const nextCandidate = (next.data as { candidate: { task: { id: string } } | null }).candidate;
    expect(nextCandidate?.task.id).toBe(firstId);

    const blockerTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Only blocked", "--description", "desc", "--status", "todo"],
    });
    const blockerTaskId = (blockerTask.data as { task: { id: string } }).task.id;
    const blockerSubtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", secondId, "--title", "Blocker", "--description", "desc", "--status", "todo"],
    });
    const blockerSubtaskId = (blockerSubtask.data as { subtask: { id: string } }).subtask.id;
    await runDep({ cwd, mode: "human", args: ["add", blockerTaskId, blockerSubtaskId] });

    await runTask({ cwd, mode: "human", args: ["update", firstId, "--status", "done"] });
    await runTask({ cwd, mode: "human", args: ["update", secondId, "--status", "done"] });

    const noneReady = await runTask({ cwd, mode: "toon", args: ["next"] });
    expect(noneReady.ok).toBeTrue();
    expect((noneReady.data as { candidate: unknown }).candidate).toBeNull();
    expect((noneReady.data as { summary: { blockedCount: number } }).summary.blockedCount).toBe(1);
  });

  test("done marks task as done and returns next ready task", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const first = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "First", "--description", "do first", "--status", "in_progress"],
    });
    const second = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Second", "--description", "do second", "--status", "todo"],
    });
    const firstId = (first.data as { task: { id: string } }).task.id;
    const secondId = (second.data as { task: { id: string } }).task.id;

    const result = await runTask({ cwd, mode: "toon", args: ["done", firstId] });

    expect(result.ok).toBeTrue();

    const data = result.data as {
      completed: { id: string; status: string };
      next: { id: string } | null;
      nextDeps: unknown[] | null;
      readiness: { readyCount: number; blockedCount: number };
    };

    expect(data.completed.id).toBe(firstId);
    expect(data.completed.status).toBe("done");
    expect(data.next).not.toBeNull();
    expect(data.next?.id).toBe(secondId);
    expect(result.human).toContain("marked done");
  });

  test("done returns null next when no more ready tasks remain", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Only task", "--description", "sole work", "--status", "in_progress"],
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    const result = await runTask({ cwd, mode: "toon", args: ["done", taskId] });

    expect(result.ok).toBeTrue();

    const data = result.data as {
      completed: { id: string; status: string };
      next: unknown;
      readiness: { readyCount: number };
    };

    expect(data.completed.id).toBe(taskId);
    expect(data.completed.status).toBe("done");
    expect(data.next).toBeNull();
    expect(data.readiness.readyCount).toBe(0);
  });

  test("done fails with error on nonexistent task id", async (): Promise<void> => {
    const cwd = createWorkspace();

    const result = await runTask({ cwd, mode: "toon", args: ["done", "00000000-0000-0000-0000-000000000000"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("not_found");
  });

  test("done fails with error when task is already done", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const created = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Already done", "--description", "finished", "--status", "done"],
    });
    const taskId = (created.data as { task: { id: string } }).task.id;

    const result = await runTask({ cwd, mode: "toon", args: ["done", taskId] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("already_done");
  });

  test("search and replace keep task scope boundaries literal", async (): Promise<void> => {
    const cwd = createWorkspace();
    const literalSearch = "$alpha?";
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const targetTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", `Task ${literalSearch}`, "--description", `Task ${literalSearch} desc`],
    });
    const targetTaskId = (targetTask.data as { task: { id: string } }).task.id;

    const siblingTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", `Sibling ${literalSearch}`, "--description", `Sibling ${literalSearch} desc`],
    });
    const siblingTaskId = (siblingTask.data as { task: { id: string } }).task.id;

    const subtaskCreated = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", targetTaskId, "--title", `Subtask ${literalSearch}`, "--description", `Subtask ${literalSearch} desc`],
    });
    const subtaskId = (subtaskCreated.data as { subtask: { id: string } }).subtask.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", siblingTaskId, "--title", `Sibling subtask ${literalSearch}`, "--description", `Sibling subtask ${literalSearch} desc`],
    });

    const search = await runTask({ cwd, mode: "toon", args: ["search", targetTaskId, literalSearch] });
    expect(search.ok).toBeTrue();
    expect((search.data as { scope: { kind: string; id: string } }).scope).toEqual({ kind: "task", id: targetTaskId });
    expect((search.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number } }).summary).toEqual({
      matchedEntities: 2,
      matchedFields: 4,
      totalMatches: 4,
    });
    expect(search.human).toContain(`title(1) "Task ${literalSearch}"`);
    expect(((search.data as { matches: Array<{ fields: Array<{ field: string; snippet: string }> }> }).matches[0]?.fields[0])).toMatchObject({
      field: "title",
      snippet: `Task ${literalSearch}`,
    });
    expect((search.data as { matches: Array<{ id: string }> }).matches.map((match) => match.id)).toEqual([targetTaskId, subtaskId]);

    const preview = await runTask({
      cwd,
      mode: "toon",
      args: ["replace", targetTaskId, "--search", literalSearch, "--replace", "beta", "--fields", "title"],
    });
    expect(preview.ok).toBeTrue();
    expect((preview.data as { query: { search: string; replace: string; fields: string[]; mode: string } }).query).toEqual({
      search: literalSearch,
      replace: "beta",
      fields: ["title"],
      mode: "preview",
    });
    expect((preview.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number; mode: string } }).summary).toEqual({
      matchedEntities: 2,
      matchedFields: 2,
      totalMatches: 2,
      mode: "preview",
    });

    const unchangedPreview = await runTask({ cwd, mode: "toon", args: ["show", targetTaskId, "--all"] });
    expect((unchangedPreview.data as { task: { title: string; subtasks: Array<{ title: string }> } }).task.title).toBe(`Task ${literalSearch}`);
    expect((unchangedPreview.data as { task: { subtasks: Array<{ title: string }> } }).task.subtasks[0]?.title).toBe(`Subtask ${literalSearch}`);

    const noMatch = await runTask({
      cwd,
      mode: "toon",
      args: ["replace", targetTaskId, "--search", "missing literal", "--replace", "beta", "--fields", "title", "--preview"],
    });
    expect(noMatch.ok).toBeTrue();
    expect((noMatch.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number; mode: string } }).summary).toEqual({
      matchedEntities: 0,
      matchedFields: 0,
      totalMatches: 0,
      mode: "preview",
    });
    expect((noMatch.data as { matches: unknown[] }).matches).toEqual([]);

    const applied = await runTask({
      cwd,
      mode: "toon",
      args: ["replace", targetTaskId, "--search", literalSearch, "--replace", "beta", "--fields", "title", "--apply"],
    });
    expect(applied.ok).toBeTrue();
    expect((applied.data as { query: { mode: string } }).query.mode).toBe("apply");
    expect((applied.data as { summary: { mode: string; matchedEntities: number } }).summary).toMatchObject({ mode: "apply", matchedEntities: 2 });
    expect(applied.human).toContain('title(1) "Task beta"');
    expect(applied.human).toContain('title(1) "Subtask beta"');
    expect((applied.data as { matches: Array<{ fields: Array<{ field: string; snippet: string }> }> }).matches.map((match) => match.fields[0]?.snippet)).toEqual([
      "Task beta",
      "Subtask beta",
    ]);

    const updatedTarget = await runTask({ cwd, mode: "toon", args: ["show", targetTaskId, "--all"] });
    const updatedSibling = await runTask({ cwd, mode: "toon", args: ["show", siblingTaskId, "--all"] });
    const targetTree = (updatedTarget.data as {
      task: { title: string; description: string; subtasks: Array<{ title: string; description: string }> };
    }).task;
    const siblingTree = (updatedSibling.data as { task: { title: string; description: string } }).task;
    expect(targetTree.title).toBe("Task beta");
    expect(targetTree.description).toBe(`Task ${literalSearch} desc`);
    expect(targetTree.subtasks[0]?.title).toBe("Subtask beta");
    expect(targetTree.subtasks[0]?.description).toBe(`Subtask ${literalSearch} desc`);
    expect(siblingTree.title).toBe(`Sibling ${literalSearch}`);
    expect(siblingTree.description).toBe(`Sibling ${literalSearch} desc`);
  });
});
