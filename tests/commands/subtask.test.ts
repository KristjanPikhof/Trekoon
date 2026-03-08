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

  test("default list returns only open statuses and max 10", async (): Promise<void> => {
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

    for (let index = 0; index < 9; index += 1) {
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", `Todo ${index}`, "--status", "todo"],
      });
    }

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "In progress", "--status", "in_progress"],
    });

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "In-progress", "--status", "in-progress"],
    });

    for (let index = 0; index < 5; index += 1) {
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", `Done ${index}`, "--status", "done"],
      });
    }

    const listed = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId] });
    expect(listed.ok).toBeTrue();

    const subtasks = (listed.data as { subtasks: Array<{ status: string }> }).subtasks;
    expect(subtasks.length).toBe(10);
    expect(subtasks.every((subtask) => subtask.status === "in_progress" || subtask.status === "in-progress" || subtask.status === "todo")).toBeTrue();
  });

  test("list --status done returns done items", async (): Promise<void> => {
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

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Done", "--status", "done"],
    });
    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Todo", "--status", "todo"],
    });

    const listed = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId, "--status", "done"] });
    expect(listed.ok).toBeTrue();

    const statuses = (listed.data as { subtasks: Array<{ status: string }> }).subtasks.map((subtask) => subtask.status);
    expect(statuses).toEqual(["done"]);
  });

  test("list uses id tie-break when timestamps match", async (): Promise<void> => {
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
    const originalNow = Date.now;
    Date.now = (): number => 1_700_000_000_000;

    try {
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", "C", "--status", "todo"],
      });
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", "A", "--status", "todo"],
      });
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", "B", "--status", "todo"],
      });
    } finally {
      Date.now = originalNow;
    }

    const listed = await runSubtask({ cwd, mode: "toon", args: ["list", "--task", taskId, "--all"] });
    expect(listed.ok).toBeTrue();

    const ids = (listed.data as { subtasks: Array<{ id: string }> }).subtasks.map((subtask) => subtask.id);
    expect(ids).toEqual([...ids].sort());
  });

  test("list --all includes done items and bypasses default limit", async (): Promise<void> => {
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

    for (let index = 0; index < 12; index += 1) {
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", `Subtask ${index}`, "--status", index % 2 === 0 ? "done" : "todo"],
      });
    }

    const listed = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId, "--all"] });
    expect(listed.ok).toBeTrue();

    const subtasks = (listed.data as { subtasks: Array<{ status: string }> }).subtasks;
    expect(subtasks.length).toBe(12);
    expect(subtasks.some((subtask) => subtask.status === "done")).toBeTrue();
  });

  test("machine list exposes pagination metadata", async (): Promise<void> => {
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

    for (let index = 0; index < 3; index += 1) {
      await runSubtask({
        cwd,
        mode: "human",
        args: ["create", "--task", taskId, "--title", `Subtask ${index}`, "--status", "todo"],
      });
    }

    const firstPage = await runSubtask({
      cwd,
      mode: "toon",
      args: ["list", "--task", taskId, "--status", "todo", "--limit", "2"],
    });
    expect(firstPage.ok).toBeTrue();
    expect(firstPage.meta).toMatchObject({
      pagination: { hasMore: true, nextCursor: "2" },
      defaults: { statuses: null, limit: null, cursor: 0, view: "table" },
      filters: { taskId, statuses: ["todo"], includeAll: false },
      truncation: { applied: true, returned: 2, limit: 2 },
    });
    expect((firstPage.data as { subtasks: unknown[] }).subtasks.length).toBe(2);

    const secondPage = await runSubtask({
      cwd,
      mode: "toon",
      args: ["list", "--task", taskId, "--status", "todo", "--limit", "2", "--cursor", "2"],
    });
    expect(secondPage.ok).toBeTrue();
    expect(secondPage.meta).toMatchObject({
      pagination: { hasMore: false, nextCursor: null },
      defaults: { statuses: null, limit: null, cursor: null, view: "table" },
      filters: { taskId, statuses: ["todo"], includeAll: false },
      truncation: { applied: false, returned: 1, limit: 2 },
    });
    expect((secondPage.data as { subtasks: unknown[] }).subtasks.length).toBe(1);
  });

  test("list rejects --all with --status", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runSubtask({ cwd, mode: "human", args: ["list", "--all", "--status", "done"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("list rejects --all with --limit", async (): Promise<void> => {
    const cwd = createWorkspace();
    const result = await runSubtask({ cwd, mode: "human", args: ["list", "--all", "--limit", "5"] });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("list rejects invalid --limit values", async (): Promise<void> => {
    const cwd = createWorkspace();

    const zeroLimit = await runSubtask({ cwd, mode: "human", args: ["list", "--limit", "0"] });
    expect(zeroLimit.ok).toBeFalse();
    expect(zeroLimit.error?.code).toBe("invalid_input");

    const nonNumericLimit = await runSubtask({ cwd, mode: "human", args: ["list", "--limit", "abc"] });
    expect(nonNumericLimit.ok).toBeFalse();
    expect(nonNumericLimit.error?.code).toBe("invalid_input");

    const leadingZeroLimit = await runSubtask({ cwd, mode: "human", args: ["list", "--limit", "01"] });
    expect(leadingZeroLimit.ok).toBeFalse();
    expect(leadingZeroLimit.error?.code).toBe("invalid_input");
  });

  test("errors when value-required subtask options are missing values", async (): Promise<void> => {
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

    const missingTask = await runSubtask({ cwd, mode: "human", args: ["create", "--task", "--title", "A subtask"] });
    expect(missingTask.ok).toBeFalse();
    expect(missingTask.error?.code).toBe("invalid_input");
    expect((missingTask.data as { option: string }).option).toBe("task");

    const missingView = await runSubtask({ cwd, mode: "human", args: ["list", "--task", taskId, "--view"] });
    expect(missingView.ok).toBeFalse();
    expect(missingView.error?.code).toBe("invalid_input");
    expect((missingView.data as { option: string }).option).toBe("view");

    const missingIds = await runSubtask({ cwd, mode: "human", args: ["update", "--ids", "--append", "note"] });
    expect(missingIds.ok).toBeFalse();
    expect(missingIds.error?.code).toBe("invalid_input");
    expect((missingIds.data as { option: string }).option).toBe("ids");
  });

  test("bulk update supports --ids with --append and --status", async (): Promise<void> => {
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

    const first = await runSubtask({ cwd, mode: "human", args: ["create", "--task", taskId, "--title", "A subtask"] });
    const second = await runSubtask({ cwd, mode: "human", args: ["create", "--task", taskId, "--title", "B subtask"] });
    const firstId = (first.data as { subtask: { id: string } }).subtask.id;
    const secondId = (second.data as { subtask: { id: string } }).subtask.id;

    const updated = await runSubtask({
      cwd,
      mode: "human",
      args: ["update", "--ids", `${firstId},${secondId}`, "--append", "follow policy", "--status", "blocked"],
    });

    expect(updated.ok).toBeTrue();
    expect((updated.data as { ids: string[] }).ids).toEqual([firstId, secondId]);
    const subtasks = (updated.data as { subtasks: Array<{ description: string; status: string }> }).subtasks;
    expect(subtasks[0]?.description).toContain("follow policy");
    expect(subtasks[1]?.description).toContain("follow policy");
    expect(subtasks[0]?.status).toBe("blocked");
    expect(subtasks[1]?.status).toBe("blocked");
  });

  test("bulk update rejects --all with --ids", async (): Promise<void> => {
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

    const result = await runSubtask({
      cwd,
      mode: "human",
      args: ["update", "--all", "--ids", subtaskId, "--append", "follow policy"],
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("update blocks in_progress/done when dependencies unresolved", async (): Promise<void> => {
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

    const blockedSubtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Blocked subtask", "--status", "todo"],
    });
    const blockerSubtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Blocker subtask", "--status", "todo"],
    });
    const blockedSubtaskId = (blockedSubtask.data as { subtask: { id: string } }).subtask.id;
    const blockerSubtaskId = (blockerSubtask.data as { subtask: { id: string } }).subtask.id;

    await runDep({ cwd, mode: "human", args: ["add", blockedSubtaskId, blockerSubtaskId] });

    const inProgress = await runSubtask({
      cwd,
      mode: "toon",
      args: ["update", blockedSubtaskId, "--status", "in_progress"],
    });
    expect(inProgress.ok).toBeFalse();
    expect(inProgress.error?.code).toBe("dependency_blocked");
    expect((inProgress.data as { unresolvedDependencyCount: number }).unresolvedDependencyCount).toBe(1);
    expect((inProgress.data as { unresolvedDependencyIds: string[] }).unresolvedDependencyIds).toEqual([blockerSubtaskId]);

    const done = await runSubtask({ cwd, mode: "toon", args: ["update", blockedSubtaskId, "--status", "done"] });
    expect(done.ok).toBeFalse();
    expect(done.error?.code).toBe("dependency_blocked");
    expect((done.data as { unresolvedDependencyCount: number }).unresolvedDependencyCount).toBe(1);
    expect((done.data as { unresolvedDependencyIds: string[] }).unresolvedDependencyIds).toEqual([blockerSubtaskId]);
  });

  test("update allows done once dependencies are done", async (): Promise<void> => {
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

    const blockedSubtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Blocked subtask", "--status", "todo"],
    });
    const blockerSubtask = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", "Blocker subtask", "--status", "todo"],
    });
    const blockedSubtaskId = (blockedSubtask.data as { subtask: { id: string } }).subtask.id;
    const blockerSubtaskId = (blockerSubtask.data as { subtask: { id: string } }).subtask.id;

    await runDep({ cwd, mode: "human", args: ["add", blockedSubtaskId, blockerSubtaskId] });
    await runSubtask({ cwd, mode: "human", args: ["update", blockerSubtaskId, "--status", "done"] });

    const updated = await runSubtask({ cwd, mode: "toon", args: ["update", blockedSubtaskId, "--status", "done"] });
    expect(updated.ok).toBeTrue();
    expect((updated.data as { subtask: { status: string } }).subtask.status).toBe("done");
  });

  test("search and replace keep subtask literals and no-match stable", async (): Promise<void> => {
    const cwd = createWorkspace();
    const literalSearch = "(alpha)+?";
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
    const subtaskCreated = await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", `Subtask ${literalSearch}`, "--description", `Desc ${literalSearch}`],
    });
    const subtaskId = (subtaskCreated.data as { subtask: { id: string } }).subtask.id;

    await runSubtask({
      cwd,
      mode: "human",
      args: ["create", "--task", taskId, "--title", `Sibling ${literalSearch}`, "--description", `Sibling ${literalSearch}`],
    });

    const search = await runSubtask({ cwd, mode: "toon", args: ["search", subtaskId, literalSearch] });
    expect(search.ok).toBeTrue();
    expect((search.data as { scope: { kind: string; id: string } }).scope).toEqual({ kind: "subtask", id: subtaskId });
    expect((search.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number } }).summary).toEqual({
      matchedEntities: 1,
      matchedFields: 2,
      totalMatches: 2,
    });
    expect(search.human).toContain(`title(1) "Subtask ${literalSearch}"`);
    expect(((search.data as { matches: Array<{ fields: Array<{ field: string; snippet: string }> }> }).matches[0]?.fields[1])).toMatchObject({
      field: "description",
      snippet: `Desc ${literalSearch}`,
    });

    const invalidMode = await runSubtask({
      cwd,
      mode: "toon",
      args: ["replace", subtaskId, "--search", literalSearch, "--replace", "beta", "--preview", "--apply"],
    });
    expect(invalidMode.ok).toBeFalse();
    expect(invalidMode.error?.code).toBe("invalid_input");

    const preview = await runSubtask({
      cwd,
      mode: "toon",
      args: ["replace", subtaskId, "--search", literalSearch, "--replace", "beta", "--fields", "title"],
    });
    expect(preview.ok).toBeTrue();
    expect((preview.data as { query: { search: string; replace: string; fields: string[]; mode: string } }).query).toEqual({
      search: literalSearch,
      replace: "beta",
      fields: ["title"],
      mode: "preview",
    });
    expect((preview.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number; mode: string } }).summary).toEqual({
      matchedEntities: 1,
      matchedFields: 1,
      totalMatches: 1,
      mode: "preview",
    });

    const noMatch = await runSubtask({
      cwd,
      mode: "toon",
      args: ["replace", subtaskId, "--search", "missing literal", "--replace", "beta", "--fields", "title", "--preview"],
    });
    expect(noMatch.ok).toBeTrue();
    expect((noMatch.data as { summary: { matchedEntities: number; matchedFields: number; totalMatches: number; mode: string } }).summary).toEqual({
      matchedEntities: 0,
      matchedFields: 0,
      totalMatches: 0,
      mode: "preview",
    });
    expect((noMatch.data as { matches: unknown[] }).matches).toEqual([]);

    const applied = await runSubtask({
      cwd,
      mode: "toon",
      args: ["replace", subtaskId, "--search", literalSearch, "--replace", "beta", "--fields", "title", "--apply"],
    });
    expect(applied.ok).toBeTrue();
    expect((applied.data as { query: { mode: string } }).query.mode).toBe("apply");
    expect(applied.human).toContain('title(1) "Subtask beta"');
    expect(((applied.data as { matches: Array<{ fields: Array<{ field: string; snippet: string }> }> }).matches[0]?.fields[0])).toMatchObject({
      field: "title",
      snippet: "Subtask beta",
    });

    const updated = await runSubtask({ cwd, mode: "toon", args: ["list", "--task", taskId, "--all"] });
    const updatedSubtask = (updated.data as { subtasks: Array<{ title: string; description: string }> }).subtasks[0];
    const siblingSubtask = (updated.data as { subtasks: Array<{ title: string; description: string }> }).subtasks[1];
    expect(updatedSubtask?.title).toBe("Subtask beta");
    expect(updatedSubtask?.description).toBe(`Desc ${literalSearch}`);
    expect(siblingSubtask?.title).toBe(`Sibling ${literalSearch}`);
    expect(siblingSubtask?.description).toBe(`Sibling ${literalSearch}`);
  });
});
