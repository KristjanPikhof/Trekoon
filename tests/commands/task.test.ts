import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEpic } from "../../src/commands/epic";
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
});
