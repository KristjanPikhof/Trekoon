import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { afterEach, describe, expect, test } from "bun:test";

import { runSync } from "../../src/commands/sync";
import { appendEventWithGitContext } from "../../src/sync/event-writes";
import { syncResolve } from "../../src/sync/service";
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

  test("sync pull detects conflicts beyond prior history scan limits", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Remote start", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: { title: "Remote start", description: "seed", status: "todo" },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/long-history-conflict"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        for (let index = 0; index < 260; index += 1) {
          storage.db.query("UPDATE epics SET description = ?, updated_at = ?, version = version + 1 WHERE id = ?;").run(
            `Local description ${index}`,
            now + index + 1,
            epicId,
          );

          appendEventWithGitContext(storage.db, workspace, {
            entityKind: "epic",
            entityId: epicId,
            operation: "upsert",
            fields: { description: `Local description ${index}` },
          });
        }
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "main"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db.query("UPDATE epics SET description = ?, updated_at = ?, version = version + 1 WHERE id = ?;").run(
          "Remote changed description",
          now + 10_000,
          epicId,
        );

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: { description: "Remote changed description" },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "feature/long-history-conflict"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(1);

    const storage = openTrekoonDatabase(workspace);
    try {
      const conflicts = storage.db
        .query("SELECT field_name, ours_value, theirs_value FROM sync_conflicts WHERE resolution = 'pending' AND event_id IN (SELECT id FROM events WHERE git_branch = 'main' ORDER BY created_at DESC LIMIT 1);")
        .all() as Array<{ field_name: string; ours_value: string; theirs_value: string }>;

      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({
        field_name: "description",
        ours_value: JSON.stringify("Local description 259"),
        theirs_value: JSON.stringify("Remote changed description"),
      });
    } finally {
      storage.close();
    }
  });

  test("replayed conflicting events do not duplicate conflict rows", async (): Promise<void> => {
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

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: { title: "Remote epic", description: "seed", status: "todo" },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/replayed-conflicts"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db.query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;").run("Local epic", now + 1, epicId);
        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: { title: "Local epic" },
        });
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(eventId, epicId, JSON.stringify({ fields: { title: "Remote epic v2" } }), now + 2, now + 2);
      } finally {
        storage.close();
      }
    }

    const firstPull = await runSync({ args: ["pull", "--from", "main"], cwd: workspace, mode: "toon" });
    expect(firstPull.ok).toBe(true);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db.query("UPDATE sync_cursors SET cursor_token = '0:', last_event_at = NULL;").run();
      } finally {
        storage.close();
      }
    }

    const secondPull = await runSync({ args: ["pull", "--from", "main"], cwd: workspace, mode: "toon" });
    expect(secondPull.ok).toBe(true);

    const storage = openTrekoonDatabase(workspace);
    try {
      const count = storage.db
        .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE event_id = ? AND field_name = 'title';")
        .get(eventId) as { count: number };
      expect(count.count).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("replayed resolution events are idempotent", async (): Promise<void> => {
    const { workspace, conflictId } = await setupConflictWorkspace("feature/replayed-resolution-events");

    const initial = await runSync({
      args: ["resolve", conflictId, "--use", "ours"],
      cwd: workspace,
      mode: "toon",
    });
    expect(initial.ok).toBe(true);

    const storage = openTrekoonDatabase(workspace);
    let resolutionEventId: string;
    let resolutionPayload: string;
    let entityId: string;
    try {
      const row = storage.db
        .query("SELECT id, entity_id, payload, created_at FROM events WHERE operation = 'resolve_conflict' ORDER BY created_at ASC LIMIT 1;")
        .get() as { id: string; entity_id: string; payload: string; created_at: number };
      resolutionEventId = row.id;
      resolutionPayload = row.payload;
      entityId = row.entity_id;

      storage.db.query("UPDATE sync_conflicts SET resolution = 'pending', updated_at = ?, version = version + 1 WHERE id = ?;").run(Date.now(), conflictId);
      storage.db.query("DELETE FROM events WHERE id = ?;").run(resolutionEventId);
      storage.db
        .query(
          "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'resolve_conflict', ?, 'main', NULL, ?, ?, 1);",
        )
        .run(resolutionEventId, entityId, resolutionPayload, Date.now() + 100, Date.now() + 100);
      storage.db.query("UPDATE sync_cursors SET cursor_token = '0:', last_event_at = NULL;").run();
    } finally {
      storage.close();
    }

    const replayPullA = await runSync({ args: ["pull", "--from", "main"], cwd: workspace, mode: "toon" });
    const replayPullB = await runSync({ args: ["pull", "--from", "main"], cwd: workspace, mode: "toon" });
    expect(replayPullA.ok).toBe(true);
    expect(replayPullB.ok).toBe(true);

    const verifyStorage = openTrekoonDatabase(workspace);
    try {
      const conflict = verifyStorage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(conflict?.resolution).toBe("ours");
    } finally {
      verifyStorage.close();
    }
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
        staleCursor: boolean;
        errorHints: string[];
      };
    }).diagnostics).toEqual({
      applyRejectedEvents: 0,
      quarantinedEvents: 0,
      conflictEvents: 0,
      malformedPayloadEvents: 0,
      staleCursor: false,
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

  test("replaying dependency.added for an already-existing edge is idempotent", async (): Promise<void> => {
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

        // Pre-existing dependency edge
        storage.db
          .query("INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, 'task', ?, 'task', ?, ?, 1);")
          .run(depId, sourceId, dependsOnId, now, now);

        // Incoming event that replays the same edge
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'dependency', ?, 'dependency.added', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            randomUUID(),
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

    runGit(workspace, ["checkout", "-b", "feature/dep-replay-idempotent"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(1);

    const storage = openTrekoonDatabase(workspace);
    try {
      const deps = storage.db
        .query("SELECT id FROM dependencies WHERE source_id = ? AND depends_on_id = ?;")
        .all(sourceId, dependsOnId) as Array<{ id: string }>;
      // Should still be exactly one row (idempotent)
      expect(deps.length).toBe(1);
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

  test("sync pull from own branch with events present produces zero conflicts", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Same branch epic", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Same branch epic",
            description: "seed",
            status: "todo",
          },
        });
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
    expect(pullResult.command).toBe("sync.pull");
    expect((pullResult.data as { sameBranch: boolean }).sameBranch).toBe(true);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(0);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(0);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);
    expect((pullResult.data as { diagnostics: { conflictEvents: number } }).diagnostics.conflictEvents).toBe(0);
    expect((pullResult.data as { diagnostics: { quarantinedEvents: number } }).diagnostics.quarantinedEvents).toBe(0);
  });

  test("sync status on own branch shows behind=0 and ahead=0 with sameBranch=true", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Same branch status epic", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Same branch status epic",
            description: "seed",
            status: "todo",
          },
        });
      } finally {
        storage.close();
      }
    }

    const statusResult = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(statusResult.ok).toBe(true);
    expect(statusResult.command).toBe("sync.status");
    expect((statusResult.data as { sameBranch: boolean }).sameBranch).toBe(true);
    expect((statusResult.data as { behind: number }).behind).toBe(0);
    expect((statusResult.data as { ahead: number }).ahead).toBe(0);
  });

  test("cursor advances on same-branch pull so subsequent cross-branch pull starts from correct position", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Cursor epic", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Cursor epic",
            description: "seed",
            status: "todo",
          },
        });
      } finally {
        storage.close();
      }
    }

    // Same-branch pull to advance the cursor
    const sameBranchPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(sameBranchPull.ok).toBe(true);
    expect((sameBranchPull.data as { sameBranch: boolean }).sameBranch).toBe(true);
    expect((sameBranchPull.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);

    // Now switch to feature branch
    runGit(workspace, ["checkout", "-b", "feature/cursor-advance"]);

    // Add a new event on main after the cursor was advanced
    runGit(workspace, ["checkout", "main"]);

    const newEpicId: string = randomUUID();
    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(newEpicId, "Post-cursor epic", "new", "todo", now + 100, now + 100);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: newEpicId,
          operation: "upsert",
          fields: {
            title: "Post-cursor epic",
            description: "new",
            status: "todo",
          },
        });
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "feature/cursor-advance"]);

    // Cross-branch pull should only see the new event, not the old one
    const crossBranchPull = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(crossBranchPull.ok).toBe(true);
    expect((crossBranchPull.data as { sameBranch: boolean }).sameBranch).toBe(false);
    expect((crossBranchPull.data as { scannedEvents: number }).scannedEvents).toBe(1);
    expect((crossBranchPull.data as { createdConflicts: number }).createdConflicts).toBe(0);
  });

  test("detached HEAD falls through to normal conflict detection path", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Detached epic", "seed", "todo", now, now);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: {
            title: "Detached epic",
            description: "seed",
            status: "todo",
          },
        });
      } finally {
        storage.close();
      }
    }

    // Detach HEAD at the current commit
    const headSha = runGit(workspace, ["rev-parse", "HEAD"]);
    runGit(workspace, ["checkout", headSha]);

    // Pull from main while in detached HEAD state
    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { sameBranch: boolean }).sameBranch).toBe(false);
    // Normal path applies events (not the same-branch fast path which sets appliedEvents=0)
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBeGreaterThanOrEqual(1);

    // Status should also fall through
    const statusResult = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(statusResult.ok).toBe(true);
    expect((statusResult.data as { sameBranch: boolean }).sameBranch).toBe(false);
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

  test("detects conflicts in event histories deeper than 50 events", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Deep epic", "seed", "todo", now, now);

        // Seed the epic.created event on main.
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.created', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: { title: "Deep epic", description: "seed", status: "todo" } }),
            now,
            now,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/deep-history"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        // Create 60 local events on the feature branch for this entity,
        // burying the local edit beyond the old 50-event window.
        storage.db
          .query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Local deep epic", now + 1, epicId);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'feature/deep-history', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: { title: "Local deep epic" } }),
            now + 1,
            now + 1,
          );

        // Pad with 59 more local events for unrelated fields.
        for (let i = 2; i <= 60; i++) {
          storage.db
            .query(
              "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'feature/deep-history', NULL, ?, ?, 1);",
            )
            .run(
              randomUUID(),
              epicId,
              JSON.stringify({ fields: { description: `iteration ${i}` } }),
              now + 1 + i,
              now + 1 + i,
            );
        }
      } finally {
        storage.close();
      }
    }

    // Now push a conflicting title change from main.
    runGit(workspace, ["checkout", "main"]);
    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.updated', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: { title: "Remote deep epic" } }),
            now + 100,
            now + 100,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "feature/deep-history"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    // Must detect the conflict even though the local edit is buried beyond 50 events.
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBeGreaterThanOrEqual(1);
    expect((pullResult.data as { diagnostics: { conflictEvents: number } }).diagnostics.conflictEvents).toBeGreaterThanOrEqual(1);

    const storage = openTrekoonDatabase(workspace);
    try {
      const conflict = storage.db
        .query("SELECT field_name FROM sync_conflicts WHERE entity_id = ? AND field_name = 'title' AND resolution = 'pending' LIMIT 1;")
        .get(epicId) as { field_name: string } | null;
      expect(conflict).not.toBeNull();

      // Local value must be preserved (not silently overwritten).
      const epic = storage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
      expect(epic?.title).toBe("Local deep epic");
    } finally {
      storage.close();
    }
  });

  test("incoming delete surfaces conflict when local edits exist", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId = randomUUID();
    const now = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Delete target", "seed", "open", now, now);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.created', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: { title: "Delete target", description: "seed", status: "open" } }),
            now,
            now,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", "feature/delete-conflict"]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        // Make a local edit on the feature branch.
        storage.db
          .query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
          .run("Locally edited", now + 1, epicId);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: { title: "Locally edited" },
        });
      } finally {
        storage.close();
      }
    }

    // Delete the epic on main.
    runGit(workspace, ["checkout", "main"]);
    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.deleted', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: {} }),
            now + 10,
            now + 10,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "feature/delete-conflict"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);

    const storage = openTrekoonDatabase(workspace);
    try {
      // The epic must NOT be silently deleted — it should still exist.
      const epic = storage.db.query("SELECT id, title FROM epics WHERE id = ?;").get(epicId) as { id: string; title: string } | null;
      expect(epic).not.toBeNull();
      expect(epic?.title).toBe("Locally edited");

      // A conflict must have been created for the delete-vs-edit situation.
      const conflict = storage.db
        .query("SELECT field_name FROM sync_conflicts WHERE entity_id = ? AND field_name = '__delete__' LIMIT 1;")
        .get(epicId) as { field_name: string } | null;
      expect(conflict).not.toBeNull();
    } finally {
      storage.close();
    }
  });

  async function setupConflictWorkspace(branchName: string): Promise<{ workspace: string; epicId: string; conflictId: string }> {
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

    runGit(workspace, ["checkout", "-b", branchName]);

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

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(1);

    const storage = openTrekoonDatabase(workspace);
    try {
      const pendingConflict = storage.db
        .query("SELECT id FROM sync_conflicts WHERE resolution = 'pending' LIMIT 1;")
        .get() as { id: string } | null;

      expect(typeof pendingConflict?.id).toBe("string");

      return { workspace, epicId, conflictId: pendingConflict!.id };
    } finally {
      storage.close();
    }
  }

  async function setupDeleteConflictWorkspace(branchName: string): Promise<{ workspace: string; epicId: string; conflictId: string }> {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const epicId: string = randomUUID();
    const now: number = Date.now();

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Delete target", "seed", "open", now, now);

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.created', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            randomUUID(),
            epicId,
            JSON.stringify({ fields: { title: "Delete target", description: "seed", status: "open" } }),
            now,
            now,
          );
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", "-b", branchName]);

    {
      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db.query("UPDATE epics SET title = ?, updated_at = ?, version = version + 1 WHERE id = ?;").run("Locally edited", now + 1, epicId);

        appendEventWithGitContext(storage.db, workspace, {
          entityKind: "epic",
          entityId: epicId,
          operation: "upsert",
          fields: { title: "Locally edited" },
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
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'epic.deleted', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(randomUUID(), epicId, JSON.stringify({ fields: {} }), now + 10, now + 10);
      } finally {
        storage.close();
      }
    }

    runGit(workspace, ["checkout", branchName]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);

    const storage = openTrekoonDatabase(workspace);
    try {
      const pendingConflict = storage.db
        .query("SELECT id FROM sync_conflicts WHERE entity_id = ? AND field_name = '__delete__' AND resolution = 'pending' LIMIT 1;")
        .get(epicId) as { id: string } | null;

      expect(typeof pendingConflict?.id).toBe("string");

      return { workspace, epicId, conflictId: pendingConflict!.id };
    } finally {
      storage.close();
    }
  }

  test("sync resolve --dry-run returns preview without mutating", async (): Promise<void> => {
    const { workspace, epicId, conflictId } = await setupConflictWorkspace("feature/dry-run");

    const dryRunTheirs = await runSync({
      args: ["resolve", conflictId, "--use", "theirs", "--dry-run"],
      cwd: workspace,
      mode: "toon",
    });

    expect(dryRunTheirs.ok).toBe(true);
    expect(dryRunTheirs.command).toBe("sync.resolve");

    const theirsData = dryRunTheirs.data as {
      conflictId: string;
      resolution: string;
      entityKind: string;
      entityId: string;
      fieldName: string;
      oursValue: unknown;
      theirsValue: unknown;
      wouldWrite: unknown;
      dryRun: boolean;
    };

    expect(theirsData.dryRun).toBe(true);
    expect(theirsData.conflictId).toBe(conflictId);
    expect(theirsData.resolution).toBe("theirs");
    expect(theirsData.entityKind).toBe("epic");
    expect(theirsData.entityId).toBe(epicId);
    expect(theirsData.fieldName).toBe("title");
    expect(theirsData.oursValue).toBe("Local epic");
    expect(theirsData.theirsValue).toBe("Remote epic");
    expect(theirsData.wouldWrite).toBe("Remote epic");

    const storage = openTrekoonDatabase(workspace);
    try {
      // Verify the conflict is still pending (not mutated)
      const stillPending = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(stillPending?.resolution).toBe("pending");

      // Verify the epic title was NOT changed by dry-run
      const epic = storage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
      expect(epic?.title).toBe("Local epic");

      // Verify no resolution events were created by dry-run
      const resolutionEvents = storage.db
        .query("SELECT id FROM events WHERE entity_kind = 'sync_conflict' AND entity_id = ? LIMIT 1;")
        .get(conflictId) as { id: string } | null;
      expect(resolutionEvents).toBeNull();
    } finally {
      storage.close();
    }

    // Dry-run with --use ours
    const dryRunOurs = await runSync({
      args: ["resolve", conflictId, "--use", "ours", "--dry-run"],
      cwd: workspace,
      mode: "toon",
    });

    expect(dryRunOurs.ok).toBe(true);
    const oursData = dryRunOurs.data as {
      resolution: string;
      wouldWrite: unknown;
      dryRun: boolean;
    };
    expect(oursData.dryRun).toBe(true);
    expect(oursData.resolution).toBe("ours");
    expect(oursData.wouldWrite).toBe("Local epic");
  });

  test("sync resolve --dry-run fails on nonexistent conflict", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);

    const result = await runSync({
      args: ["resolve", "nonexistent-id", "--use", "theirs", "--dry-run"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBe(false);
  });

  test("sync resolve --dry-run fails on already-resolved conflict", async (): Promise<void> => {
    const { workspace, conflictId } = await setupConflictWorkspace("feature/dry-run-already-resolved");

    const resolveResult = await runSync({
      args: ["resolve", conflictId, "--use", "ours"],
      cwd: workspace,
      mode: "toon",
    });
    expect(resolveResult.ok).toBe(true);

    const dryRunResult = await runSync({
      args: ["resolve", conflictId, "--use", "theirs", "--dry-run"],
      cwd: workspace,
      mode: "toon",
    });

    expect(dryRunResult.ok).toBe(false);
  });

  test("toon mode skips confirmation prompt for theirs resolution", async (): Promise<void> => {
    const { workspace, epicId, conflictId } = await setupConflictWorkspace("feature/toon-no-prompt");

    const resolveResult = await runSync({
      args: ["resolve", conflictId, "--use", "theirs"],
      cwd: workspace,
      mode: "toon",
    });

    expect(resolveResult.ok).toBe(true);
    expect(resolveResult.command).toBe("sync.resolve");

    const storage = openTrekoonDatabase(workspace);
    try {
      const resolved = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(resolved?.resolution).toBe("theirs");

      const epic = storage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
      expect(epic?.title).toBe("Remote epic");
    } finally {
      storage.close();
    }
  });

  async function withMockStdin<T>(answer: string, fn: () => Promise<T>, delayMs: number = 50): Promise<T> {
    const originalStdin = process.stdin;
    const mockStdin = new Readable({ read(): void {} });
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true, configurable: true });

    try {
      setTimeout((): void => {
        mockStdin.push(`${answer}\n`);
        mockStdin.push(null);
      }, delayMs);

      return await fn();
    } finally {
      Object.defineProperty(process, "stdin", { value: originalStdin, writable: true, configurable: true });
    }
  }

  test("json mode single theirs resolve does not prompt (passes without stdin)", async (): Promise<void> => {
    const { workspace, epicId, conflictId } = await setupConflictWorkspace("feature/json-single-no-prompt");

    // json mode should not prompt — if it did, this would hang waiting for stdin.
    const resolveResult = await runSync({
      args: ["resolve", conflictId, "--use", "theirs"],
      cwd: workspace,
      mode: "json",
    });

    expect(resolveResult.ok).toBe(true);
    expect(resolveResult.command).toBe("sync.resolve");

    const storage = openTrekoonDatabase(workspace);
    try {
      const resolved = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(resolved?.resolution).toBe("theirs");

      const epic = storage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
      expect(epic?.title).toBe("Remote epic");
    } finally {
      storage.close();
    }
  });

  test("human mode theirs resolution prompts for confirmation and accepts y", async (): Promise<void> => {
    const { workspace, conflictId } = await setupConflictWorkspace("feature/human-confirm-y");

    const resolveResult = await withMockStdin("y", () =>
      runSync({
        args: ["resolve", conflictId, "--use", "theirs"],
        cwd: workspace,
        mode: "human",
      }),
    );

    expect(resolveResult.ok).toBe(true);
    expect(resolveResult.command).toBe("sync.resolve");

    const storage = openTrekoonDatabase(workspace);
    try {
      const resolved = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(resolved?.resolution).toBe("theirs");
    } finally {
      storage.close();
    }
  });

  test("human mode theirs resolution prompts for confirmation and rejects n", async (): Promise<void> => {
    const { workspace, epicId, conflictId } = await setupConflictWorkspace("feature/human-confirm-n");

    const resolveResult = await withMockStdin("n", () =>
      runSync({
        args: ["resolve", conflictId, "--use", "theirs"],
        cwd: workspace,
        mode: "human",
      }),
    );

    expect(resolveResult.ok).toBe(false);
    expect(resolveResult.error?.code).toBe("cancelled");

    const storage = openTrekoonDatabase(workspace);
    try {
      const stillPending = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(stillPending?.resolution).toBe("pending");

      const epic = storage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
      expect(epic?.title).toBe("Local epic");
    } finally {
      storage.close();
    }
  });

  test("human mode ours resolution does not prompt for confirmation", async (): Promise<void> => {
    const { workspace, epicId, conflictId } = await setupConflictWorkspace("feature/human-ours-no-prompt");

    const resolveResult = await runSync({
      args: ["resolve", conflictId, "--use", "ours"],
      cwd: workspace,
      mode: "human",
    });

    expect(resolveResult.ok).toBe(true);
    expect(resolveResult.command).toBe("sync.resolve");

    const storage = openTrekoonDatabase(workspace);
    try {
      const resolved = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(resolved?.resolution).toBe("ours");

      const epic = storage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
      expect(epic?.title).toBe("Local epic");
    } finally {
      storage.close();
    }
  });

  test("second syncResolve on same conflict throws already resolved", async (): Promise<void> => {
    const { workspace, conflictId } = await setupConflictWorkspace("feature/concurrent-resolve");

    // First resolve succeeds.
    syncResolve(workspace, conflictId, "ours");

    // Second resolve on the same conflict must throw because
    // lookupPendingConflict is inside the writeTransaction.
    let secondError: Error | null = null;
    try {
      syncResolve(workspace, conflictId, "theirs");
    } catch (error: unknown) {
      secondError = error as Error;
    }

    expect(secondError).not.toBeNull();
    expect(secondError!.message).toContain("already resolved");

    const storage = openTrekoonDatabase(workspace);
    try {
      const conflict = storage.db
        .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
        .get(conflictId) as { resolution: string } | null;
      expect(conflict?.resolution).toBe("ours");

      const resolutionEvents = storage.db
        .query("SELECT COUNT(*) AS count FROM events WHERE operation = 'resolve_conflict';")
        .get() as { count: number };
      expect(resolutionEvents.count).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("resolution event created_at is strictly after prior events", async (): Promise<void> => {
    const { workspace, conflictId } = await setupConflictWorkspace("feature/monotonic-resolve-ts");

    const storage = openTrekoonDatabase(workspace);
    let maxEventTimestamp: number;
    try {
      const row = storage.db
        .query("SELECT MAX(created_at) AS max_ts FROM events;")
        .get() as { max_ts: number };
      maxEventTimestamp = row.max_ts;
    } finally {
      storage.close();
    }

    await runSync({
      args: ["resolve", conflictId, "--use", "ours"],
      cwd: workspace,
      mode: "toon",
    });

    const verifyStorage = openTrekoonDatabase(workspace);
    try {
      const resolutionEvent = verifyStorage.db
        .query(
          "SELECT created_at FROM events WHERE operation = 'resolve_conflict' LIMIT 1;",
        )
        .get() as { created_at: number } | null;

      expect(resolutionEvent).not.toBeNull();
      expect(resolutionEvent!.created_at).toBeGreaterThan(maxEventTimestamp);
    } finally {
      verifyStorage.close();
    }
  });

  describe("batch resolve (--all)", (): void => {
    /**
     * Sets up a workspace with multiple pending conflicts across two epics
     * and two fields (title and description) so batch resolve tests can
     * exercise filtering by entity and field.
     *
     * Returns the workspace path, epic IDs, and an array of conflict IDs.
     */
    async function setupBatchConflictWorkspace(branchName: string): Promise<{
      workspace: string;
      epicAId: string;
      epicBId: string;
      conflictIds: string[];
    }> {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const epicAId: string = randomUUID();
      const epicBId: string = randomUUID();
      const now: number = Date.now();

      // Seed two epics on main with title + description events.
      {
        const storage = openTrekoonDatabase(workspace);
        try {
          storage.db
            .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
            .run(epicAId, "Remote A title", "Remote A desc", "open", now, now);
          storage.db
            .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
            .run(epicBId, "Remote B title", "Remote B desc", "open", now, now);

          appendEventWithGitContext(storage.db, workspace, {
            entityKind: "epic",
            entityId: epicAId,
            operation: "upsert",
            fields: { title: "Remote A title", description: "Remote A desc", status: "open" },
          });
          appendEventWithGitContext(storage.db, workspace, {
            entityKind: "epic",
            entityId: epicBId,
            operation: "upsert",
            fields: { title: "Remote B title", description: "Remote B desc", status: "open" },
          });
        } finally {
          storage.close();
        }
      }

      runGit(workspace, ["checkout", "-b", branchName]);

      // Make local edits to both title and description for both epics.
      {
        const storage = openTrekoonDatabase(workspace);
        try {
          storage.db
            .query("UPDATE epics SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
            .run("Local A title", "Local A desc", now + 1, epicAId);
          storage.db
            .query("UPDATE epics SET title = ?, description = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
            .run("Local B title", "Local B desc", now + 1, epicBId);

          appendEventWithGitContext(storage.db, workspace, {
            entityKind: "epic",
            entityId: epicAId,
            operation: "upsert",
            fields: { title: "Local A title", description: "Local A desc" },
          });
          appendEventWithGitContext(storage.db, workspace, {
            entityKind: "epic",
            entityId: epicBId,
            operation: "upsert",
            fields: { title: "Local B title", description: "Local B desc" },
          });
        } finally {
          storage.close();
        }
      }

      // Pull from main to create conflicts on title + description for both epics.
      const pullResult = await runSync({
        args: ["pull", "--from", "main"],
        cwd: workspace,
        mode: "toon",
      });

      expect(pullResult.ok).toBe(true);
      expect((pullResult.data as { createdConflicts: number }).createdConflicts).toBe(4);

      const storage = openTrekoonDatabase(workspace);
      try {
        const pending = storage.db
          .query("SELECT id FROM sync_conflicts WHERE resolution = 'pending' ORDER BY created_at ASC;")
          .all() as Array<{ id: string }>;

        expect(pending.length).toBe(4);

        return {
          workspace,
          epicAId,
          epicBId,
          conflictIds: pending.map((r) => r.id),
        };
      } finally {
        storage.close();
      }
    }

    test("--all --use ours resolves all pending conflicts", async (): Promise<void> => {
      const { workspace, conflictIds } = await setupBatchConflictWorkspace("feature/batch-ours");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);
      expect(result.command).toBe("sync.resolve");

      const data = result.data as { resolution: string; resolvedCount: number; resolvedIds: string[] };
      expect(data.resolution).toBe("ours");
      expect(data.resolvedCount).toBe(4);
      expect(data.resolvedIds).toHaveLength(4);

      const storage = openTrekoonDatabase(workspace);
      try {
        const pending = storage.db
          .query("SELECT id FROM sync_conflicts WHERE resolution = 'pending';")
          .all() as Array<{ id: string }>;
        expect(pending).toHaveLength(0);

        for (const id of conflictIds) {
          const resolved = storage.db
            .query("SELECT resolution FROM sync_conflicts WHERE id = ?;")
            .get(id) as { resolution: string } | null;
          expect(resolved?.resolution).toBe("ours");
        }
      } finally {
        storage.close();
      }
    });

    test("--all --use theirs resolves all and writes field values", async (): Promise<void> => {
      const { workspace, epicAId, epicBId } = await setupBatchConflictWorkspace("feature/batch-theirs");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const data = result.data as { resolution: string; resolvedCount: number };
      expect(data.resolution).toBe("theirs");
      expect(data.resolvedCount).toBe(4);

      const storage = openTrekoonDatabase(workspace);
      try {
        const epicA = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicAId) as {
          title: string;
          description: string;
        } | null;
        const epicB = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicBId) as {
          title: string;
          description: string;
        } | null;

        expect(epicA?.title).toBe("Remote A title");
        expect(epicA?.description).toBe("Remote A desc");
        expect(epicB?.title).toBe("Remote B title");
        expect(epicB?.description).toBe("Remote B desc");
      } finally {
        storage.close();
      }
    });

    test("--entity filter narrows to one entity", async (): Promise<void> => {
      const { workspace, epicAId, epicBId } = await setupBatchConflictWorkspace("feature/batch-entity-filter");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours", "--entity", epicAId],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const data = result.data as { resolvedCount: number; filters: { entity: string | null; field: string | null } };
      expect(data.resolvedCount).toBe(2);
      expect(data.filters.entity).toBe(epicAId);

      const storage = openTrekoonDatabase(workspace);
      try {
        const resolvedA = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE entity_id = ? AND resolution = 'ours';")
          .get(epicAId) as { count: number };
        const pendingB = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE entity_id = ? AND resolution = 'pending';")
          .get(epicBId) as { count: number };

        expect(resolvedA.count).toBe(2);
        expect(pendingB.count).toBe(2);
      } finally {
        storage.close();
      }
    });

    test("--field filter narrows to one field type", async (): Promise<void> => {
      const { workspace } = await setupBatchConflictWorkspace("feature/batch-field-filter");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours", "--field", "title"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const data = result.data as { resolvedCount: number; filters: { entity: string | null; field: string | null } };
      expect(data.resolvedCount).toBe(2);
      expect(data.filters.field).toBe("title");

      const storage = openTrekoonDatabase(workspace);
      try {
        const resolvedTitle = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE field_name = 'title' AND resolution = 'ours';")
          .get() as { count: number };
        const pendingDesc = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE field_name = 'description' AND resolution = 'pending';")
          .get() as { count: number };

        expect(resolvedTitle.count).toBe(2);
        expect(pendingDesc.count).toBe(2);
      } finally {
        storage.close();
      }
    });

    test("combined --entity + --field filter", async (): Promise<void> => {
      const { workspace, epicAId, epicBId } = await setupBatchConflictWorkspace("feature/batch-entity-field");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs", "--entity", epicAId, "--field", "title"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const data = result.data as { resolvedCount: number; filters: { entity: string | null; field: string | null } };
      expect(data.resolvedCount).toBe(1);
      expect(data.filters.entity).toBe(epicAId);
      expect(data.filters.field).toBe("title");

      const storage = openTrekoonDatabase(workspace);
      try {
        const epicA = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicAId) as {
          title: string;
          description: string;
        } | null;
        // Title was resolved with theirs, description stays local.
        expect(epicA?.title).toBe("Remote A title");
        expect(epicA?.description).toBe("Local A desc");

        // Epic B should be completely untouched.
        const pendingB = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE entity_id = ? AND resolution = 'pending';")
          .get(epicBId) as { count: number };
        expect(pendingB.count).toBe(2);
      } finally {
        storage.close();
      }
    });

    test("--dry-run returns preview without mutation", async (): Promise<void> => {
      const { workspace, conflictIds } = await setupBatchConflictWorkspace("feature/batch-dry-run");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours", "--dry-run"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const data = result.data as {
        resolution: string;
        matchedCount: number;
        matchedIds: string[];
        dryRun: boolean;
        filters: { entity: string | null; field: string | null };
      };
      expect(data.dryRun).toBe(true);
      expect(data.resolution).toBe("ours");
      expect(data.matchedCount).toBe(4);
      expect(data.matchedIds).toHaveLength(4);
      expect(data.filters.entity).toBeNull();
      expect(data.filters.field).toBeNull();

      // Verify no mutations occurred.
      const storage = openTrekoonDatabase(workspace);
      try {
        const pending = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
          .get() as { count: number };
        expect(pending.count).toBe(4);

        const resolutionEvents = storage.db
          .query("SELECT COUNT(*) AS count FROM events WHERE operation = 'resolve_conflict';")
          .get() as { count: number };
        expect(resolutionEvents.count).toBe(0);
      } finally {
        storage.close();
      }
    });

    test("no matching conflicts returns error code no_matching_conflicts", async (): Promise<void> => {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("no_matching_conflicts");
      expect(result.data).toMatchObject({
        filters: { entity: null, field: null },
        reason: "no_matching_conflicts",
      });
    });

    test("single delete conflict resolves with theirs by deleting the entity", async (): Promise<void> => {
      const { workspace, epicId, conflictId } = await setupDeleteConflictWorkspace("feature/delete-resolve-theirs");

      const result = await runSync({
        args: ["resolve", conflictId, "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const storage = openTrekoonDatabase(workspace);
      try {
        const epic = storage.db.query("SELECT id FROM epics WHERE id = ?;").get(epicId) as { id: string } | null;
        const conflict = storage.db.query("SELECT resolution FROM sync_conflicts WHERE id = ?;").get(conflictId) as { resolution: string } | null;

        expect(epic).toBeNull();
        expect(conflict?.resolution).toBe("theirs");
      } finally {
        storage.close();
      }
    });

    test("--all + positional ID returns error", async (): Promise<void> => {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const result = await runSync({
        args: ["resolve", "some-conflict-id", "--all", "--use", "ours"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_args");
    });

    test("--all without --use returns usage error", async (): Promise<void> => {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const result = await runSync({
        args: ["resolve", "--all"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_args");
    });

    test("--entity/--field without --all are rejected", async (): Promise<void> => {
      const { workspace, conflictId } = await setupConflictWorkspace("feature/single-resolve-filter-validation");

      const entityResult = await runSync({
        args: ["resolve", conflictId, "--use", "ours", "--entity", "some-entity"],
        cwd: workspace,
        mode: "toon",
      });

      const fieldResult = await runSync({
        args: ["resolve", conflictId, "--use", "ours", "--field", "title"],
        cwd: workspace,
        mode: "toon",
      });

      expect(entityResult.ok).toBe(false);
      expect(entityResult.error?.code).toBe("invalid_args");
      expect(fieldResult.ok).toBe(false);
      expect(fieldResult.error?.code).toBe("invalid_args");
    });

    test("human mode batch theirs resolve prompts for confirmation and accepts y", async (): Promise<void> => {
      const { workspace } = await setupBatchConflictWorkspace("feature/batch-human-confirm-y");

      const result = await withMockStdin("y", () =>
        runSync({
          args: ["resolve", "--all", "--use", "theirs"],
          cwd: workspace,
          mode: "human",
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.command).toBe("sync.resolve");
      expect((result.data as { resolvedCount: number; resolution: string }).resolvedCount).toBe(4);
      expect((result.data as { resolvedCount: number; resolution: string }).resolution).toBe("theirs");
    });

    test("human mode batch ours resolve does not prompt", async (): Promise<void> => {
      const { workspace } = await setupBatchConflictWorkspace("feature/batch-human-ours-no-prompt");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours"],
        cwd: workspace,
        mode: "human",
      });

      expect(result.ok).toBe(true);
      expect((result.data as { resolvedCount: number; resolution: string }).resolvedCount).toBe(4);
      expect((result.data as { resolvedCount: number; resolution: string }).resolution).toBe("ours");
    });

    test("human mode batch resolve cancellation leaves conflicts and entities untouched", async (): Promise<void> => {
      const { workspace, epicAId, epicBId } = await setupBatchConflictWorkspace("feature/batch-human-confirm-n");

      const result = await withMockStdin("n", () =>
        runSync({
          args: ["resolve", "--all", "--use", "theirs"],
          cwd: workspace,
          mode: "human",
        }),
      );

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("cancelled");
      expect(result.data).toMatchObject({
        resolution: "theirs",
        cancelled: true,
        filters: { entity: null, field: null },
      });

      const storage = openTrekoonDatabase(workspace);
      try {
        const pending = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
          .get() as { count: number };
        const resolutionEvents = storage.db
          .query("SELECT COUNT(*) AS count FROM events WHERE operation = 'resolve_conflict';")
          .get() as { count: number };
        const epicA = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicAId) as {
          title: string;
          description: string;
        } | null;
        const epicB = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicBId) as {
          title: string;
          description: string;
        } | null;

        expect(pending.count).toBe(4);
        expect(resolutionEvents.count).toBe(0);
        expect(epicA).toEqual({ title: "Local A title", description: "Local A desc" });
        expect(epicB).toEqual({ title: "Local B title", description: "Local B desc" });
      } finally {
        storage.close();
      }
    });

    test("human mode batch theirs aborts when previewed conflict set changes", async (): Promise<void> => {
      const { workspace, epicAId } = await setupBatchConflictWorkspace("feature/batch-human-drift");

      const storage = openTrekoonDatabase(workspace);
      let driftConflictId: string;
      try {
        const conflict = storage.db
          .query("SELECT id FROM sync_conflicts WHERE entity_id = ? AND resolution = 'pending' ORDER BY created_at ASC LIMIT 1;")
          .get(epicAId) as { id: string } | null;
        expect(conflict).not.toBeNull();
        driftConflictId = conflict!.id;
      } finally {
        storage.close();
      }

      const result = await withMockStdin("y", async () => {
        const pendingResult = runSync({
          args: ["resolve", "--all", "--use", "theirs", "--entity", epicAId],
          cwd: workspace,
          mode: "human",
        });

        await Bun.sleep(50);

        const storage = openTrekoonDatabase(workspace);
        try {
          storage.db.query("UPDATE sync_conflicts SET resolution = 'ours', updated_at = ?, version = version + 1 WHERE id = ?;").run(Date.now(), driftConflictId);
        } finally {
          storage.close();
        }

        return pendingResult;
      }, 250);

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("conflict_set_changed");
      expect(result.data).toMatchObject({
        filters: { entity: epicAId, field: null },
        reason: "conflict_set_changed",
      });
    });

    test("--all --use theirs --dry-run stays non-mutating", async (): Promise<void> => {
      const { workspace, epicAId, epicBId } = await setupBatchConflictWorkspace("feature/batch-theirs-dry-run");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs", "--dry-run"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        resolution: "theirs",
        matchedCount: 4,
        filters: { entity: null, field: null },
        dryRun: true,
      });

      const storage = openTrekoonDatabase(workspace);
      try {
        const pending = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
          .get() as { count: number };
        const resolutionEvents = storage.db
          .query("SELECT COUNT(*) AS count FROM events WHERE operation = 'resolve_conflict';")
          .get() as { count: number };
        const epicA = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicAId) as {
          title: string;
          description: string;
        } | null;
        const epicB = storage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicBId) as {
          title: string;
          description: string;
        } | null;

        expect(pending.count).toBe(4);
        expect(resolutionEvents.count).toBe(0);
        expect(epicA).toEqual({ title: "Local A title", description: "Local A desc" });
        expect(epicB).toEqual({ title: "Local B title", description: "Local B desc" });
      } finally {
        storage.close();
      }
    });

    test("resolution events are appended for each conflict", async (): Promise<void> => {
      const { workspace, conflictIds } = await setupBatchConflictWorkspace("feature/batch-events");

      await runSync({
        args: ["resolve", "--all", "--use", "ours"],
        cwd: workspace,
        mode: "toon",
      });

      const storage = openTrekoonDatabase(workspace);
      try {
        const conflicts = storage.db
          .query("SELECT id, entity_id FROM sync_conflicts WHERE resolution != 'pending' ORDER BY created_at ASC;")
          .all() as Array<{ id: string; entity_id: string }>;

        // All 4 conflicts should be resolved.
        expect(conflicts).toHaveLength(4);
        for (const c of conflicts) {
          expect(conflictIds).toContain(c.id);
        }

        const resolutionEvents = storage.db
          .query("SELECT entity_id FROM events WHERE operation = 'resolve_conflict' ORDER BY created_at ASC;")
          .all() as Array<{ entity_id: string }>;

        // One resolution event per conflict.
        expect(resolutionEvents).toHaveLength(4);

        // Resolution events reference the entity, not the conflict row.
        // Each conflict's entity_id should appear in the resolution events.
        const eventEntityIds = resolutionEvents.map((e) => e.entity_id);
        const conflictEntityIds = conflicts.map((c) => c.entity_id);
        for (const entityId of conflictEntityIds) {
          expect(eventEntityIds).toContain(entityId);
        }
      } finally {
        storage.close();
      }
    });

    test("batch resolution events include stable payload fields", async (): Promise<void> => {
      const { workspace } = await setupBatchConflictWorkspace("feature/batch-event-payloads");

      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs", "--field", "title"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const storage = openTrekoonDatabase(workspace);
      try {
        const resolvedConflicts = storage.db
          .query(
            "SELECT id, entity_id, field_name, theirs_value FROM sync_conflicts WHERE resolution = 'theirs' ORDER BY created_at ASC;",
          )
          .all() as Array<{ id: string; entity_id: string; field_name: string; theirs_value: string | null }>;
        const resolutionEvents = storage.db
          .query(
            "SELECT entity_kind, entity_id, payload FROM events WHERE operation = 'resolve_conflict' ORDER BY created_at ASC;",
          )
          .all() as Array<{ entity_kind: string; entity_id: string; payload: string }>;

        expect(resolvedConflicts).toHaveLength(2);
        expect(resolutionEvents).toHaveLength(2);

        expect(
          resolutionEvents.map((event, index) => ({
            entity_kind: event.entity_kind,
            entity_id: event.entity_id,
            payload: JSON.parse(event.payload),
            conflictId: resolvedConflicts[index]?.id,
            fieldName: resolvedConflicts[index]?.field_name,
            theirsValue: resolvedConflicts[index]?.theirs_value ? JSON.parse(resolvedConflicts[index]!.theirs_value!) : null,
          })),
        ).toEqual([
          {
            entity_kind: "epic",
            entity_id: resolvedConflicts[0]!.entity_id,
            payload: {
              conflict_id: resolvedConflicts[0]!.id,
              field: "title",
              resolution: "theirs",
              value: JSON.stringify("Remote A title"),
            },
            conflictId: resolvedConflicts[0]!.id,
            fieldName: "title",
            theirsValue: "Remote A title",
          },
          {
            entity_kind: "epic",
            entity_id: resolvedConflicts[1]!.entity_id,
            payload: {
              conflict_id: resolvedConflicts[1]!.id,
              field: "title",
              resolution: "theirs",
              value: JSON.stringify("Remote B title"),
            },
            conflictId: resolvedConflicts[1]!.id,
            fieldName: "title",
            theirsValue: "Remote B title",
          },
        ]);
      } finally {
        storage.close();
      }
    });

    test("batch theirs applies duplicate field conflicts in source event order", async (): Promise<void> => {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const epicId: string = randomUUID();
      const baseTime: number = Date.now();

      const storage = openTrekoonDatabase(workspace);
      try {
        storage.db
          .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
          .run(epicId, "Local title", "desc", "open", baseTime, baseTime);

        const firstEventId: string = randomUUID();
        const secondEventId: string = randomUUID();

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            firstEventId,
            epicId,
            JSON.stringify({ fields: { title: 'Remote title v1' } }),
            baseTime + 10,
            baseTime + 10,
          );

        storage.db
          .query(
            "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
          )
          .run(
            secondEventId,
            epicId,
            JSON.stringify({ fields: { title: 'Remote title v2' } }),
            baseTime + 20,
            baseTime + 20,
          );

        // Intentionally reverse the conflict row timestamps to verify batch resolve
        // uses source event order rather than sync_conflicts.created_at order.
        storage.db
          .query(
            `INSERT INTO sync_conflicts (id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at, version)
             VALUES (?, ?, 'epic', ?, 'title', ?, ?, 'pending', ?, ?, 1);`,
          )
          .run(randomUUID(), firstEventId, epicId, JSON.stringify("Local title"), JSON.stringify("Remote title v1"), baseTime + 200, baseTime + 200);

        storage.db
          .query(
            `INSERT INTO sync_conflicts (id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at, version)
             VALUES (?, ?, 'epic', ?, 'title', ?, ?, 'pending', ?, ?, 1);`,
          )
          .run(randomUUID(), secondEventId, epicId, JSON.stringify("Local title"), JSON.stringify("Remote title v2"), baseTime + 100, baseTime + 100);
      } finally {
        storage.close();
      }

      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);

      const verifyStorage = openTrekoonDatabase(workspace);
      try {
        const epic = verifyStorage.db.query("SELECT title FROM epics WHERE id = ?;").get(epicId) as { title: string } | null;
        const resolutions = verifyStorage.db
          .query("SELECT resolution FROM sync_conflicts WHERE entity_id = ? ORDER BY created_at ASC;")
          .all(epicId) as Array<{ resolution: string }>;

        expect(epic?.title).toBe("Remote title v2");
        expect(resolutions).toHaveLength(2);
        for (const row of resolutions) {
          expect(row.resolution).toBe("theirs");
        }
      } finally {
        verifyStorage.close();
      }
    });

    test("already-resolved conflicts are not re-resolved", async (): Promise<void> => {
      const { workspace, epicAId } = await setupBatchConflictWorkspace("feature/batch-already-resolved");

      // Resolve epic A conflicts first.
      const firstResult = await runSync({
        args: ["resolve", "--all", "--use", "ours", "--entity", epicAId],
        cwd: workspace,
        mode: "toon",
      });

      expect(firstResult.ok).toBe(true);
      expect((firstResult.data as { resolvedCount: number }).resolvedCount).toBe(2);

      // Now resolve all remaining — should only pick up epic B conflicts.
      const secondResult = await runSync({
        args: ["resolve", "--all", "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      expect(secondResult.ok).toBe(true);

      const data = secondResult.data as { resolvedCount: number };
      expect(data.resolvedCount).toBe(2);

      const storage = openTrekoonDatabase(workspace);
      try {
        // Epic A conflicts should still be 'ours' (not re-resolved).
        const epicAResolutions = storage.db
          .query("SELECT resolution FROM sync_conflicts WHERE entity_id = ? ORDER BY created_at ASC;")
          .all(epicAId) as Array<{ resolution: string }>;
        for (const row of epicAResolutions) {
          expect(row.resolution).toBe("ours");
        }

        // No pending conflicts should remain.
        const pending = storage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
          .get() as { count: number };
        expect(pending.count).toBe(0);

        // Total resolution events: 2 (epic A) + 2 (epic B) = 4.
        const totalResolutionEvents = storage.db
          .query("SELECT COUNT(*) AS count FROM events WHERE operation = 'resolve_conflict';")
          .get() as { count: number };
        expect(totalResolutionEvents.count).toBe(4);
      } finally {
        storage.close();
      }
    });

    test("json mode batch resolve does not prompt (passes without stdin)", async (): Promise<void> => {
      const { workspace, conflictIds } = await setupBatchConflictWorkspace("feature/batch-json-no-prompt");

      // json mode must not prompt — if it did, this would hang waiting for stdin.
      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs"],
        cwd: workspace,
        mode: "json",
      });

      expect(result.ok).toBe(true);
      expect((result.data as { resolvedCount: number }).resolvedCount).toBe(conflictIds.length);
    });

    test("--all --use ours --entity with no value returns usage error", async (): Promise<void> => {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours", "--entity"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_args");
    });

    test("--all --use ours --field with no value returns usage error", async (): Promise<void> => {
      const workspace: string = createWorkspace();
      initializeRepository(workspace);

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours", "--field"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("invalid_args");
    });

    test("batch theirs with conflict on unsupported field returns error (not silent success)", async (): Promise<void> => {
      const { workspace, epicAId } = await setupBatchConflictWorkspace("feature/batch-unsupported-field");

      // Inject a conflict with a field name that is not in SYNC_ALLOWED_FIELDS.
      const storage = openTrekoonDatabase(workspace);
      try {
        // Grab an existing event id to satisfy the event_id foreign-key-like column.
        const eventRow = storage.db
          .query("SELECT id FROM events LIMIT 1;")
          .get() as { id: string };

        const now: number = Date.now();
        storage.db
          .query(
            `INSERT INTO sync_conflicts (id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1);`,
          )
          .run(
            randomUUID(),
            eventRow.id,
            "epic",
            epicAId,
            "bad_field",
            JSON.stringify("local value"),
            JSON.stringify("remote value"),
            now,
            now,
          );
      } finally {
        storage.close();
      }

      const result = await runSync({
        args: ["resolve", "--all", "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      // The unsupported field must cause an error — not silently succeed.
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("disallowed_field");

      const verifyStorage = openTrekoonDatabase(workspace);
      try {
        const pending = verifyStorage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
          .get() as { count: number };
        const resolved = verifyStorage.db
          .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution != 'pending';")
          .get() as { count: number };
        const resolutionEvents = verifyStorage.db
          .query("SELECT COUNT(*) AS count FROM events WHERE operation = 'resolve_conflict';")
          .get() as { count: number };
        const epicA = verifyStorage.db.query("SELECT title, description FROM epics WHERE id = ?;").get(epicAId) as {
          title: string;
          description: string;
        } | null;

        expect(pending.count).toBe(5);
        expect(resolved.count).toBe(0);
        expect(resolutionEvents.count).toBe(0);
        expect(epicA).toEqual({ title: "Local A title", description: "Local A desc" });
      } finally {
        verifyStorage.close();
      }
    });

    test("batch resolve still sees pending conflicts after source events are pruned", async (): Promise<void> => {
      const { workspace } = await setupBatchConflictWorkspace("feature/batch-pruned-events");

      const storage = openTrekoonDatabase(workspace);
      try {
        const deleted = storage.db
          .query("DELETE FROM events WHERE id IN (SELECT event_id FROM sync_conflicts WHERE resolution = 'pending');")
          .run();
        expect(deleted.changes).toBeGreaterThan(0);

        const remainingEvents = storage.db
          .query("SELECT COUNT(*) AS count FROM events WHERE id IN (SELECT event_id FROM sync_conflicts WHERE resolution = 'pending');")
          .get() as { count: number };
        expect(remainingEvents.count).toBe(0);
      } finally {
        storage.close();
      }

      const result = await runSync({
        args: ["resolve", "--all", "--use", "ours"],
        cwd: workspace,
        mode: "toon",
      });

      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        resolvedCount: 4,
        resolution: "ours",
      });
    });
  });
});
