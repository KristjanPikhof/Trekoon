import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { parseArgs, parseCompactFields } from "../../src/commands/arg-parser";
import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { resolveHelpText } from "../../src/commands/help";
import { runSubtask } from "../../src/commands/subtask";
import { runTask } from "../../src/commands/task";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-batch-"));
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

describe("batch grammar contracts", (): void => {
  test("parseArgs preserves repeated valued options in order", (): void => {
    const parsed = parseArgs([
      "create-many",
      "--task",
      "t1|First|Desc one|todo",
      "--task",
      "t2|Second|Desc two|in_progress",
      "--epic",
      "epic-1",
      "--task",
      "t3|Third|Desc three|",
    ]);

    expect(parsed.optionEntries).toEqual([
      { key: "task", value: "t1|First|Desc one|todo" },
      { key: "task", value: "t2|Second|Desc two|in_progress" },
      { key: "epic", value: "epic-1" },
      { key: "task", value: "t3|Third|Desc three|" },
    ]);
    expect(parsed.options.get("task")).toBe("t3|Third|Desc three|");
  });

  test("compact spec parser handles escapes and dangling escapes", (): void => {
    expect(parseCompactFields(String.raw`seed-1|Title \| pipe|Line\\slash\nnext|todo`)).toEqual({
      fields: ["seed-1", "Title | pipe", "Line\\slash\nnext", "todo"],
      invalidEscape: null,
      hasDanglingEscape: false,
    });

    expect(parseCompactFields("seed-1|Title\\")).toEqual({
      fields: ["seed-1"],
      invalidEscape: null,
      hasDanglingEscape: true,
    });
  });

  test("task create-many returns created tasks with compact mapping contract", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const result = await runTask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--epic",
        epicId,
        "--task",
        String.raw`seed-1|Title \| one|Desc\\one|todo`,
        "--task",
        "seed-2|Second|Desc two|",
      ],
    });

    expect(result.ok).toBeTrue();
    expect((result.data as { epicId: string }).epicId).toBe(epicId);
    expect((result.data as { tasks: Array<{ title: string; description: string; status: string }> }).tasks).toMatchObject([
      { title: "Title | one", description: "Desc\\one", status: "todo" },
      { title: "Second", description: "Desc two", status: "todo" },
    ]);
    expect((result.data as { result: { mappings: Array<{ kind: string; tempKey: string; id: string }> } }).result.mappings).toMatchObject([
      { kind: "task", tempKey: "seed-1" },
      { kind: "task", tempKey: "seed-2" },
    ]);
  });

  test("subtask create-many rejects duplicate temp keys before domain work", async (): Promise<void> => {
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
      args: ["create", "--epic", epicId, "--title", "Task", "--description", "desc"],
    });
    const taskId = (taskCreated.data as { task: { id: string } }).task.id;

    const result = await runSubtask({
      cwd,
      mode: "toon",
      args: [
        "create-many",
        "--task",
        taskId,
        "--subtask",
        "seed-1|First|Desc|todo",
        "--subtask",
        "seed-1|Second|Desc|todo",
      ],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
    expect(result.human).toContain("Duplicate temp key");
  });

  test("epic expand creates tasks, subtasks, and dependencies with compact mappings", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "expand",
        epicId,
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
      epicId: string;
      tasks: Array<{ id: string; epicId: string; title: string }>;
      subtasks: Array<{ id: string; taskId: string; title: string }>;
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
      result: {
        mappings: Array<{ kind: string; tempKey: string; id: string }>;
        counts: { tasks: number; subtasks: number; dependencies: number };
      };
    };
    expect(data.epicId).toBe(epicId);
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ epicId, title: "Build parser" });
    expect(data.subtasks).toHaveLength(1);
    expect(data.subtasks[0]).toMatchObject({ taskId: data.tasks[0]?.id, title: "Write tests" });
    expect(data.dependencies[0]).toMatchObject({
      sourceId: data.tasks[0]?.id,
      dependsOnId: data.subtasks[0]?.id,
    });
    expect(data.result.mappings).toEqual([
      { kind: "task", tempKey: "task-1", id: data.tasks[0]?.id ?? "" },
      { kind: "subtask", tempKey: "sub-1", id: data.subtasks[0]?.id ?? "" },
    ]);
    expect(data.result.counts).toEqual({
      tasks: 1,
      subtasks: 1,
      dependencies: 1,
    });
  });

  test("epic create can return epic plus compact graph mapping contract", async (): Promise<void> => {
    const cwd = createWorkspace();

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Roadmap",
        "--description",
        "desc",
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
      tasks: Array<{ id: string; epicId: string }>;
      subtasks: Array<{ id: string; taskId: string }>;
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
      result: {
        mappings: Array<{ kind: string; tempKey: string; id: string }>;
        counts: { tasks: number; subtasks: number; dependencies: number };
      };
    };

    expect(data.epic.title).toBe("Roadmap");
    expect(data.tasks[0]?.epicId).toBe(data.epic.id);
    expect(data.subtasks[0]?.taskId).toBe(data.tasks[0]?.id);
    expect(data.dependencies[0]).toMatchObject({
      sourceId: data.tasks[0]?.id,
      dependsOnId: data.subtasks[0]?.id,
    });
    expect(data.result.mappings).toEqual([
      { kind: "task", tempKey: "task-1", id: data.tasks[0]?.id ?? "" },
      { kind: "subtask", tempKey: "sub-1", id: data.subtasks[0]?.id ?? "" },
    ]);
    expect(data.result.counts).toEqual({ tasks: 1, subtasks: 1, dependencies: 1 });
  });

  test("dep add-many creates ordered dependencies and keeps empty mapping contract", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const sourceTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Source", "--description", "desc"],
    });
    const targetTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Target", "--description", "desc"],
    });
    const subtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", (targetTask.data as { task: { id: string } }).task.id, "--title", "Child"],
    });
    const sourceTaskId = (sourceTask.data as { task: { id: string } }).task.id;
    const targetTaskId = (targetTask.data as { task: { id: string } }).task.id;
    const subtaskId = (subtask.data as { subtask: { id: string } }).subtask.id;

    const result = await runDep({
      cwd,
      mode: "toon",
      args: ["add-many", "--dep", `${sourceTaskId}|${targetTaskId}`, "--dep", `${subtaskId}|${sourceTaskId}`],
    });

    expect(result.ok).toBeTrue();
    expect((result.data as {
      dependencies: Array<{
        sourceId: string;
        dependsOnId: string;
      }>;
    }).dependencies).toMatchObject([
      { sourceId: sourceTaskId, dependsOnId: targetTaskId },
      { sourceId: subtaskId, dependsOnId: sourceTaskId },
    ]);
    expect((result.data as { result: { mappings: unknown[] } }).result.mappings).toEqual([]);
  });

  test("help text distinguishes create-many, expand, and add-many workflows", (): void => {
    const taskHelp = resolveHelpText("task");
    const subtaskHelp = resolveHelpText("subtask");
    const epicHelp = resolveHelpText("epic");
    const depHelp = resolveHelpText("dep");

    expect(taskHelp).toContain("trekoon task create-many --epic <epic-id> --task <spec>");
    expect(taskHelp).not.toContain("grammar only for now");
    expect(subtaskHelp).toContain("trekoon subtask create-many [<task-id>] [--task <task-id>] --subtask <spec>");
    expect(epicHelp).toContain("trekoon epic create --title \"...\" --description \"...\" [--task <spec>] [--subtask <spec>] [--dep <spec>]");
    expect(epicHelp).toContain("trekoon epic expand <epic-id>");
    expect(epicHelp).toContain("@<temp-key>");
    expect(depHelp).toContain("add-many --dep <source-ref>|<depends-on-ref>");
    expect(depHelp).toContain("Uses persisted IDs only");
  });
});
