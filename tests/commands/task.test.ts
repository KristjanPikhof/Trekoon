import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

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
});
