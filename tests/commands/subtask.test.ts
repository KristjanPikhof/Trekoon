import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEpic } from "../../src/commands/epic";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-subtask-"));
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

describe("subtask command", (): void => {
  test("description is optional on create", async (): Promise<void> => {
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
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "task desc"],
    });
    const taskId = (taskCreated.data as { task: { id: string } }).task.id;

    const created = await runSubtask({ cwd, mode: "human", args: ["create", "--task", taskId, "--title", "A subtask"] });
    expect(created.ok).toBeTrue();
    expect((created.data as { subtask: { description: string; status: string } }).subtask.description).toBe("");
    expect((created.data as { subtask: { status: string } }).subtask.status).toBe("todo");
  });

  test("supports list/update/delete", async (): Promise<void> => {
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
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "task desc"],
    });
    const taskId = (taskCreated.data as { task: { id: string } }).task.id;

    const created = await runSubtask({ cwd, mode: "human", args: ["create", "--task", taskId, "--title", "A subtask"] });
    const subtaskId = (created.data as { subtask: { id: string } }).subtask.id;

    const listed = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { subtasks: unknown[] }).subtasks.length).toBe(1);

    const updated = await runSubtask({ cwd, mode: "human", args: ["update", subtaskId, "--status", "doing"] });
    expect(updated.ok).toBeTrue();
    expect((updated.data as { subtask: { status: string } }).subtask.status).toBe("doing");

    const removed = await runSubtask({ cwd, mode: "human", args: ["delete", subtaskId] });
    expect(removed.ok).toBeTrue();
  });

  test("list defaults to table and supports compact view", async (): Promise<void> => {
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
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "task desc"],
    });
    const taskId = (taskCreated.data as { task: { id: string } }).task.id;

    await runSubtask({ cwd, mode: "human", args: ["create", "--task", taskId, "--title", "A subtask"] });

    const listedDefault = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId] });
    expect(listedDefault.ok).toBeTrue();
    expect(listedDefault.human).toContain("ID");
    expect(listedDefault.human).toContain("TASK");

    const listedCompact = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId, "--view", "compact"] });
    expect(listedCompact.ok).toBeTrue();
    expect(listedCompact.human).toContain("task=");
  });
});
