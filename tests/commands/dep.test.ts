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
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-dep-"));
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

async function createTaskGraph(cwd: string): Promise<{ epicId: string; taskA: string; taskB: string; subtask: string }> {
  const epic = await runEpic({
    cwd,
    mode: "human",
    args: ["create", "--title", "Roadmap", "--description", "desc"],
  });
  const epicId = (epic.data as { epic: { id: string } }).epic.id;

  const taskA = await runTask({
    cwd,
    mode: "human",
    args: ["create", "--epic", epicId, "--title", "Task A", "--description", "desc a"],
  });
  const taskAId = (taskA.data as { task: { id: string } }).task.id;

  const taskB = await runTask({
    cwd,
    mode: "human",
    args: ["create", "--epic", epicId, "--title", "Task B", "--description", "desc b"],
  });
  const taskBId = (taskB.data as { task: { id: string } }).task.id;

  const subtask = await runSubtask({
    cwd,
    mode: "human",
    args: ["create", "--task", taskBId, "--title", "Subtask"],
  });

  return {
    epicId,
    taskA: taskAId,
    taskB: taskBId,
    subtask: (subtask.data as { subtask: { id: string } }).subtask.id,
  };
}

describe("dep command", (): void => {
  test("supports add/list/remove", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const added = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.subtask] });
    expect(added.ok).toBeTrue();

    const listed = await runDep({ cwd, mode: "human", args: ["list", nodes.taskA] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { dependencies: unknown[] }).dependencies.length).toBe(1);

    const removed = await runDep({ cwd, mode: "human", args: ["remove", nodes.taskA, nodes.subtask] });
    expect(removed.ok).toBeTrue();
    expect((removed.data as { removed: number }).removed).toBe(1);
  });

  test("enforces referential checks for task/subtask nodes", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const bad = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, "missing-node-id"] });
    expect(bad.ok).toBeFalse();
    expect(bad.error?.code).toBe("not_found");
  });

  test("detects dependency cycles", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const first = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(first.ok).toBeTrue();

    const cycle = await runDep({ cwd, mode: "human", args: ["add", nodes.taskB, nodes.taskA] });
    expect(cycle.ok).toBeFalse();
    expect(cycle.error?.code).toBe("invalid_dependency");
  });

  test("detects transitive cycles across task and subtask", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const first = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(first.ok).toBeTrue();

    const second = await runDep({ cwd, mode: "human", args: ["add", nodes.taskB, nodes.subtask] });
    expect(second.ok).toBeTrue();

    const cycle = await runDep({ cwd, mode: "human", args: ["add", nodes.subtask, nodes.taskA] });
    expect(cycle.ok).toBeFalse();
    expect(cycle.error?.code).toBe("invalid_dependency");
  });

  test("returns reverse dependents with distance metadata", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const first = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(first.ok).toBeTrue();

    const second = await runDep({ cwd, mode: "human", args: ["add", nodes.taskB, nodes.subtask] });
    expect(second.ok).toBeTrue();

    const reverse = await runDep({ cwd, mode: "human", args: ["reverse", nodes.subtask] });
    expect(reverse.ok).toBeTrue();

    const data = reverse.data as {
      targetId: string;
      targetKind: string;
      blockedNodes: Array<{ id: string; kind: string; distance: number; isDirect: boolean }>;
    };
    expect(data.targetId).toBe(nodes.subtask);
    expect(data.targetKind).toBe("subtask");
    expect(data.blockedNodes.map((node) => [node.id, node.distance, node.isDirect])).toEqual([
      [nodes.taskB, 1, true],
      [nodes.taskA, 2, false],
    ]);
  });

  test("returns reverse direct dependents in deterministic order", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const taskC = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", nodes.epicId, "--title", "Task C", "--description", "desc c"],
    });
    expect(taskC.ok).toBeTrue();
    const taskCId = (taskC.data as { task: { id: string } }).task.id;

    const first = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.subtask] });
    expect(first.ok).toBeTrue();

    const second = await runDep({ cwd, mode: "human", args: ["add", taskCId, nodes.subtask] });
    expect(second.ok).toBeTrue();

    const reverse = await runDep({ cwd, mode: "human", args: ["reverse", nodes.subtask] });
    expect(reverse.ok).toBeTrue();

    const data = reverse.data as {
      blockedNodes: Array<{ id: string; kind: string; distance: number; isDirect: boolean }>;
    };

    const returnedIds = data.blockedNodes.map((node) => node.id);
    const sortedIds = [...returnedIds].sort((a, b) => a.localeCompare(b));
    expect(returnedIds).toEqual(sortedIds);
    expect(data.blockedNodes.every((node) => node.kind === "task")).toBeTrue();
    expect(data.blockedNodes.every((node) => node.distance === 1)).toBeTrue();
    expect(data.blockedNodes.every((node) => node.isDirect)).toBeTrue();
  });

  test("returns clear error for unknown reverse target id", async (): Promise<void> => {
    const cwd = createWorkspace();
    await createTaskGraph(cwd);

    const reverse = await runDep({ cwd, mode: "human", args: ["reverse", "missing-node-id"] });
    expect(reverse.ok).toBeFalse();
    expect(reverse.error?.code).toBe("not_found");
    expect((reverse.data as { id: string }).id).toBe("missing-node-id");
  });
});
