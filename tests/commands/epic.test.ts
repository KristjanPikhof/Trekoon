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
});
