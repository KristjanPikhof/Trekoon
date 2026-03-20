import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runDep } from "../../src/commands/dep";
import { runEpic } from "../../src/commands/epic";
import { runInit } from "../../src/commands/init";
import { runSubtask } from "../../src/commands/subtask";
import { runSync } from "../../src/commands/sync";
import { runTask } from "../../src/commands/task";
import { runWipe } from "../../src/commands/wipe";
import { okResult, toToonEnvelope } from "../../src/io/output";
import { appendEventWithGitContext } from "../../src/sync/event-writes";
import { openTrekoonDatabase } from "../../src/storage/database";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-integration-"));
  tempDirs.push(workspace);
  return workspace;
}

function runGit(cwd: string, args: readonly string[]): string {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout: string = new TextDecoder().decode(command.stdout).trim();
  const stderr: string = new TextDecoder().decode(command.stderr).trim();

  if (command.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }

  return stdout;
}

function seedRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# integration repo\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  runGit(workspace, ["add", "README.md", ".gitignore"]);
  runGit(workspace, ["commit", "-m", "seed repo"]);
}

function createBranchWorktree(workspace: string, branch: string): string {
  const worktreePath: string = createWorkspace();
  runGit(workspace, ["worktree", "add", "-b", branch, worktreePath, "main"]);
  return worktreePath;
}

interface WorkflowIds {
  readonly epicId: string;
  readonly taskId: string;
  readonly subtaskId: string;
  readonly depId: string;
}

function seedTrackerRows(workspace: string): WorkflowIds {
  const epicId: string = randomUUID();
  const taskId: string = randomUUID();
  const subtaskId: string = randomUUID();
  const depId: string = randomUUID();
  const now: number = Date.now();

  const storage = openTrekoonDatabase(workspace);
  try {
    storage.db
      .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
      .run(epicId, "Sync epic", "integration", "open", now, now);

    storage.db
      .query(
        "INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(taskId, epicId, "Sync task", "integration", "open", now, now);

    storage.db
      .query(
        "INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(subtaskId, taskId, "Sync subtask", "integration", "open", now, now);

    storage.db
      .query(
        "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
      )
      .run(depId, taskId, "task", subtaskId, "subtask", now, now);

    appendEventWithGitContext(storage.db, workspace, {
      entityKind: "epic",
      entityId: epicId,
      operation: "upsert",
      fields: {
        title: "Sync epic",
        description: "integration",
        status: "open",
      },
    });

    appendEventWithGitContext(storage.db, workspace, {
      entityKind: "task",
      entityId: taskId,
      operation: "upsert",
      fields: {
        epic_id: epicId,
        title: "Sync task",
        description: "integration",
        status: "open",
      },
    });

    appendEventWithGitContext(storage.db, workspace, {
      entityKind: "subtask",
      entityId: subtaskId,
      operation: "upsert",
      fields: {
        task_id: taskId,
        title: "Sync subtask",
        description: "integration",
        status: "open",
      },
    });
  } finally {
    storage.close();
  }

  return {
    epicId,
    taskId,
    subtaskId,
    depId,
  };
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("integration sync workflow", (): void => {
  test("init -> entity flow -> sync -> wipe", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initResult = await runInit({
      args: [],
      cwd: workspace,
      mode: "human",
    });
    expect(initResult.ok).toBe(true);

    const ids = seedTrackerRows(workspace);
    runGit(workspace, ["checkout", "-b", "feature/integration-sync"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Local sync epic", Date.now(), ids.epicId);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: ids.epicId,
          operation: "upsert",
          fields: { title: "Local sync epic" },
        });
      } finally {
        storage.close();
      }
    }

    const epicStorage = openTrekoonDatabase(workspace);
    try {
      const epic = epicStorage.db.query("SELECT id, title, status FROM epics WHERE id = ?;").get(ids.epicId) as {
        id: string;
        title: string;
        status: string;
      };
      const task = epicStorage.db.query("SELECT id, title, status FROM tasks WHERE id = ?;").get(ids.taskId) as {
        id: string;
        title: string;
        status: string;
      };
      const subtask = epicStorage.db
        .query("SELECT id, title, status FROM subtasks WHERE id = ?;")
        .get(ids.subtaskId) as { id: string; title: string; status: string };

      const toon = toToonEnvelope(
        okResult({
          command: "epic.show",
          human: "integration",
          data: {
            tree: {
              id: epic.id,
              title: epic.title,
              status: epic.status,
              tasks: [
                {
                  id: task.id,
                  title: task.title,
                  status: task.status,
                  subtasks: [
                    {
                      id: subtask.id,
                      title: subtask.title,
                      status: subtask.status,
                    },
                  ],
                },
              ],
            },
          },
        }),
      );

      expect(toon.ok).toBe(true);
      expect((toon.data as { tree: { tasks: Array<{ subtasks: Array<{ id: string }> }> } }).tree.tasks[0]?.subtasks[0]?.id).toBe(
        ids.subtaskId,
      );
    } finally {
      epicStorage.close();
    }

    const statusResult = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(statusResult.ok).toBe(true);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(1);

    const conflictStorage = openTrekoonDatabase(workspace);
    try {
      const conflict = conflictStorage.db
        .query("SELECT id FROM sync_conflicts WHERE resolution = 'pending' LIMIT 1;")
        .get() as { id: string } | null;

      expect(conflict?.id).toBeDefined();

      const resolveResult = await runSync({
        args: ["resolve", conflict!.id, "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });
      expect(resolveResult.ok).toBe(true);
    } finally {
      conflictStorage.close();
    }

    const wipeResult = await runWipe({
      args: ["--yes"],
      cwd: workspace,
      mode: "human",
    });
    expect(wipeResult.ok).toBe(true);

    const storagePaths = resolveStoragePaths(workspace);
    expect(existsSync(storagePaths.storageDir)).toBe(false);
  });

  test("pull applies valid events when malformed events exist", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const mainEpicId = randomUUID();
    const validTaskId = randomUUID();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        const now = Date.now();
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(mainEpicId, "Main epic", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: mainEpicId,
          operation: "upsert",
          fields: {
            title: "Main epic",
            description: "seed",
            status: "todo",
          },
        });

        const malformedEventId = randomUUID();
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'task', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(malformedEventId, validTaskId, '{"fields":"broken"}', now + 1, now + 1);

        const validEventId = randomUUID();
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'task', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            validEventId,
            validTaskId,
            JSON.stringify({
              fields: {
                epic_id: mainEpicId,
                title: "Applied task",
                description: "from main",
                status: "todo",
              },
            }),
            now + 2,
            now + 2,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/replay-resilience"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(3);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBeGreaterThanOrEqual(2);

    const storage = openTrekoonDatabase(workspace);
    try {
      const appliedTask = storage.db
        .query("SELECT id, title FROM tasks WHERE id = ?;")
        .get(validTaskId) as { id: string; title: string } | null;
      expect(appliedTask?.title).toBe("Applied task");

      const invalidConflict = storage.db
        .query("SELECT id FROM sync_conflicts WHERE resolution = 'invalid' LIMIT 1;")
        .get() as { id: string } | null;
      expect(invalidConflict?.id).toBeDefined();
    } finally {
      storage.close();
    }
  });

  test("pull replays canonical batch events once and stays idempotent on rerun", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initResult = await runInit({
      args: [],
      cwd: workspace,
      mode: "human",
    });
    expect(initResult.ok).toBe(true);
    runGit(workspace, ["checkout", "-b", "feature/canonical-replay"]);
    runGit(workspace, ["checkout", "main"]);

    const epicCreated = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: ["create", "--title", "Replay epic", "--description", "canonical replay"],
    });
    expect(epicCreated.ok).toBe(true);
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const taskBatch = await runTask({
      cwd: workspace,
      mode: "toon",
      args: [
        "create-many",
        "--epic",
        epicId,
        "--task",
        "task-1|Task A|A|todo",
        "--task",
        "task-2|Task B|B|todo",
      ],
    });
    expect(taskBatch.ok).toBe(true);
    const [taskAId, taskBId] = (taskBatch.data as { tasks: Array<{ id: string }> }).tasks.map((task) => task.id);

    const subtaskBatch = await runSubtask({
      cwd: workspace,
      mode: "toon",
      args: [
        "create-many",
        "--task",
        taskAId ?? "",
        "--subtask",
        "sub-1|Subtask A|desc|todo",
        "--subtask",
        "sub-2|Subtask B|desc|done",
      ],
    });
    expect(subtaskBatch.ok).toBe(true);
    const [subtaskAId, subtaskBId] = (subtaskBatch.data as { subtasks: Array<{ id: string }> }).subtasks.map((subtask) => subtask.id);

    const depBatch = await runDep({
      cwd: workspace,
      mode: "toon",
      args: ["add-many", "--dep", `${taskBId}|${taskAId}`, "--dep", `${subtaskBId}|${subtaskAId}`],
    });
    expect(depBatch.ok).toBe(true);

    runGit(workspace, ["checkout", "feature/canonical-replay"]);

    const firstPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(firstPull.ok).toBe(true);
    expect((firstPull.data as { createdConflicts: number }).createdConflicts).toBe(0);

    const storage = openTrekoonDatabase(workspace);
    try {
      const counts = {
        epics: (storage.db.query("SELECT COUNT(*) AS count FROM epics WHERE id = ?;").get(epicId) as { count: number }).count,
        tasks: (storage.db.query("SELECT COUNT(*) AS count FROM tasks;").get() as { count: number }).count,
        subtasks: (storage.db.query("SELECT COUNT(*) AS count FROM subtasks;").get() as { count: number }).count,
        dependencies: (storage.db.query("SELECT COUNT(*) AS count FROM dependencies;").get() as { count: number }).count,
      };

      expect(counts).toEqual({ epics: 1, tasks: 2, subtasks: 2, dependencies: 2 });
    } finally {
      storage.close();
    }

    const secondPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(secondPull.ok).toBe(true);
    expect((secondPull.data as { scannedEvents: number }).scannedEvents).toBe(0);
    expect((secondPull.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((secondPull.data as { createdConflicts: number }).createdConflicts).toBe(0);
  });

  test("pull replays one-shot epic create graph once and stays idempotent", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initResult = await runInit({
      args: [],
      cwd: workspace,
      mode: "human",
    });
    expect(initResult.ok).toBe(true);
    runGit(workspace, ["checkout", "-b", "feature/one-shot-create-replay"]);
    runGit(workspace, ["checkout", "main"]);

    const created = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: [
        "create",
        "--title",
        "Replay epic",
        "--description",
        "one-shot replay",
        "--task",
        "task-1|Task A|A|todo",
        "--subtask",
        "@task-1|sub-1|Subtask A|desc|todo",
        "--dep",
        "@task-1|@sub-1",
      ],
    });
    expect(created.ok).toBe(true);
    const epicId = (created.data as { epic: { id: string } }).epic.id;

    runGit(workspace, ["checkout", "feature/one-shot-create-replay"]);

    const firstPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(firstPull.ok).toBe(true);
    expect((firstPull.data as { createdConflicts: number }).createdConflicts).toBe(0);

    const storage = openTrekoonDatabase(workspace);
    try {
      const counts = {
        epics: (storage.db.query("SELECT COUNT(*) AS count FROM epics WHERE id = ?;").get(epicId) as { count: number }).count,
        tasks: (storage.db.query("SELECT COUNT(*) AS count FROM tasks;").get() as { count: number }).count,
        subtasks: (storage.db.query("SELECT COUNT(*) AS count FROM subtasks;").get() as { count: number }).count,
        dependencies: (storage.db.query("SELECT COUNT(*) AS count FROM dependencies;").get() as { count: number }).count,
      };

      expect(counts).toEqual({ epics: 1, tasks: 1, subtasks: 1, dependencies: 1 });
    } finally {
      storage.close();
    }

    const secondPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(secondPull.ok).toBe(true);
    expect((secondPull.data as { scannedEvents: number }).scannedEvents).toBe(0);
    expect((secondPull.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((secondPull.data as { createdConflicts: number }).createdConflicts).toBe(0);
  });

  test("same-branch sync pull stores events and advances cursor without conflicts", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initResult = await runInit({
      args: [],
      cwd: workspace,
      mode: "human",
    });
    expect(initResult.ok).toBe(true);

    const created = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: ["create", "--title", "Same-branch epic", "--description", "same-branch test"],
    });
    expect(created.ok).toBe(true);
    const epicId = (created.data as { epic: { id: string } }).epic.id;

    // Pull from main while on main (same-branch)
    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { sameBranch: boolean }).sameBranch).toBe(true);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(0);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);

    // Switch to feature branch and pull from main; events before the cursor should not appear
    runGit(workspace, ["checkout", "-b", "feature/same-branch-cursor"]);

    const crossPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(crossPull.ok).toBe(true);
    expect((crossPull.data as { sameBranch: boolean }).sameBranch).toBe(false);
    expect((crossPull.data as { scannedEvents: number }).scannedEvents).toBe(0);

    const storage = openTrekoonDatabase(workspace);
    try {
      const epic = storage.db.query("SELECT id, title FROM epics WHERE id = ?;").get(epicId) as { id: string; title: string } | null;
      expect(epic).toEqual({ id: epicId, title: "Same-branch epic" });
    } finally {
      storage.close();
    }
  });

  test("pull detects stale cursor after events have been pruned", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initResult = await runInit({
      args: [],
      cwd: workspace,
      mode: "human",
    });
    expect(initResult.ok).toBe(true);

    // Create an epic on main and pull from a feature branch to establish a cursor.
    const created = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: ["create", "--title", "Prune test epic", "--description", "will be pruned"],
    });
    expect(created.ok).toBe(true);

    runGit(workspace, ["checkout", "-b", "feature/stale-cursor-prune"]);

    const firstPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    expect(firstPull.ok).toBe(true);
    expect((firstPull.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);

    // Now prune the events that the cursor references (simulate time passing).
    const { pruneEvents } = await import("../../src/storage/events-retention");
    const storage = openTrekoonDatabase(workspace);
    try {
      // Force all events to appear old by updating their created_at.
      const DAY = 24 * 60 * 60 * 1000;
      const oldTimestamp = Date.now() - 200 * DAY;
      storage.db.query("UPDATE events SET created_at = ?;").run(oldTimestamp);

      // Prune with a short retention window.
      pruneEvents(storage.db, { retentionDays: 1 });

      const remaining = storage.db.query("SELECT COUNT(*) AS count FROM events;").get() as { count: number };
      expect(remaining.count).toBe(0);
    } finally {
      storage.close();
    }

    // Create new events on main after pruning.
    runGit(workspace, ["checkout", "main"]);
    const created2 = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: ["create", "--title", "Post-prune epic", "--description", "new"],
    });
    expect(created2.ok).toBe(true);

    runGit(workspace, ["checkout", "feature/stale-cursor-prune"]);

    // Pull should detect the stale cursor and surface it.
    const stalePull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(stalePull.ok).toBe(true);
    const data = stalePull.data as { diagnostics?: { staleCursor?: boolean; errorHints?: string[] }; appliedEvents: number };
    expect(data.diagnostics?.staleCursor).toBe(true);
    expect(data.appliedEvents).toBeGreaterThanOrEqual(1);
  });

  test("fresh worktree sees shared tracker state and can pull main", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initResult = await runInit({
      args: [],
      cwd: workspace,
      mode: "human",
    });
    expect(initResult.ok).toBe(true);

    const created = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: ["create", "--title", "Shared epic", "--description", "fresh worktree"],
    });
    expect(created.ok).toBe(true);
    const epicId = (created.data as { epic: { id: string } }).epic.id;

    const featureWorktree: string = createBranchWorktree(workspace, "feature/shared-worktree-sync");

    const statusBefore = await runSync({
      args: ["status", "--from", "main"],
      cwd: featureWorktree,
      mode: "toon",
    });
    expect(statusBefore.ok).toBe(true);
    expect((statusBefore.data as { behind: number }).behind).toBeGreaterThanOrEqual(1);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: featureWorktree,
      mode: "toon",
    });
    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);

    const storage = openTrekoonDatabase(featureWorktree);
    try {
      const epic = storage.db.query("SELECT id, title FROM epics WHERE id = ?;").get(epicId) as { id: string; title: string } | null;
      expect(epic).toEqual({ id: epicId, title: "Shared epic" });
    } finally {
      storage.close();
    }
  });
});
