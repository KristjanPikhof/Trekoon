import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runInit } from "../../src/commands/init";
import { runSync } from "../../src/commands/sync";
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
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "seed repo"]);
}

function commitDb(workspace: string, message: string): void {
  runGit(workspace, ["add", ".trekoon/trekoon.db"]);
  runGit(workspace, ["commit", "-m", message]);
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
    commitDb(workspace, "add main tracker records");

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
          command: "epic show",
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
});
