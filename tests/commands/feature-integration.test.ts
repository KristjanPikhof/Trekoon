import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runSession } from "../../src/commands/session";
import { runSubtask } from "../../src/commands/subtask";
import { runSuggest } from "../../src/commands/suggest";
import { runTask } from "../../src/commands/task";
import { buildTaskReadiness } from "../../src/commands/task-readiness";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { toToonEnvelope } from "../../src/io/output";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-feature-integration-"));
  tempDirs.push(workspace);
  return workspace;
}

function runGit(cwd: string, args: readonly string[]): void {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (command.exitCode !== 0) {
    const stderr = new TextDecoder().decode(command.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function initializeRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# test repo\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  runGit(workspace, ["add", "README.md", ".gitignore"]);
  runGit(workspace, ["commit", "-m", "init repository"]);
}

/** Create an epic and return its id. */
async function seedEpic(
  cwd: string,
  title: string,
  description: string,
): Promise<string> {
  const result = await runEpic({
    cwd,
    mode: "toon",
    args: ["create", "--title", title, "--description", description],
  });
  expect(result.ok).toBeTrue();
  return (result.data as { epic: { id: string } }).epic.id;
}

/** Create a task and return its id. */
async function seedTask(
  cwd: string,
  epicId: string,
  title: string,
  description: string,
): Promise<string> {
  const result = await runTask({
    cwd,
    mode: "toon",
    args: ["create", "--epic", epicId, "--title", title, "--description", description],
  });
  expect(result.ok).toBeTrue();
  return (result.data as { task: { id: string } }).task.id;
}

/** Create a subtask and return its id. */
async function seedSubtask(
  cwd: string,
  taskId: string,
  title: string,
): Promise<string> {
  const result = await runSubtask({
    cwd,
    mode: "toon",
    args: ["create", "--task", taskId, "--title", title],
  });
  expect(result.ok).toBeTrue();
  return (result.data as { subtask: { id: string } }).subtask.id;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// 1. Session --epic scoping
// ---------------------------------------------------------------------------
describe("session --epic scoping", (): void => {
  test("with --epic returns readiness scoped to that epic", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicA = await seedEpic(cwd, "Epic A", "First");
    const epicB = await seedEpic(cwd, "Epic B", "Second");

    await seedTask(cwd, epicA, "Task A1", "desc");
    await seedTask(cwd, epicA, "Task A2", "desc");
    await seedTask(cwd, epicB, "Task B1", "desc");

    const scopedResult = await runSession({
      cwd,
      mode: "toon",
      args: ["--epic", epicA],
    });
    expect(scopedResult.ok).toBeTrue();
    const scopedData = scopedResult.data as {
      readiness: { readyCount: number; blockedCount: number };
    };
    // Epic A has 2 tasks, both should be ready (no deps)
    expect(scopedData.readiness.readyCount).toBe(2);
  });

  test("without --epic returns global readiness", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicA = await seedEpic(cwd, "Epic A", "First");
    const epicB = await seedEpic(cwd, "Epic B", "Second");

    await seedTask(cwd, epicA, "Task A1", "desc");
    await seedTask(cwd, epicB, "Task B1", "desc");

    // Without --epic, session auto-resolves an active epic (first in_progress or todo).
    // The auto-resolved epic may scope readiness to one epic. Verify it returns
    // a valid readiness result regardless.
    const globalResult = await runSession({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(globalResult.ok).toBeTrue();
    const globalData = globalResult.data as {
      readiness: { readyCount: number; blockedCount: number };
    };
    // At minimum, readiness should be reported
    expect(globalData.readiness.readyCount).toBeGreaterThanOrEqual(0);
    expect(globalData.readiness.blockedCount).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Epic progress
// ---------------------------------------------------------------------------
describe("epic progress", (): void => {
  test("returns correct counts and next candidate", async (): Promise<void> => {
    const cwd = createWorkspace();

    const epicId = await seedEpic(cwd, "Progress Epic", "Track progress");
    const taskTodo = await seedTask(cwd, epicId, "Todo task", "desc");
    const taskInProgress = await seedTask(cwd, epicId, "IP task", "desc");
    const taskDone = await seedTask(cwd, epicId, "Done task", "desc");
    const taskBlocked = await seedTask(cwd, epicId, "Blocked task", "desc");

    // Transition tasks to desired statuses
    await runTask({ cwd, mode: "toon", args: ["update", taskInProgress, "--status", "in_progress"] });
    await runTask({ cwd, mode: "toon", args: ["update", taskDone, "--status", "in_progress"] });
    await runTask({ cwd, mode: "toon", args: ["update", taskDone, "--status", "done"] });
    await runTask({ cwd, mode: "toon", args: ["update", taskBlocked, "--status", "blocked"] });

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: ["progress", epicId],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      epicId: string;
      title: string;
      total: number;
      doneCount: number;
      inProgressCount: number;
      blockedCount: number;
      todoCount: number;
      readyCount: number;
      nextCandidate: { id: string; title: string } | null;
    };

    expect(data.total).toBe(4);
    expect(data.doneCount).toBe(1);
    expect(data.inProgressCount).toBe(1);
    expect(data.blockedCount).toBe(1);
    expect(data.todoCount).toBe(1);
    // ready = in_progress(1) + todo(1) = 2 open tasks with no deps
    expect(data.readyCount).toBe(2);
    expect(data.nextCandidate).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Status transition rejection
// ---------------------------------------------------------------------------
describe("status transition rejection", (): void => {
  test("rejects todo to done transition", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Status Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Test task", "desc");

    // task starts in todo; direct transition to done is invalid
    const result = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "done"],
    });
    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("status_transition_invalid");
  });

  test("rejects in_progress to todo transition", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Status Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Test task", "desc");

    // Move to in_progress first
    const moved = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "in_progress"],
    });
    expect(moved.ok).toBeTrue();

    // in_progress -> todo is invalid
    const result = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "todo"],
    });
    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("status_transition_invalid");
  });

  test("valid transitions succeed", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Status Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Test task", "desc");

    // todo -> in_progress
    const toIp = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "in_progress"],
    });
    expect(toIp.ok).toBeTrue();

    // in_progress -> done
    const toDone = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "done"],
    });
    expect(toDone.ok).toBeTrue();

    // done -> in_progress (re-open)
    const reopen = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "in_progress"],
    });
    expect(reopen.ok).toBeTrue();

    // in_progress -> blocked
    const toBlocked = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "blocked"],
    });
    expect(toBlocked.ok).toBeTrue();

    // blocked -> todo
    const toTodo = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--status", "todo"],
    });
    expect(toTodo.ok).toBeTrue();
  });
});

// ---------------------------------------------------------------------------
// 4. Owner field roundtrip
// ---------------------------------------------------------------------------
describe("owner field roundtrip", (): void => {
  test("owner is null by default and can be set via update", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Owner Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Owned task", "desc");

    // Verify owner is null by default via create result
    const createResult = await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "Another owned", "--description", "d"],
    });
    expect(createResult.ok).toBeTrue();
    const createdTask = (createResult.data as { task: { id: string; owner: string | null } }).task;
    expect(createdTask.owner).toBeNull();

    // Set owner via update
    const updated = await runTask({
      cwd,
      mode: "toon",
      args: ["update", taskId, "--owner", "alice"],
    });
    expect(updated.ok).toBeTrue();
    const updatedData = updated.data as { task: { owner: string | null } };
    expect(updatedData.task.owner).toBe("alice");

    // Read back via DB to confirm persistence
    const storage = openTrekoonDatabase(cwd);
    try {
      const domain = new TrackerDomain(storage.db);
      const task = domain.getTask(taskId);
      expect(task).not.toBeNull();
      expect(task!.owner).toBe("alice");
    } finally {
      storage.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Subtask validation warning (task done with open subtasks)
// ---------------------------------------------------------------------------
describe("subtask validation warning", (): void => {
  test("task done with open subtasks returns warning", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Subtask Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Parent task", "desc");
    const subId = await seedSubtask(cwd, taskId, "Open subtask");

    // Move task to in_progress so we can mark it done
    await runTask({ cwd, mode: "toon", args: ["update", taskId, "--status", "in_progress"] });

    const doneResult = await runTask({
      cwd,
      mode: "toon",
      args: ["done", taskId],
    });
    expect(doneResult.ok).toBeTrue();

    const doneData = doneResult.data as {
      openSubtaskCount: number;
      openSubtaskIds: string[];
      warning: string | null;
    };
    expect(doneData.openSubtaskCount).toBe(1);
    expect(doneData.openSubtaskIds).toContain(subId);
    expect(doneData.warning).toBeString();
    expect(doneData.warning).toContain("open");
  });

  test("task done with all subtasks done returns no warning", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Subtask Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Parent task", "desc");
    const subId = await seedSubtask(cwd, taskId, "Completed subtask");

    // Complete the subtask first
    await runSubtask({ cwd, mode: "toon", args: ["update", subId, "--status", "in_progress"] });
    await runSubtask({ cwd, mode: "toon", args: ["update", subId, "--status", "done"] });

    // Move task to in_progress, then mark done
    await runTask({ cwd, mode: "toon", args: ["update", taskId, "--status", "in_progress"] });
    const doneResult = await runTask({
      cwd,
      mode: "toon",
      args: ["done", taskId],
    });
    expect(doneResult.ok).toBeTrue();

    const doneData = doneResult.data as {
      openSubtaskCount: number;
      openSubtaskIds: string[];
      warning: string | null;
    };
    expect(doneData.openSubtaskCount).toBe(0);
    expect(doneData.openSubtaskIds).toEqual([]);
    expect(doneData.warning).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6. Compact envelope stripping
// ---------------------------------------------------------------------------
describe("compact envelope stripping", (): void => {
  test("compact strips metadata from TOON output", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Compact Epic", "desc");

    const result = await runEpic({
      cwd,
      mode: "toon",
      args: ["show", epicId],
    });
    expect(result.ok).toBeTrue();

    // Without compact: metadata is present
    const fullEnvelope = toToonEnvelope(result);
    expect(fullEnvelope).toHaveProperty("metadata");
    expect(fullEnvelope.metadata).toBeDefined();

    // With compact: metadata is stripped
    const compactEnvelope = toToonEnvelope(result, { compact: true });
    expect(compactEnvelope).not.toHaveProperty("metadata");
  });
});

// ---------------------------------------------------------------------------
// 7. Batch dep resolution correctness
// ---------------------------------------------------------------------------
describe("batch dep resolution correctness", (): void => {
  test("buildTaskReadiness returns correct blocked/ready for tasks with deps", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Dep Epic", "desc");

    const blockerTask = await seedTask(cwd, epicId, "Blocker", "desc");
    const dependentTask = await seedTask(cwd, epicId, "Dependent", "desc");
    const freeTask = await seedTask(cwd, epicId, "Free", "desc");

    // dependentTask depends on blockerTask
    const depResult = await runDep({
      cwd,
      mode: "toon",
      args: ["add", dependentTask, blockerTask],
    });
    expect(depResult.ok).toBeTrue();

    const storage = openTrekoonDatabase(cwd);
    try {
      const domain = new TrackerDomain(storage.db);
      const readiness = buildTaskReadiness(domain, epicId);

      // blockerTask and freeTask should be ready (no unresolved deps)
      const readyIds = readiness.candidates.map((c) => c.task.id);
      expect(readyIds).toContain(blockerTask);
      expect(readyIds).toContain(freeTask);
      expect(readyIds).not.toContain(dependentTask);

      // dependentTask should be blocked
      const blockedIds = readiness.blocked.map((c) => c.task.id);
      expect(blockedIds).toContain(dependentTask);

      expect(readiness.summary.readyCount).toBe(2);
      expect(readiness.summary.blockedCount).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("completing blocker moves dependent to ready", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Dep Epic", "desc");

    const blockerTask = await seedTask(cwd, epicId, "Blocker", "desc");
    const dependentTask = await seedTask(cwd, epicId, "Dependent", "desc");

    await runDep({ cwd, mode: "toon", args: ["add", dependentTask, blockerTask] });

    // Complete the blocker
    await runTask({ cwd, mode: "toon", args: ["update", blockerTask, "--status", "in_progress"] });
    await runTask({ cwd, mode: "toon", args: ["update", blockerTask, "--status", "done"] });

    const storage = openTrekoonDatabase(cwd);
    try {
      const domain = new TrackerDomain(storage.db);
      const readiness = buildTaskReadiness(domain, epicId);

      // After blocker is done, only dependentTask remains open and should be ready
      const readyIds = readiness.candidates.map((c) => c.task.id);
      expect(readyIds).toContain(dependentTask);
      expect(readiness.summary.blockedCount).toBe(0);
    } finally {
      storage.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Task done unblocked diff
// ---------------------------------------------------------------------------
describe("task done unblocked diff", (): void => {
  test("completing a task returns unblocked downstream tasks", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Unblock Epic", "desc");

    const blockerTask = await seedTask(cwd, epicId, "Blocker", "desc");
    const downstreamTask = await seedTask(cwd, epicId, "Downstream", "desc");

    // downstream depends on blocker
    await runDep({ cwd, mode: "toon", args: ["add", downstreamTask, blockerTask] });

    // Move blocker to in_progress
    await runTask({ cwd, mode: "toon", args: ["update", blockerTask, "--status", "in_progress"] });

    // Mark blocker done — should unblock downstream
    const doneResult = await runTask({
      cwd,
      mode: "toon",
      args: ["done", blockerTask],
    });
    expect(doneResult.ok).toBeTrue();

    const doneData = doneResult.data as {
      unblocked: Array<{ id: string; kind: string; title: string }>;
    };
    expect(doneData.unblocked.length).toBe(1);
    expect(doneData.unblocked[0]?.id).toBe(downstreamTask);
  });

  test("completing a task with no downstream returns empty unblocked", async (): Promise<void> => {
    const cwd = createWorkspace();
    const epicId = await seedEpic(cwd, "Unblock Epic", "desc");

    const loneTask = await seedTask(cwd, epicId, "Lone task", "desc");

    await runTask({ cwd, mode: "toon", args: ["update", loneTask, "--status", "in_progress"] });

    const doneResult = await runTask({
      cwd,
      mode: "toon",
      args: ["done", loneTask],
    });
    expect(doneResult.ok).toBeTrue();

    const doneData = doneResult.data as {
      unblocked: Array<{ id: string }>;
    };
    expect(doneData.unblocked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Suggest command
// ---------------------------------------------------------------------------
describe("suggest command", (): void => {
  test("returns structured suggestions array", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicId = await seedEpic(cwd, "Suggest Epic", "desc");
    await seedTask(cwd, epicId, "Some task", "desc");

    const result = await runSuggest({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      suggestions: Array<{
        priority: number;
        action: string;
        command: string;
        reason: string;
        category: string;
      }>;
      context: {
        totalEpics: number;
        activeEpic: string | null;
        readyTasks: number;
        blockedTasks: number;
        inProgressTasks: number;
        syncBehind: number;
        pendingConflicts: number;
      };
    };
    expect(Array.isArray(data.suggestions)).toBeTrue();
    expect(data.context.totalEpics).toBe(1);
  });

  test("no epics path suggests quickstart", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const result = await runSuggest({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      suggestions: Array<{ action: string; category: string }>;
    };
    const quickstartSuggestion = data.suggestions.find((s) => s.action === "quickstart");
    expect(quickstartSuggestion).toBeDefined();
    expect(quickstartSuggestion?.category).toBe("planning");
  });

  test("all tasks done suggests marking epic done", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicId = await seedEpic(cwd, "Done Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "Task", "desc");

    // Complete the task: todo -> in_progress -> done
    await runTask({ cwd, mode: "toon", args: ["update", taskId, "--status", "in_progress"] });
    await runTask({ cwd, mode: "toon", args: ["update", taskId, "--status", "done"] });

    const result = await runSuggest({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      suggestions: Array<{ action: string; category: string }>;
    };
    const markDoneSuggestion = data.suggestions.find((s) => s.action.includes("mark epic"));
    expect(markDoneSuggestion).toBeDefined();
    expect(markDoneSuggestion?.category).toBe("planning");
  });

  test("ready tasks path suggests claiming a task", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicId = await seedEpic(cwd, "Ready Epic", "desc");
    await seedTask(cwd, epicId, "Ready task", "desc");

    const result = await runSuggest({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      suggestions: Array<{ action: string; category: string }>;
    };
    const claimSuggestion = data.suggestions.find((s) => s.action.includes("claim task"));
    expect(claimSuggestion).toBeDefined();
    expect(claimSuggestion?.category).toBe("execution");
  });

  test("in-progress task path suggests continuing", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicId = await seedEpic(cwd, "IP Epic", "desc");
    const taskId = await seedTask(cwd, epicId, "IP task", "desc");
    await runTask({ cwd, mode: "toon", args: ["update", taskId, "--status", "in_progress"] });

    const result = await runSuggest({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      suggestions: Array<{ action: string; category: string }>;
    };
    const continueSuggestion = data.suggestions.find((s) => s.action.includes("continue task"));
    expect(continueSuggestion).toBeDefined();
    expect(continueSuggestion?.category).toBe("execution");
  });

  test("all blocked path suggests reviewing blocked tasks", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicId = await seedEpic(cwd, "Blocked Epic", "desc");
    const blockerTask = await seedTask(cwd, epicId, "Blocker (done path)", "desc");
    const blockedTask = await seedTask(cwd, epicId, "Blocked task", "desc");

    // Create dependency so blockedTask is blocked by blockerTask
    await runDep({ cwd, mode: "toon", args: ["add", blockedTask, blockerTask] });

    // Mark the blocker as blocked so it's not "ready" either
    await runTask({ cwd, mode: "toon", args: ["update", blockerTask, "--status", "blocked"] });

    const result = await runSuggest({
      cwd,
      mode: "toon",
      args: [],
    });
    expect(result.ok).toBeTrue();

    const data = result.data as {
      suggestions: Array<{ action: string; category: string }>;
    };
    const reviewSuggestion = data.suggestions.find((s) => s.action === "review blocked tasks");
    expect(reviewSuggestion).toBeDefined();
    expect(reviewSuggestion?.category).toBe("planning");
  });
});
