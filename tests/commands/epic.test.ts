import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

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
      args: ["update", "--all", "--append", "follow policy", "--status", "in-progress"],
    });

    expect(updated.ok).toBeTrue();
    const epics = (updated.data as { epics: Array<{ description: string; status: string }> }).epics;
    expect(epics.length).toBe(2);
    expect(epics[0]?.description).toContain("follow policy");
    expect(epics[1]?.description).toContain("follow policy");
    expect(epics[0]?.status).toBe("in-progress");
    expect(epics[1]?.status).toBe("in-progress");
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
    expect(epics.every((epic) => ["in_progress", "in-progress", "todo"].includes(epic.status))).toBeTrue();

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
    expect(limitedEpics.every((epic) => ["in_progress", "in-progress", "todo"].includes(epic.status))).toBeTrue();
  });

  test("default ordering puts in-progress before todo", async (): Promise<void> => {
    const cwd = createWorkspace();
    await createEpic(cwd, { title: "Todo", description: "Top-level work", status: "todo" });
    await createEpic(cwd, { title: "In progress hyphen", description: "Top-level work", status: "in-progress" });
    await createEpic(cwd, { title: "In progress underscore", description: "Top-level work", status: "in_progress" });

    const listed = await runEpic({ cwd, mode: "human", args: ["list"] });
    expect(listed.ok).toBeTrue();

    const statuses = (listed.data as { epics: Array<{ status: string }> }).epics.map((epic) => epic.status);
    const todoIndex = statuses.indexOf("todo");
    const inProgressIndex = statuses.findIndex((status) => status === "in_progress" || status === "in-progress");

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
});
