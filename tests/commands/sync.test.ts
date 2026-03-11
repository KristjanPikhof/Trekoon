import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runSync } from "../../src/commands/sync";
import { appendEventWithGitContext } from "../../src/sync/event-writes";
import { openTrekoonDatabase } from "../../src/storage/database";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-sync-command-"));
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

function initializeRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# test repo\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  runGit(workspace, ["add", "README.md", ".gitignore"]);
  runGit(workspace, ["commit", "-m", "init repository"]);
}

function createBranchWorktree(workspace: string, branch: string): string {
  const worktreePath: string = createWorkspace();
  runGit(workspace, ["worktree", "add", "-b", branch, worktreePath, "main"]);
  return worktreePath;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("sync command", (): void => {
  test("reports ahead/behind and resolves pull conflicts", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);",
          )
          .run(epicId, "Remote epic", "", "open", Date.now(), Date.now());

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Remote epic",
            description: "",
            status: "open",
          },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/sync"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Local epic", Date.now(), epicId);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Local epic",
          },
        });
      } finally {
        storage.close();
      }
    }

    const statusBefore = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(statusBefore.ok).toBe(true);
    expect(statusBefore.command).toBe("sync.status");
    expect((statusBefore.data as { behind: number }).behind).toBe(1);
    expect((statusBefore.data as { ahead: number }).ahead).toBe(1);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect(pullResult.command).toBe("sync.pull");
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(1);
    expect((pullResult.data as { diagnostics: { conflictEvents: number } }).diagnostics.conflictEvents).toBe(1);
    expect((pullResult.data as { diagnostics: { quarantinedEvents: number } }).diagnostics.quarantinedEvents).toBe(0);

    const storage = openTrekoonDatabase(workspace);
    try {
      const pendingConflict = storage.db
        .query("SELECT id FROM sync_conflicts WHERE resolution = 'pending' LIMIT 1;")
        .get() as { id: string } | null;

      expect(typeof pendingConflict?.id).toBe("string");

      const listResult = await runSync({
        args: ["conflicts", "list"],
        cwd: workspace,
        mode: "toon",
      });
      expect(listResult.ok).toBe(true);
      expect(listResult.command).toBe("sync.conflicts.list");
      expect((listResult.data as { conflicts: Array<{ id: string }> }).conflicts[0]?.id).toBe(pendingConflict!.id);

      const showResult = await runSync({
        args: ["conflicts", "show", pendingConflict!.id],
        cwd: workspace,
        mode: "toon",
      });
      expect(showResult.ok).toBe(true);
      expect(showResult.command).toBe("sync.conflicts.show");
      expect((showResult.data as { conflict: { id: string } }).conflict.id).toBe(pendingConflict!.id);

      const resolveResult = await runSync({
        args: ["resolve", pendingConflict!.id, "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      expect(resolveResult.ok).toBe(true);
      expect(resolveResult.command).toBe("sync.resolve");

      const resolved = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(pendingConflict!.id) as { resolution: string } | null;
      expect(resolved?.resolution).toBe("theirs");
    } finally {
      storage.close();
    }
  });

  test("returns usage errors for invalid input", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const statusMissingFromValue = await runSync({
      args: ["status", "--from"],
      cwd: workspace,
      mode: "human",
    });

    expect(statusMissingFromValue.ok).toBe(false);
    expect(statusMissingFromValue.error?.code).toBe("invalid_args");

    const missingFrom = await runSync({
      args: ["pull"],
      cwd: workspace,
      mode: "human",
    });

    expect(missingFrom.ok).toBe(false);
    expect(missingFrom.error?.code).toBe("invalid_args");

    const badResolution = await runSync({
      args: ["resolve", "123", "--use", "bad"],
      cwd: workspace,
      mode: "human",
    });

    expect(badResolution.ok).toBe(false);
    expect(badResolution.error?.code).toBe("invalid_args");

    const typoFrom = await runSync({
      args: ["pull", "--form", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(typoFrom.ok).toBe(false);
    expect(typoFrom.error?.code).toBe("unknown_option");
    expect(typoFrom.data).toMatchObject({
      option: "--form",
      allowedOptions: ["--from"],
      suggestions: ["--from"],
    });
  });

  test("rejects nonexistent or deleted source refs", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    runGit(workspace, ["branch", "stale/source"]);
    runGit(workspace, ["branch", "-D", "stale/source"]);

    const nonexistentStatus = await runSync({
      args: ["status", "--from", "missing/source"],
      cwd: workspace,
      mode: "toon",
    });

    expect(nonexistentStatus.ok).toBe(false);
    expect(nonexistentStatus.error?.code).toBe("invalid_source");
    expect(nonexistentStatus.data).toMatchObject({
      reason: "invalid_source",
      status: "invalid_source",
      sourceBranch: "missing/source",
    });

    const deletedPull = await runSync({
      args: ["pull", "--from", "stale/source"],
      cwd: workspace,
      mode: "toon",
    });

    expect(deletedPull.ok).toBe(false);
    expect(deletedPull.error?.code).toBe("invalid_source");
    expect(deletedPull.data).toMatchObject({
      reason: "invalid_source",
      status: "invalid_source",
      sourceBranch: "stale/source",
    });
  });

  test("surfaces recovery diagnostics when sync bootstrap is blocked", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);
    const storagePaths = resolveStoragePaths(workspace);

    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    writeFileSync(join(workspace, ".trekoon", "tracked.txt"), "tracked state\n");
    runGit(workspace, ["add", "-f", ".trekoon/tracked.txt"]);

    const result = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("tracked_ignored_mismatch");
    expect(result.data).toMatchObject({
      reason: "storage_bootstrap_blocked",
      recoveryRequired: true,
      recoveryStatus: "tracked_ignored_mismatch",
      trackedStorageFiles: [join(storagePaths.sharedStorageRoot, ".trekoon", "tracked.txt")],
    });
    expect((result.data as { operatorAction: string }).operatorAction).toContain("git -C");
    expect((result.data as { operatorAction: string }).operatorAction).toContain(".trekoon/tracked.txt");
  });

  test("quarantines malformed payloads and continues", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const eventId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1);",
          )
          .run(eventId, "epic", epicId, "upsert", '{"fields":"invalid"}', "main", null, now, now);
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/malformed-payload"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((pullResult.data as { diagnostics: { malformedPayloadEvents: number } }).diagnostics.malformedPayloadEvents).toBe(1);
    expect((pullResult.data as { diagnostics: { applyRejectedEvents: number } }).diagnostics.applyRejectedEvents).toBe(0);
    expect((pullResult.data as { diagnostics: { quarantinedEvents: number } }).diagnostics.quarantinedEvents).toBe(1);
    expect((pullResult.data as { diagnostics: { errorHints: string[] } }).diagnostics.errorHints).toContain(
      "Malformed event payloads were quarantined; inspect sync conflicts with field '__payload__'.",
    );
    expect((pullResult.data as { diagnostics: { errorHints: string[] } }).diagnostics.errorHints).not.toContain(
      "Some events were quarantined as invalid; inspect sync conflicts with field '__apply__'.",
    );

    const storage = openTrekoonDatabase(workspace);
    try {
      const invalidConflict = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE event_id = ? LIMIT 1;")
        .get(eventId) as { resolution: string } | null;
      expect(invalidConflict?.resolution).toBe("invalid");

      const epic = storage.db.query("SELECT id FROM epics WHERE id = ?;").get(epicId) as { id: string } | null;
      expect(epic).toBeNull();
    } finally {
      storage.close();
    }
  });

  test("sync pull is idempotent when create events are replayed", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const now = Date.now();
    const epicId = randomUUID();
    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Replay epic", "seed", "todo", now, now);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.created', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(randomUUID(), epicId, JSON.stringify({ fields: { title: "Replay epic", description: "seed", status: "todo" } }), now + 1, now + 1);
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/replay-idempotent"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBeGreaterThanOrEqual(1);
  });

  test("replayed create conflicts do not also create invalid apply conflicts", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const eventId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Remote epic", "seed", "todo", now, now);
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/replay-created-conflict"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Local epic", now + 1, epicId);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Local epic",
          },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "main"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.created', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            eventId,
            epicId,
            JSON.stringify({
              fields: {
                title: "Remote epic",
                description: "seed",
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

    runGit(workspace, ["checkout", "feature/replay-created-conflict"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(1);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(1);
    expect((pullResult.data as { diagnostics: { conflictEvents: number } }).diagnostics.conflictEvents).toBe(1);
    expect((pullResult.data as { diagnostics: { applyRejectedEvents: number } }).diagnostics.applyRejectedEvents).toBe(0);

    const storage = openTrekoonDatabase(workspace);
    try {
      const conflicts = storage.db
        .query("SELECT field_name, resolution FROM sync_conflicts WHERE event_id = ? ORDER BY field_name ASC;")
        .all(eventId) as Array<{ field_name: string; resolution: string }>;
      const epic = storage.db.query("SELECT title, description, status FROM epics WHERE id = ?;").get(epicId) as {
        title: string;
        description: string;
        status: string;
      } | null;

      expect(conflicts).toEqual([{ field_name: "title", resolution: "pending" }]);
      expect(epic).toEqual({ title: "Local epic", description: "seed", status: "todo" });
    } finally {
      storage.close();
    }
  });

  test("replays batched canonical replace updates without conflicts", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const taskId = randomUUID();
    const subtaskId = randomUUID();
    const now = Date.now();
    let baseCursorToken = "0:";

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Roadmap alpha", "Epic alpha desc", "todo", now, now);

        storage.db
          .query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
          .run(taskId, epicId, "Task alpha", "Task alpha desc", "todo", now, now);

        storage.db
          .query("INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
          .run(subtaskId, taskId, "Subtask alpha", "Subtask alpha desc", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "epic.created",
          fields: {
            title: "Roadmap alpha",
            description: "Epic alpha desc",
            status: "todo",
          },
        });
        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "task",
          entityId: taskId,
          operation: "task.created",
          fields: {
            epic_id: epicId,
            title: "Task alpha",
            description: "Task alpha desc",
            status: "todo",
          },
        });
        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "subtask",
          entityId: subtaskId,
          operation: "subtask.created",
          fields: {
            task_id: taskId,
            title: "Subtask alpha",
            description: "Subtask alpha desc",
            status: "todo",
          },
        });

        const latestEvent = storage.db
          .query("SELECT id, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT 1;")
          .get() as { id: string; created_at: number } | null;
        baseCursorToken = `${latestEvent?.created_at ?? 0}:${latestEvent?.id ?? ""}`;
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/replace-batch-replay"]);
    runGit(workspace, ["checkout", "main"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("UPDATE epics SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Roadmap beta", "Epic beta desc", now + 1, epicId);
        storage.db
          .query("UPDATE tasks SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Task beta", "Task beta desc", now + 1, taskId);
        storage.db
          .query("UPDATE subtasks SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Subtask beta", "Subtask beta desc", now + 1, subtaskId);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "epic.updated",
          fields: {
            title: "Roadmap beta",
            description: "Epic beta desc",
            status: "todo",
          },
        });
        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "task",
          entityId: taskId,
          operation: "task.updated",
          fields: {
            epic_id: epicId,
            title: "Task beta",
            description: "Task beta desc",
            status: "todo",
          },
        });
        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "subtask",
          entityId: subtaskId,
          operation: "subtask.updated",
          fields: {
            task_id: taskId,
            title: "Subtask beta",
            description: "Subtask beta desc",
            status: "todo",
          },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "feature/replace-batch-replay"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO sync_cursors (id, owner_scope, owner_worktree_path, source_branch, cursor_token, last_event_at, created_at, updated_at, version) VALUES (?, 'worktree', ?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET cursor_token = excluded.cursor_token, last_event_at = excluded.last_event_at, updated_at = excluded.updated_at, version = sync_cursors.version + 1;",
          )
          .run(`${workspace}::main`, workspace, "main", baseCursorToken, now, now, now);

        storage.db
          .query("UPDATE epics SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Roadmap beta", "Epic beta desc", now + 2, epicId);
        storage.db
          .query("UPDATE tasks SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Task beta", "Task beta desc", now + 2, taskId);
        storage.db
          .query("UPDATE subtasks SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Subtask beta", "Subtask beta desc", now + 2, subtaskId);
      } finally {
        storage.close();
      }
    }

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(3);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBeGreaterThanOrEqual(3);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(0);
    expect((pullResult.data as {
      diagnostics: {
        applyRejectedEvents: number;
        quarantinedEvents: number;
        conflictEvents: number;
        malformedPayloadEvents: number;
        errorHints: string[];
      };
    }).diagnostics).toEqual({
      applyRejectedEvents: 0,
      quarantinedEvents: 0,
      conflictEvents: 0,
      malformedPayloadEvents: 0,
      errorHints: [],
    });

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        const epic = storage.db.query("SELECT title, description, status FROM epics WHERE id = ?;").get(epicId) as {
          title: string;
          description: string;
          status: string;
        } | null;
        const task = storage.db.query("SELECT title, description, status FROM tasks WHERE id = ?;").get(taskId) as {
          title: string;
          description: string;
          status: string;
        } | null;
        const subtask = storage.db.query("SELECT title, description, status FROM subtasks WHERE id = ?;").get(subtaskId) as {
          title: string;
          description: string;
          status: string;
        } | null;
        const conflict = storage.db.query("SELECT id FROM sync_conflicts LIMIT 1;").get() as { id: string } | null;

        expect(epic).toEqual({ title: "Roadmap beta", description: "Epic beta desc", status: "todo" });
        expect(task).toEqual({ title: "Task beta", description: "Task beta desc", status: "todo" });
        expect(subtask).toEqual({ title: "Subtask beta", description: "Subtask beta desc", status: "todo" });
        expect(conflict).toBeNull();
      } finally {
        storage.close();
      }
    }

    const replayResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(replayResult.ok).toBe(true);
    expect((replayResult.data as { scannedEvents: number }).scannedEvents).toBe(0);
    expect((replayResult.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((replayResult.data as { createdConflicts: number }).createdConflicts).toBe(0);
  });

  test("applies dependency.removed events by edge identity", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const sourceId = randomUUID();
    const dependsOnId = randomUUID();
    const depId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run("epic-a", "Epic", "seed", "todo", now, now);

        storage.db
          .query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, 'epic-a', ?, ?, ?, ?, ?, 1);")
          .run(sourceId, "Task A", "seed", "todo", now, now);
        storage.db
          .query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, 'epic-a', ?, ?, ?, ?, ?, 1);")
          .run(dependsOnId, "Task B", "seed", "todo", now, now);

        storage.db
          .query("INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, 'task', ?, 'task', ?, ?, 1);")
          .run(depId, sourceId, dependsOnId, now, now);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'dependency', ?, 'dependency.removed', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            `${sourceId}->${dependsOnId}`,
            JSON.stringify({ fields: { source_id: sourceId, depends_on_id: dependsOnId } }),
            now + 1,
            now + 1,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/dep-removal"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);

    const storage = openTrekoonDatabase(workspace);
    try {
      const remaining = storage.db
        .query("SELECT id FROM dependencies WHERE source_id = ? AND depends_on_id = ? LIMIT 1;")
        .get(sourceId, dependsOnId) as { id: string } | null;
      expect(remaining).toBeNull();
    } finally {
      storage.close();
    }
  });

  test("quarantines dependency.added replay when referenced nodes are missing", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const sourceId = randomUUID();
    const dependsOnId = randomUUID();
    const eventId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run("epic-a", "Epic", "seed", "todo", now, now);

        storage.db
          .query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, 'epic-a', ?, ?, ?, ?, ?, 1);")
          .run(sourceId, "Task A", "seed", "todo", now, now);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'dependency', ?, 'dependency.added', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            eventId,
            `${sourceId}->${dependsOnId}`,
            JSON.stringify({
              fields: {
                source_id: sourceId,
                source_kind: "task",
                depends_on_id: dependsOnId,
                depends_on_kind: "task",
              },
            }),
            now + 1,
            now + 1,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/dep-added-missing-node"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((pullResult.data as { diagnostics: { applyRejectedEvents: number } }).diagnostics.applyRejectedEvents).toBe(1);

    const storage = openTrekoonDatabase(workspace);
    try {
      const dependency = storage.db
        .query("SELECT id FROM dependencies WHERE source_id = ? AND depends_on_id = ? LIMIT 1;")
        .get(sourceId, dependsOnId) as { id: string } | null;
      const invalidConflict = storage.db
        .query("SELECT resolution, field_name FROM sync_conflicts WHERE event_id = ? LIMIT 1;")
        .get(eventId) as { resolution: string; field_name: string } | null;

      expect(dependency).toBeNull();
      expect(invalidConflict).toEqual({ resolution: "invalid", field_name: "__apply__" });
    } finally {
      storage.close();
    }
  });

  test("rejects unsupported sync conflict list modes", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const result = await runSync({
      args: ["conflicts", "list", "--mode", "invalid"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_args");
  });

  test("rejects missing sync conflict mode value", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const result = await runSync({
      args: ["conflicts", "list", "--mode"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("invalid_args");
  });

  test("delete replay does not create invalid conflicts", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.deleted', '{\"fields\":{}}', 'main', NULL, ?, ?, 1);",
          )
          .run(randomUUID(), epicId, now, now);
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/delete-idempotent"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);

    const storage = openTrekoonDatabase(workspace);
    try {
      const invalidConflict = storage.db
        .query("SELECT id FROM sync_conflicts WHERE field_name = '__apply__' LIMIT 1;")
        .get() as { id: string } | null;
      expect(invalidConflict).toBeNull();
    } finally {
      storage.close();
    }
  });

  test("does not create conflict when current value already matches", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Remote title", "seed", "todo", now, now);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: { title: "Remote title", description: "seed", status: "todo" } }),
            now + 1,
            now + 1,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/current-value-match"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Stale local title",
          },
        });

        storage.db
          .query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Remote title", now + 2, epicId);
      } finally {
        storage.close();
      }
    }

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(0);
  });

  test("fresh same-repo worktrees sync without branch db snapshots", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Shared epic", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "epic.created",
          fields: {
            title: "Shared epic",
            description: "seed",
            status: "todo",
          },
        });
      } finally {
        storage.close();
      }
    }

    const featureWorktree: string = createBranchWorktree(workspace, "feature/fresh-worktree");
    const primaryPaths = resolveStoragePaths(workspace);
    const featurePaths = resolveStoragePaths(featureWorktree);
    const canonicalWorkspace = primaryPaths.worktreeRoot;
    const canonicalFeatureWorktree = featurePaths.worktreeRoot;

    expect(existsSync(join(featureWorktree, ".trekoon"))).toBe(false);
    expect(featurePaths.databaseFile).toBe(primaryPaths.databaseFile);
    expect(featurePaths.sharedStorageRoot).toBe(primaryPaths.sharedStorageRoot);
    expect(canonicalFeatureWorktree).not.toBe("");

    const primaryStatus = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(primaryStatus.ok).toBe(true);
    expect((primaryStatus.data as { git: { worktreePath: string; branchName: string } }).git).toMatchObject({
      worktreePath: canonicalWorkspace,
      branchName: "main",
    });

    const statusBefore = await runSync({
      args: ["status", "--from", "main"],
      cwd: featureWorktree,
      mode: "toon",
    });

    expect(statusBefore.ok).toBe(true);
    expect(statusBefore.error).toBeUndefined();
    expect((statusBefore.data as { behind: number }).behind).toBe(1);
    expect((statusBefore.data as { ahead: number }).ahead).toBe(0);
    expect((statusBefore.data as { git: { worktreePath: string; branchName: string } }).git).toMatchObject({
      worktreePath: canonicalFeatureWorktree,
      branchName: "feature/fresh-worktree",
    });

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: featureWorktree,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBe(1);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(0);
    expect(existsSync(join(featureWorktree, ".trekoon"))).toBe(false);

    const statusAfter = await runSync({
      args: ["status", "--from", "main"],
      cwd: featureWorktree,
      mode: "toon",
    });

    expect(statusAfter.ok).toBe(true);
    expect((statusAfter.data as { behind: number }).behind).toBe(0);

    const storage = openTrekoonDatabase(featureWorktree);
    try {
      const gitContexts = storage.db
        .query("SELECT worktree_path, branch_name FROM git_context ORDER BY worktree_path ASC;")
        .all() as Array<{ worktree_path: string; branch_name: string }>;
      const cursor = storage.db
        .query(
          "SELECT owner_scope, owner_worktree_path, source_branch, cursor_token FROM sync_cursors WHERE id = ? LIMIT 1;",
        )
        .get(`${canonicalFeatureWorktree}::main`) as {
          owner_scope: string;
          owner_worktree_path: string;
          source_branch: string;
          cursor_token: string;
        } | null;

      expect(gitContexts).toHaveLength(2);
      expect(gitContexts).toEqual(
        expect.arrayContaining([
          { worktree_path: canonicalFeatureWorktree, branch_name: "feature/fresh-worktree" },
          { worktree_path: canonicalWorkspace, branch_name: "main" },
        ]),
      );
      expect(cursor).toEqual({
        owner_scope: "worktree",
        owner_worktree_path: canonicalFeatureWorktree,
        source_branch: "main",
        cursor_token: expect.stringContaining(":"),
      });
    } finally {
      storage.close();
    }
  });
});
