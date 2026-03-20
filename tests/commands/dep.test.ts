import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";
import { executeShell, parseInvocation } from "../../src/runtime/cli-shell";

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

  test("cli dep add-many works after task create-many with --toon", async (): Promise<void> => {
    const cwd = createWorkspace();

    const initResult = await executeShell(parseInvocation(["init", "--title", "Temp Repo"]), cwd);
    expect(initResult.ok).toBeTrue();

    const epicCreated = await executeShell(
      parseInvocation(["epic", "create", "--title", "Roadmap", "--description", "desc", "--toon"]),
      cwd,
    );
    expect(epicCreated.ok).toBeTrue();
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const taskBatch = await executeShell(
      parseInvocation([
        "task",
        "create-many",
        "--epic",
        epicId,
        "--task",
        "seed-1|First|Desc one|todo",
        "--task",
        "seed-2|Second|Desc two|todo",
        "--toon",
      ]),
      cwd,
    );
    expect(taskBatch.ok).toBeTrue();
    const tasks = (taskBatch.data as { tasks: Array<{ id: string }> }).tasks;

    const added = await executeShell(
      parseInvocation(["dep", "add-many", "--dep", `${tasks[1]?.id}|${tasks[0]?.id}`, "--toon"]),
      cwd,
    );

    expect(added.ok).toBeTrue();
    expect((added.data as { dependencies: Array<{ sourceId: string; dependsOnId: string }> }).dependencies).toMatchObject([
      { sourceId: tasks[1]?.id, dependsOnId: tasks[0]?.id },
    ]);
  });

  test("add-many adds dependencies in declared order", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const added = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", "--dep", `${nodes.taskA}|${nodes.taskB}`, "--dep", `${nodes.subtask}|${nodes.taskA}`],
    });

    expect(added.ok).toBeTrue();
    expect((added.data as { dependencies: Array<{ sourceId: string; dependsOnId: string }> }).dependencies).toMatchObject([
      { sourceId: nodes.taskA, dependsOnId: nodes.taskB },
      { sourceId: nodes.subtask, dependsOnId: nodes.taskA },
    ]);
  });

  test("add-many reports deterministic duplicate and cycle issues without partial inserts", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const existing = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(existing.ok).toBeTrue();

    const added = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", "--dep", `${nodes.taskA}|${nodes.taskB}`, "--dep", `${nodes.taskB}|${nodes.taskA}`],
    });

    expect(added.ok).toBeFalse();
    expect(added.error?.code).toBe("invalid_dependency");
    expect((added.data as { issues: Array<{ index: number; type: string; sourceId: string; dependsOnId: string }> }).issues).toMatchObject([
      { index: 0, type: "duplicate", sourceId: nodes.taskA, dependsOnId: nodes.taskB },
      { index: 1, type: "cycle", sourceId: nodes.taskB, dependsOnId: nodes.taskA },
    ]);

    const listA = await runDep({ cwd, mode: "toon", args: ["list", nodes.taskA] });
    const listB = await runDep({ cwd, mode: "toon", args: ["list", nodes.taskB] });
    expect((listA.data as { dependencies: Array<{ sourceId: string; dependsOnId: string }> }).dependencies).toMatchObject([
      { sourceId: nodes.taskA, dependsOnId: nodes.taskB },
    ]);
    expect((listB.data as { dependencies: unknown[] }).dependencies).toEqual([]);
  });

  test("add-many reports missing ids deterministically", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const added = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", "--dep", `${nodes.taskA}|missing-node-id`],
    });

    expect(added.ok).toBeFalse();
    expect(added.error?.code).toBe("invalid_dependency");
    expect((added.data as { firstIssue: { type: string }; issues: Array<{ index: number; type: string; details: { id: string } }> }).firstIssue.type).toBe("missing_id");
    expect((added.data as { issues: Array<{ index: number; type: string; details: { id: string } }> }).issues).toMatchObject([
      { index: 0, type: "missing_id", details: { id: "missing-node-id" } },
    ]);
  });

  test("add-many rejects unresolved temp keys without inserting dependencies", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const added = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", "--dep", `@seed-task|${nodes.taskA}`, "--dep", `${nodes.taskB}|@seed-subtask`],
    });

    expect(added.ok).toBeFalse();
    expect(added.error?.code).toBe("invalid_dependency");
    expect((added.data as {
      issues: Array<{ index: number; type: string; sourceId: string; dependsOnId: string; details: { tempKey: string; field: string } }>;
    }).issues).toMatchObject([
      { index: 0, type: "missing_id", sourceId: "@seed-task", dependsOnId: "", details: { tempKey: "seed-task", field: "source" } },
      { index: 1, type: "missing_id", sourceId: "", dependsOnId: "@seed-subtask", details: { tempKey: "seed-subtask", field: "dependsOn" } },
    ]);

    const listA = await runDep({ cwd, mode: "toon", args: ["list", nodes.taskA] });
    const listB = await runDep({ cwd, mode: "toon", args: ["list", nodes.taskB] });
    expect((listA.data as { dependencies: unknown[] }).dependencies).toEqual([]);
    expect((listB.data as { dependencies: unknown[] }).dependencies).toEqual([]);
  });

  test("add-many rejects unexpected positional args", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const added = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", nodes.taskA, "--dep", `${nodes.taskA}|${nodes.taskB}`],
    });

    expect(added.ok).toBeFalse();
    expect(added.error?.code).toBe("invalid_input");
    expect(added.human).toContain(`Unexpected positional arguments: ${nodes.taskA}.`);
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

  test("duplicate dependency edge is handled idempotently", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const first = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(first.ok).toBeTrue();

    const second = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(second.ok).toBeTrue();

    const listed = await runDep({ cwd, mode: "human", args: ["list", nodes.taskA] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { dependencies: unknown[] }).dependencies.length).toBe(1);
  });

  test("orphaned dependency rows do not crash traversal after task delete", async (): Promise<void> => {
    const cwd = createWorkspace();
    const nodes = await createTaskGraph(cwd);

    const added = await runDep({ cwd, mode: "human", args: ["add", nodes.taskA, nodes.taskB] });
    expect(added.ok).toBeTrue();

    // Delete the depended-on task; CASCADE deletes the task but the dependency
    // row may reference an orphaned id depending on schema (our migration cleans
    // them, but the domain traversal must also handle this gracefully).
    const deleted = await runTask({ cwd, mode: "human", args: ["delete", nodes.taskB] });
    expect(deleted.ok).toBeTrue();

    // Listing dependencies on taskA should not throw even if the dependency row
    // referenced a now-deleted node (the domain should skip missing nodes).
    const listed = await runDep({ cwd, mode: "human", args: ["list", nodes.taskA] });
    expect(listed.ok).toBeTrue();
    const deps = (listed.data as { dependencies: Array<{ sourceId: string; dependsOnId: string }> }).dependencies;
    // The orphaned dependency row persists (no FK on depends_on_id) but
    // listing must not crash.  Verify the returned list is well-formed.
    for (const dep of deps) {
      expect(typeof dep.sourceId).toBe("string");
      expect(typeof dep.dependsOnId).toBe("string");
    }
  });
});
