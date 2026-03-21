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
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-epic-"));
  tempDirs.push(workspace);
  return workspace;
}

async function createEpic(
  cwd: string,
  input: { title: string; description: string; status?: string },
): Promise<{ id: string; status: string; title: string }> {
  const args = ["create", "--title", input.title, "--description", input.description];
  if (input.status !== undefined) {
    args.push("--status", input.status);
  }

  const result = await runEpic({
    cwd,
    mode: "human",
    args,
  });

  expect(result.ok).toBeTrue();
  return (result.data as { epic: { id: string; status: string; title: string } }).epic;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("epic command", (): void => {
  test("requires description on create", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("creates uuid epic with default status", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });

    expect(result.ok).toBeTrue();
    const epic = (result.data as { epic: { id: string; status: string } }).epic;
    expect(epic.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(epic.status).toBe("todo");
  });

  test("create accepts task, subtask, and dep specs in one invocation", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Roadmap",
        "--description",
        "Top-level work",
        "--task",
        "task-1|Build parser|Parser desc|todo",
        "--subtask",
        "@task-1|sub-1|Write tests|Test desc|todo",
        "--dep",
        "@task-1|@sub-1",
      ],
    });

    expect(result.ok).toBeTrue();
    const data = result.data as {
      epic: { id: string; title: string };
      tasks: Array<{ id: string; epicId: string; title: string }>;
      subtasks: Array<{ id: string; taskId: string; title: string }>;
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
      result: {
        mappings: Array<{ kind: string; tempKey: string; id: string }>;
        counts: { tasks: number; subtasks: number; dependencies: number };
      };
    };

    expect(data.epic.title).toBe("Roadmap");
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ epicId: data.epic.id, title: "Build parser" });
    expect(data.subtasks).toHaveLength(1);
    expect(data.subtasks[0]).toMatchObject({ taskId: data.tasks[0]?.id, title: "Write tests" });
    expect(data.dependencies).toMatchObject([
      { sourceId: data.tasks[0]?.id, dependsOnId: data.subtasks[0]?.id },
    ]);
    expect(data.result.mappings).toEqual([
      { kind: "task", tempKey: "task-1", id: data.tasks[0]?.id ?? "" },
      { kind: "subtask", tempKey: "sub-1", id: data.subtasks[0]?.id ?? "" },
    ]);
    expect(data.result.counts).toEqual({ tasks: 1, subtasks: 1, dependencies: 1 });
  });

  test("create rolls back epic when temp-key refs are invalid", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Roadmap",
        "--description",
        "Top-level work",
        "--task",
        "task-1|Build parser|Parser desc|todo",
        "--dep",
        "@task-1|@missing-subtask",
      ],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
    expect(result.human).toContain("Unknown temp key @missing-subtask");

    const listed = await runEpic({ cwd, mode: "toon", args: ["list", "--all"] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { epics: unknown[] }).epics).toEqual([]);
  });

  test("epic show returns aggregate tree", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work", "--status", "backlog"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Task desc"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Write tests"],
    });

    const show = await runEpic({ cwd, mode: "toon", args: ["show", epicId, "--all"] });

    expect(show.ok).toBeTrue();
    const tree = (
      show.data as {
        tree: {
          id: string;
          status: string;
          description: string;
          tasks: Array<{ description: string; subtasks: Array<{ description: string }> }>;
        };
      }
    ).tree;
    expect(tree.id).toBe(epicId);
    expect(tree.status).toBe("backlog");
    expect(tree.description).toBe("Top-level work");
    expect(tree.tasks.length).toBe(1);
    expect(tree.tasks[0]?.subtasks.length).toBe(1);
    expect(tree.tasks[0]?.description).toBe("Task desc");
    expect(tree.tasks[0]?.subtasks[0]?.description).toBe("");
  });

  test("list defaults to table and supports compact view", async (): Promise<void> => {
    const cwd = createWorkspace();
    await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });

    const listedDefault = await runEpic({ cwd, mode: "human", args: ["list"] });
    expect(listedDefault.ok).toBeTrue();
    expect(listedDefault.human).toContain("ID");
    expect(listedDefault.human).toContain("TITLE");
    expect(listedDefault.human).toContain("STATUS");

    const listedCompact = await runEpic({ cwd, mode: "human", args: ["list", "--view", "compact"] });
    expect(listedCompact.ok).toBeTrue();
    expect(listedCompact.human).not.toContain("ID | TITLE | STATUS");
    expect(listedCompact.human).toContain("Roadmap");
  });

  test("expand rejects unknown temp keys without persisting partial mutations", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epic = await createEpic(cwd, { title: "Roadmap", description: "Top-level work" });

    const expanded = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "expand",
        epic.id,
        "--task",
        "task-1|Build parser|Parser desc|todo",
        "--subtask",
        "@missing-task|sub-1|Write tests|Test desc|todo",
      ],
    });

    expect(expanded.ok).toBeFalse();
    expect(expanded.error?.code).toBe("invalid_input");
    expect(expanded.human).toContain("Unknown temp key @missing-task");

    const shown = await runEpic({ cwd, mode: "toon", args: ["show", epic.id, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { tree: { tasks: unknown[] } }).tree.tasks).toEqual([]);
  });

  test("expand rejects dependency cycles without persisting partial mutations", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epic = await createEpic(cwd, { title: "Roadmap", description: "Top-level work" });

    const expanded = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "expand",
        epic.id,
        "--task",
        "task-1|Task A|Desc A|todo",
        "--task",
        "task-2|Task B|Desc B|todo",
        "--dep",
        "@task-1|@task-2",
        "--dep",
        "@task-2|@task-1",
      ],
    });

    expect(expanded.ok).toBeFalse();
    expect(expanded.error?.code).toBe("invalid_dependency");
    expect((expanded.data as { issues: Array<{ index: number; type: string }> }).issues).toMatchObject([
      { index: 1, type: "cycle" },
    ]);

    const shown = await runEpic({ cwd, mode: "toon", args: ["show", epic.id, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { tree: { tasks: unknown[] } }).tree.tasks).toEqual([]);
  });

  test("expand rejects unexpected positional args before parsing specs", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epic = await createEpic(cwd, { title: "Roadmap", description: "Top-level work" });

    const expanded = await runEpic({
      cwd,
      mode: "toon",
      args: ["expand", epic.id, "extra", "--task", "task-1|Build parser|Parser desc|todo"],
    });

    expect(expanded.ok).toBeFalse();
    expect(expanded.error?.code).toBe("invalid_input");
    expect(expanded.human).toContain("Unexpected positional arguments: extra.");
  });

  test("show defaults to table and handles empty task tree", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const shown = await runEpic({ cwd, mode: "human", args: ["show", epicId] });
    expect(shown.ok).toBeTrue();
    expect(shown.human).toContain("EPIC");
    expect(shown.human).toContain("TASKS");
    expect(shown.human).toContain("No tasks found.");
  });

  test("show compact and tree views are distinct", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Task desc"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Write tests"],
    });

    const compact = await runEpic({ cwd, mode: "human", args: ["show", epicId, "--view", "compact"] });
    const tree = await runEpic({ cwd, mode: "human", args: ["show", epicId, "--view", "tree"] });

    expect(compact.ok).toBeTrue();
    expect(tree.ok).toBeTrue();
    expect(compact.human).toContain("Roadmap");
    expect(compact.human).not.toContain("task ");
    expect(tree.human).toContain("Roadmap");
    expect(tree.human).toContain("task ");
    expect(tree.human).not.toBe(compact.human);
  });

  test("bulk update supports --all with --append and --status", async (): Promise<void> => {
    const cwd = createWorkspace();
    await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Release", "--description", "Ship candidate"],
    });

    const updated = await runEpic({
      cwd,
      mode: "human",
      args: ["update", "--all", "--append", "follow policy", "--status", "in_progress"],
    });

    expect(updated.ok).toBeTrue();
    const epics = (updated.data as { epics: Array<{ description: string; status: string }> }).epics;
    expect(epics.length).toBe(2);
    expect(epics[0]?.description).toContain("follow policy");
    expect(epics[1]?.description).toContain("follow policy");
    expect(epics[0]?.status).toBe("in_progress");
    expect(epics[1]?.status).toBe("in_progress");
  });

  test("bulk update rejects title field", async (): Promise<void> => {
    const cwd = createWorkspace();
    await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });

    const result = await runEpic({
      cwd,
      mode: "human",
      args: ["update", "--all", "--title", "Renamed", "--append", "follow policy"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("update <id> --all --status done cascades descendants with machine metadata", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const todoTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Build it", "--status", "todo"],
    });
    const todoTaskId = (todoTask.data as { task: { id: string } }).task.id;
    const todoSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", todoTaskId, "--title", "Write tests", "--status", "todo"],
    });
    const todoSubtaskId = (todoSubtask.data as { subtask: { id: string } }).subtask.id;

    const doneTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Ship", "--description", "Release it", "--status", "done"],
    });
    const doneTaskId = (doneTask.data as { task: { id: string } }).task.id;
    const doneSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", doneTaskId, "--title", "Announce", "--status", "done"],
    });
    const doneSubtaskId = (doneSubtask.data as { subtask: { id: string } }).subtask.id;

    const updated = await runEpic({ cwd, mode: "toon", args: ["update", epicId, "--all", "--status", "done"] });
    expect(updated.ok).toBeTrue();

    const data = updated.data as {
      epic: { status: string };
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
          changedEpics: number;
          changedTasks: number;
          changedSubtasks: number;
        };
      };
    };
    expect(data.epic.status).toBe("done");
    expect(data.cascade).toMatchObject({
      mode: "descendants",
      root: { kind: "epic", id: epicId },
      targetStatus: "done",
      atomic: true,
      counts: {
        scope: 5,
        changed: 3,
        unchanged: 2,
        changedEpics: 1,
        changedTasks: 1,
        changedSubtasks: 1,
      },
    });
    expect(data.cascade.changedIds).toEqual(expect.arrayContaining([epicId, todoTaskId, todoSubtaskId]));
    expect(data.cascade.unchangedIds).toEqual(expect.arrayContaining([doneTaskId, doneSubtaskId]));

    const shown = await runEpic({ cwd, mode: "toon", args: ["show", epicId, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { tree: { status: string } }).tree.status).toBe("done");
    expect((shown.data as { tree: { tasks: Array<{ status: string; subtasks: Array<{ status: string }> }> } }).tree.tasks).toMatchObject([
      { status: "done", subtasks: [{ status: "done" }] },
      { status: "done", subtasks: [{ status: "done" }] },
    ]);
  });

  test("update <id> --all --status done honors subtask dependency on its parent task", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Implement", "--description", "Build it", "--status", "todo"],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;
    const createdSubtask = await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", taskId, "--title", "Release", "--status", "todo"],
    });
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;
    const dependency = await runDep({ cwd, mode: "toon", args: ["add", subtaskId, taskId] });
    expect(dependency.ok).toBeTrue();

    const updated = await runEpic({ cwd, mode: "toon", args: ["update", epicId, "--all", "--status", "done"] });
    expect(updated.ok).toBeTrue();
    const changedIds = (updated.data as { cascade: { changedIds: string[] } }).cascade.changedIds;
    expect(changedIds).toEqual(expect.arrayContaining([epicId, taskId, subtaskId]));
    expect(changedIds.indexOf(taskId)).toBeLessThan(changedIds.indexOf(subtaskId));

    const shown = await runEpic({ cwd, mode: "toon", args: ["show", epicId, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { tree: { status: string; tasks: Array<{ id: string; status: string; subtasks: Array<{ id: string; status: string }> }> } }).tree)
      .toMatchObject({
        status: "done",
        tasks: [{ id: taskId, status: "done", subtasks: [{ id: subtaskId, status: "done" }] }],
      });
  });

  test("update <id> --all rejects non-status cascade fields", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const missingStatus = await runEpic({ cwd, mode: "toon", args: ["update", epicId, "--all"] });
    expect(missingStatus.ok).toBeFalse();
    expect(missingStatus.error?.code).toBe("invalid_input");

    const withAppend = await runEpic({
      cwd,
      mode: "toon",
      args: ["update", epicId, "--all", "--status", "done", "--append", "note"],
    });
    expect(withAppend.ok).toBeFalse();
    expect(withAppend.error?.code).toBe("invalid_input");
  });

  test("update <id> --all fails atomically when descendant has external blocker", async (): Promise<void> => {
    const cwd = createWorkspace();
    const targetEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const targetEpicId = (targetEpic.data as { epic: { id: string } }).epic.id;
    const externalEpic = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "External", "--description", "External work"],
    });
    const externalEpicId = (externalEpic.data as { epic: { id: string } }).epic.id;

    const targetTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", targetEpicId, "--title", "Blocked task", "--description", "desc", "--status", "todo"],
    });
    const targetTaskId = (targetTask.data as { task: { id: string } }).task.id;
    await runSubtask({
      cwd,
      mode: "toon",
      args: ["create", "--task", targetTaskId, "--title", "Child work", "--status", "todo"],
    });

    const blockerTask = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", externalEpicId, "--title", "External blocker", "--description", "desc", "--status", "todo"],
    });
    const blockerTaskId = (blockerTask.data as { task: { id: string } }).task.id;
    await runDep({ cwd, mode: "toon", args: ["add", targetTaskId, blockerTaskId] });

    const updated = await runEpic({ cwd, mode: "toon", args: ["update", targetEpicId, "--all", "--status", "done"] });
    expect(updated.ok).toBeFalse();
    expect(updated.error?.code).toBe("dependency_blocked");
    expect((updated.data as { atomic: boolean }).atomic).toBeTrue();
    expect((updated.data as { blockedNodeIds: string[] }).blockedNodeIds).toEqual([targetTaskId]);

    const shown = await runEpic({ cwd, mode: "toon", args: ["show", targetEpicId, "--all"] });
    expect(shown.ok).toBeTrue();
    expect((shown.data as { tree: { status: string; tasks: Array<{ status: string; subtasks: Array<{ status: string }> }> } }).tree).toMatchObject({
      status: "todo",
      tasks: [{ status: "todo", subtasks: [{ status: "todo" }] }],
    });
  });

  test("default list includes only open statuses and max 10", async (): Promise<void> => {
    const cwd = createWorkspace();

    for (let index = 0; index < 7; index += 1) {
      await createEpic(cwd, {
        title: `In progress ${index}`,
        description: "Top-level work",
        status: "in_progress",
      });
    }

    for (let index = 0; index < 7; index += 1) {
      await createEpic(cwd, {
        title: `Done ${index}`,
        description: "Top-level work",
        status: "done",
      });
    }

    const listed = await runEpic({ cwd, mode: "human", args: ["list"] });
    expect(listed.ok).toBeTrue();

    const epics = (listed.data as { epics: Array<{ status: string }> }).epics;
    expect(epics.length).toBe(7);
    expect(epics.every((epic) => ["in_progress", "todo"].includes(epic.status))).toBeTrue();

    for (let index = 0; index < 5; index += 1) {
      await createEpic(cwd, {
        title: `Todo ${index}`,
        description: "Top-level work",
        status: "todo",
      });
    }

    const listedLimited = await runEpic({ cwd, mode: "human", args: ["list"] });
    expect(listedLimited.ok).toBeTrue();
    const limitedEpics = (listedLimited.data as { epics: Array<{ status: string }> }).epics;
    expect(limitedEpics.length).toBe(10);
    expect(limitedEpics.every((epic) => ["in_progress", "todo"].includes(epic.status))).toBeTrue();
  });

  test("default ordering puts in_progress before todo", async (): Promise<void> => {
    const cwd = createWorkspace();
    await createEpic(cwd, { title: "Todo", description: "Top-level work", status: "todo" });
    await createEpic(cwd, { title: "In progress 1", description: "Top-level work", status: "in_progress" });
    await createEpic(cwd, { title: "In progress 2", description: "Top-level work", status: "in_progress" });

    const listed = await runEpic({ cwd, mode: "human", args: ["list"] });
    expect(listed.ok).toBeTrue();

    const statuses = (listed.data as { epics: Array<{ status: string }> }).epics.map((epic) => epic.status);
    const todoIndex = statuses.indexOf("todo");
    const inProgressIndex = statuses.findIndex((status) => status === "in_progress");

    expect(inProgressIndex).toBeGreaterThanOrEqual(0);
    expect(todoIndex).toBeGreaterThanOrEqual(0);
    expect(inProgressIndex).toBeLessThan(todoIndex);
  });

  test("list uses id tie-break when timestamps match", async (): Promise<void> => {
    const cwd = createWorkspace();
    const originalNow = Date.now;
    Date.now = (): number => 1_700_000_000_000;

    try {
      await createEpic(cwd, { title: "C", description: "Top-level work", status: "todo" });
      await createEpic(cwd, { title: "A", description: "Top-level work", status: "todo" });
      await createEpic(cwd, { title: "B", description: "Top-level work", status: "todo" });
    } finally {
      Date.now = originalNow;
    }

    const listed = await runEpic({ cwd, mode: "toon", args: ["list", "--all"] });
    expect(listed.ok).toBeTrue();

    const ids = (listed.data as { epics: Array<{ id: string }> }).epics.map((epic) => epic.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("--status done returns only done", async (): Promise<void> => {
    const cwd = createWorkspace();
    await createEpic(cwd, { title: "Done", description: "Top-level work", status: "done" });
    await createEpic(cwd, { title: "Todo", description: "Top-level work", status: "todo" });

    const listed = await runEpic({ cwd, mode: "human", args: ["list", "--status", "done"] });
    expect(listed.ok).toBeTrue();

    const epics = (listed.data as { epics: Array<{ status: string }> }).epics;
    expect(epics.length).toBe(1);
    expect(epics[0]?.status).toBe("done");
  });

  test("short list aliases apply status filtering and limits", async (): Promise<void> => {
    const cwd = createWorkspace();
    await createEpic(cwd, { title: "Done 1", description: "Top-level work", status: "done" });
    await createEpic(cwd, { title: "Done 2", description: "Top-level work", status: "done" });
    await createEpic(cwd, { title: "Todo", description: "Top-level work", status: "todo" });

    const listed = await runEpic({ cwd, mode: "toon", args: ["list", "--s", "done", "--l", "1"] });
    expect(listed.ok).toBeTrue();
    expect((listed.data as { epics: Array<{ status: string }> }).epics).toMatchObject([{ status: "done" }]);
    expect((listed.data as { epics: unknown[] }).epics).toHaveLength(1);
  });

  test("--all includes done and bypasses limit", async (): Promise<void> => {
    const cwd = createWorkspace();

    for (let index = 0; index < 12; index += 1) {
      await createEpic(cwd, {
        title: `Done ${index}`,
        description: "Top-level work",
        status: "done",
      });
    }

    const listed = await runEpic({ cwd, mode: "human", args: ["list", "--all"] });
    expect(listed.ok).toBeTrue();

    const epics = (listed.data as { epics: Array<{ status: string }> }).epics;
    expect(epics.length).toBe(12);
    expect(epics.some((epic) => epic.status === "done")).toBeTrue();
  });

  test("machine list exposes pagination metadata", async (): Promise<void> => {
    const cwd = createWorkspace();

    for (let index = 0; index < 3; index += 1) {
      await createEpic(cwd, {
        title: `Todo ${index}`,
        description: "Top-level work",
        status: "todo",
      });
    }

    const firstPage = await runEpic({ cwd, mode: "toon", args: ["list", "--status", "todo", "--limit", "2"] });
    expect(firstPage.ok).toBeTrue();
    expect(firstPage.meta).toMatchObject({
      pagination: { hasMore: true, nextCursor: "2" },
      defaults: { statuses: null, limit: null, cursor: 0, view: "table" },
      filters: { statuses: ["todo"], includeAll: false },
      truncation: { applied: true, returned: 2, limit: 2 },
    });
    expect((firstPage.data as { epics: unknown[] }).epics.length).toBe(2);

    const secondPage = await runEpic({
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
    expect((secondPage.data as { epics: unknown[] }).epics.length).toBe(1);
  });

  test("rejects --all with --status", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({ cwd, mode: "human", args: ["list", "--all", "--status", "done"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("rejects --all with short status alias", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({ cwd, mode: "human", args: ["list", "--all", "--s", "done"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("rejects --all with --limit", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({ cwd, mode: "human", args: ["list", "--all", "--limit", "5"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("rejects invalid --limit", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runEpic({ cwd, mode: "human", args: ["list", "--limit", "0"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("rejects strict edge-case --limit values", async (): Promise<void> => {
    const cwd = createWorkspace();
    const leadingZero = await runEpic({ cwd, mode: "human", args: ["list", "--limit", "01"] });

    expect(leadingZero.ok).toBeFalse();
    expect(leadingZero.error?.code).toBe("invalid_input");
  });

  test("errors when value-required epic options are missing values", async (): Promise<void> => {
    const cwd = createWorkspace();
    const createdEpic = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "Top-level work"],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const missingStatus = await runEpic({ cwd, mode: "human", args: ["list", "--status"] });
    expect(missingStatus.ok).toBeFalse();
    expect(missingStatus.error?.code).toBe("invalid_input");
    expect((missingStatus.data as { option: string }).option).toBe("status");

    const missingView = await runEpic({ cwd, mode: "human", args: ["show", epicId, "--view"] });
    expect(missingView.ok).toBeFalse();
    expect(missingView.error?.code).toBe("invalid_input");
    expect((missingView.data as { option: string }).option).toBe("view");

    const missingAppend = await runEpic({ cwd, mode: "human", args: ["update", epicId, "--append"] });
    expect(missingAppend.ok).toBeFalse();
    expect(missingAppend.error?.code).toBe("invalid_input");
    expect((missingAppend.data as { option: string }).option).toBe("append");
  });

  test("search and replace keep literal scope boundaries stable", async (): Promise<void> => {
    const cwd = createWorkspace();
    const literalSearch = "[alpha].*";
    const createdEpic = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", `Roadmap ${literalSearch}`, "--description", `Epic ${literalSearch} desc`],
    });
    const epicId = (createdEpic.data as { epic: { id: string } }).epic.id;

    const createdTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", `Task ${literalSearch}`, "--description", `Task ${literalSearch} desc`],
    });
    const taskId = (createdTask.data as { task: { id: string } }).task.id;

    const createdSubtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", `Subtask ${literalSearch}`, "--description", `Subtask ${literalSearch} desc`],
    });
    const subtaskId = (createdSubtask.data as { subtask: { id: string } }).subtask.id;

    const outsideEpic = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", `Outside ${literalSearch}`, "--description", `Outside ${literalSearch} desc`],
    });
    const outsideEpicId = (outsideEpic.data as { epic: { id: string } }).epic.id;

    const outsideTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", outsideEpicId, "--title", `Sibling ${literalSearch}`, "--description", `Sibling ${literalSearch} desc`],
    });
    const outsideTaskId = (outsideTask.data as { task: { id: string } }).task.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", outsideTaskId, "--title", `Outside subtask ${literalSearch}`, "--description", `Outside subtask ${literalSearch} desc`],
    });

    const search = await runEpic({ cwd, mode: "toon", args: ["search", epicId, literalSearch] });
    expect(search.ok).toBeTrue();
    expect((search.data as { scope: { kind: string; id: string } }).scope).toEqual({ kind: "epic", id: epicId });
    expect((search.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number } }).summary).toEqual({
      matchedEntities: 3,
      matchedFields: 6,
      totalMatches: 6,
    });
    expect(search.human).toContain(`title(1) "Roadmap ${literalSearch}"`);
    expect(search.human).toContain(`description(1) "Epic ${literalSearch} desc"`);
    expect((search.data as { matches: Array<{ kind: string; id: string }> }).matches.map((match) => match.id)).toEqual([
      epicId,
      taskId,
      subtaskId,
    ]);

    const preview = await runEpic({
      cwd,
      mode: "toon",
      args: ["replace", epicId, "--search", literalSearch, "--replace", "beta"],
    });
    expect(preview.ok).toBeTrue();
    expect((preview.data as { query: { search: string; replace: string; fields: string[]; mode: string } }).query).toEqual({
      search: literalSearch,
      replace: "beta",
      fields: ["title", "description"],
      mode: "preview",
    });
    expect((preview.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number; mode: string } }).summary).toEqual({
      matchedEntities: 3,
      matchedFields: 6,
      totalMatches: 6,
      mode: "preview",
    });

    const unchanged = await runEpic({ cwd, mode: "toon", args: ["show", epicId, "--all"] });
    expect((unchanged.data as { tree: { title: string } }).tree.title).toBe(`Roadmap ${literalSearch}`);

    const noMatch = await runEpic({
      cwd,
      mode: "toon",
      args: ["replace", epicId, "--search", "missing literal", "--replace", "beta", "--preview"],
    });
    expect(noMatch.ok).toBeTrue();
    expect((noMatch.data as { query: { mode: string } }).query.mode).toBe("preview");
    expect((noMatch.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number; mode: string } }).summary).toEqual({
      matchedEntities: 0,
      matchedFields: 0,
      totalMatches: 0,
      mode: "preview",
    });
    expect((noMatch.data as { matches: unknown[] }).matches).toEqual([]);

    const applied = await runEpic({
      cwd,
      mode: "toon",
      args: ["replace", epicId, "--search", literalSearch, "--replace", "beta", "--apply"],
    });
    expect(applied.ok).toBeTrue();
    expect((applied.data as { query: { mode: string } }).query.mode).toBe("apply");
    expect((applied.data as { summary: { mode: string; matchedEntities: number } }).summary).toMatchObject({ mode: "apply", matchedEntities: 3 });
    expect(applied.human).toContain('title(1) "Roadmap beta"');
    expect(applied.human).toContain('description(1) "Epic beta desc"');
    expect((applied.data as { matches: Array<{ fields: Array<{ field: string; count: number; snippet: string }> }> }).matches[0]?.fields).toEqual([
      { field: "title", count: 1, snippet: "Roadmap beta" },
      { field: "description", count: 1, snippet: "Epic beta desc" },
    ]);

    const updated = await runEpic({ cwd, mode: "toon", args: ["show", epicId, "--all"] });
    const outsideUnchanged = await runEpic({ cwd, mode: "toon", args: ["show", outsideEpicId, "--all"] });
    const tree = (updated.data as {
      tree: { title: string; description: string; tasks: Array<{ title: string; description: string; subtasks: Array<{ title: string; description: string }> }> };
    }).tree;
    const outsideTree = (outsideUnchanged.data as {
      tree: { title: string; description: string; tasks: Array<{ title: string; description: string; subtasks: Array<{ title: string; description: string }> }> };
    }).tree;
    expect(tree.title).toBe("Roadmap beta");
    expect(tree.description).toBe("Epic beta desc");
    expect(tree.tasks[0]?.title).toBe("Task beta");
    expect(tree.tasks[0]?.description).toBe("Task beta desc");
    expect(tree.tasks[0]?.subtasks[0]?.title).toBe("Subtask beta");
    expect(tree.tasks[0]?.subtasks[0]?.description).toBe("Subtask beta desc");
    expect(outsideTree.title).toBe(`Outside ${literalSearch}`);
    expect(outsideTree.description).toBe(`Outside ${literalSearch} desc`);
    expect(outsideTree.tasks[0]?.title).toBe(`Sibling ${literalSearch}`);
    expect(outsideTree.tasks[0]?.description).toBe(`Sibling ${literalSearch} desc`);
    expect(outsideTree.tasks[0]?.subtasks[0]?.title).toBe(`Outside subtask ${literalSearch}`);
    expect(outsideTree.tasks[0]?.subtasks[0]?.description).toBe(`Outside subtask ${literalSearch} desc`);
  });
});
