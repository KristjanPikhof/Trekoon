import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { normalizeOptionAliases, parseArgs, parseCompactFields } from "../../src/commands/arg-parser";
import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { resolveHelpText } from "../../src/commands/help";
import { runQuickstart } from "../../src/commands/quickstart";
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

  test("option alias normalization rewrites parser surfaces to canonical keys", (): void => {
    const parsed = parseArgs([
      "create",
      "--desc",
      "Roadmap desc",
      "--deps",
      "task-2|task-1",
      "--dependency",
      "task-3|task-2",
      "--description",
    ]);

    const result = normalizeOptionAliases(parsed, [
      { canonical: "description", aliases: ["desc"] },
      { canonical: "dep", aliases: ["deps", "dependency"], multiple: true },
    ]);

    expect(result.conflict).toBeUndefined();
    expect(result.parsed.options.get("description")).toBe("Roadmap desc");
    expect(result.parsed.options.get("dep")).toBe("task-3|task-2");
    expect(result.parsed.optionEntries).toEqual([
      { key: "description", value: "Roadmap desc" },
      { key: "dep", value: "task-2|task-1" },
      { key: "dep", value: "task-3|task-2" },
    ]);
    expect(result.parsed.missingOptionValues.has("description")).toBeTrue();
    expect(result.parsed.flags.has("description")).toBeTrue();
    expect(result.parsed.providedOptions).toEqual(["description", "dep", "dep", "description"]);
  });

  test("option alias normalization reports single-value conflicts", (): void => {
    const parsed = parseArgs(["create", "--description", "Canonical", "--desc", "Alias"]);

    const result = normalizeOptionAliases(parsed, [
      { canonical: "description", aliases: ["desc"] },
    ]);

    expect(result.conflict).toEqual({
      canonical: "description",
      keys: ["description", "desc"],
    });
    expect(result.parsed).toBe(parsed);
  });

  test("option alias normalization preserves repeated canonical last-value behavior", (): void => {
    const parsed = parseArgs(["create", "--description", "First", "--description", "Second"]);

    const result = normalizeOptionAliases(parsed, [
      { canonical: "description", aliases: ["desc"] },
    ]);

    expect(result.conflict).toBeUndefined();
    expect(result.parsed.options.get("description")).toBe("Second");
    expect(result.parsed.optionEntries).toEqual([
      { key: "description", value: "First" },
      { key: "description", value: "Second" },
    ]);
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

  test("epic expand accepts dependency aliases", async (): Promise<void> => {
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
        "--task",
        "task-2|Wire parser|Wire desc|todo",
        "--dependancy",
        "@task-2|@task-1",
      ],
    });

    expect(result.ok).toBeTrue();
    expect((result.data as {
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
    }).dependencies).toHaveLength(1);
  });

  test("epic expand explains unprefixed subtask parent temp-key refs", async (): Promise<void> => {
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
        "task-1|sub-1|Write tests|Test desc|todo",
      ],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
    expect(result.human).toContain("Unprefixed temp key 'task-1'");
    expect(result.human).toContain("Use @task-1 instead");
  });

  test("epic expand explains unprefixed dependency temp-key refs", async (): Promise<void> => {
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
        "task-1|@sub-1",
      ],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
    expect(result.human).toContain("Unprefixed temp key 'task-1'");
    expect(result.human).toContain("Use @task-1 instead");
  });

  test("epic expand keeps real persisted ids valid beside temp-key refs", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const existingTask = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "Existing", "--description", "desc"],
    });
    const existingTaskId = (existingTask.data as { task: { id: string } }).task.id;

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "expand",
        epicId,
        "--task",
        "task-1|Build parser|Parser desc|todo",
        "--dep",
        `@task-1|${existingTaskId}`,
      ],
    });

    expect(result.ok).toBeTrue();
    expect((result.data as {
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
    }).dependencies).toMatchObject([
      { dependsOnId: existingTaskId },
    ]);
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

  test("epic create accepts description and dependency aliases without changing result shape", async (): Promise<void> => {
    const cwd = createWorkspace();

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Roadmap",
        "--desc",
        "desc",
        "--task",
        "task-1|Build parser|Parser desc|todo",
        "--subtask",
        "@task-1|sub-1|Write tests|Test desc|todo",
        "--deps",
        "@task-1|@sub-1",
      ],
    });

    expect(result.ok).toBeTrue();
    const data = result.data as {
      epic: { description: string };
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
    };
    expect(data.epic.description).toBe("desc");
    expect(data.dependencies).toHaveLength(1);
  });

  test("epic create rejects conflicting description aliases", async (): Promise<void> => {
    const cwd = createWorkspace();

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "canonical", "--desc", "alias"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
    expect(result.human).toContain("Conflicting values for --description");
  });

  test("unknown option suggestions and allowed options stay canonical", async (): Promise<void> => {
    const cwd = createWorkspace();

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--descc", "alias typo"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("unknown_option");
    const data = result.data as { allowedOptions: string[]; suggestions: string[] };
    expect(data.allowedOptions).toContain("--description");
    expect(data.allowedOptions).not.toContain("--desc");
    expect(data.suggestions).not.toContain("--desc");
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

  test("dep add-many accepts dependency aliases in input order", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicCreated = await runEpic({
      cwd,
      mode: "human",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;
    const taskA = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "A", "--description", "desc"],
    });
    const taskB = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "B", "--description", "desc"],
    });
    const taskC = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "C", "--description", "desc"],
    });
    const taskD = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "D", "--description", "desc"],
    });
    const taskE = await runTask({
      cwd,
      mode: "human",
      args: ["create", "--epic", epicId, "--title", "E", "--description", "desc"],
    });
    const taskAId = (taskA.data as { task: { id: string } }).task.id;
    const taskBId = (taskB.data as { task: { id: string } }).task.id;
    const taskCId = (taskC.data as { task: { id: string } }).task.id;
    const taskDId = (taskD.data as { task: { id: string } }).task.id;
    const taskEId = (taskE.data as { task: { id: string } }).task.id;

    const result = await runDep({
      cwd,
      mode: "toon",
      args: [
        "add-many",
        "--dependency",
        `${taskBId}|${taskAId}`,
        "--dependencies",
        `${taskCId}|${taskBId}`,
        "--dependancy",
        `${taskDId}|${taskCId}`,
        "--dependancies",
        `${taskEId}|${taskDId}`,
      ],
    });

    expect(result.ok).toBeTrue();
    expect((result.data as {
      dependencies: Array<{ sourceId: string; dependsOnId: string }>;
    }).dependencies).toMatchObject([
      { sourceId: taskBId, dependsOnId: taskAId },
      { sourceId: taskCId, dependsOnId: taskBId },
      { sourceId: taskDId, dependsOnId: taskCId },
      { sourceId: taskEId, dependsOnId: taskDId },
    ]);
  });

  test("help text distinguishes create-many, expand, and add-many workflows", (): void => {
    const taskHelp = resolveHelpText("task");
    const subtaskHelp = resolveHelpText("subtask");
    const epicHelp = resolveHelpText("epic");
    const depHelp = resolveHelpText("dep");

    expect(taskHelp).toContain("trekoon task create-many --epic <epic-id> --task <spec>");
    expect(taskHelp).not.toContain("grammar only for now");
    expect(subtaskHelp).toContain("trekoon subtask create-many [<task-id>] [--task <task-id>] --subtask <spec>");
    expect(epicHelp).toContain("trekoon --toon epic create --title \"...\" --description \"...\" [--task <spec>] [--subtask <spec>] [--dep <spec>]");
    expect(epicHelp).toContain("trekoon --toon epic expand <epic-id>");
    expect(epicHelp).toContain("@<temp-key>");
    expect(depHelp).toContain("add-many --dep <source-ref>|<depends-on-ref>");
    expect(depHelp).toContain("Uses persisted IDs only");
  });

  test("help and quickstart examples keep canonical option names", async (): Promise<void> => {
    const aliasPattern = /--(?:desc|deps|dependency|dependencies|dependancy|dependancies)\b/u;
    const helpExamples = ["epic", "task", "subtask", "dep"]
      .flatMap((topic) => resolveHelpText(topic).split("\n"))
      .filter((line) => line.trimStart().startsWith("trekoon "));
    expect(helpExamples).not.toEqual([]);
    expect(helpExamples.some((line) => aliasPattern.test(line))).toBeFalse();

    const quickstart = await runQuickstart({ cwd: createWorkspace(), mode: "toon", args: [] });
    expect(quickstart.ok).toBeTrue();
    const data = quickstart.data as {
      powerUserCommands: string[];
      machineExamples: string[];
    };
    expect(data.powerUserCommands.some((line) => aliasPattern.test(line))).toBeFalse();
    expect(data.machineExamples.some((line) => aliasPattern.test(line))).toBeFalse();

    const quickstartExamples = quickstart.human
      .split("\n")
      .filter((line) => line.trimStart().startsWith("trekoon "));
    expect(quickstartExamples.some((line) => aliasPattern.test(line))).toBeFalse();
  });
});
