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
});
