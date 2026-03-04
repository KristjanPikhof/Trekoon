import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runSync } from "../../src/commands/sync";
import { appendEventWithGitContext } from "../../src/sync/event-writes";
import { openTrekoonDatabase } from "../../src/storage/database";

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
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "init repository"]);
}

function commitDatabase(workspace: string, subject: string): void {
  runGit(workspace, ["add", ".trekoon/trekoon.db"]);
  runGit(workspace, ["commit", "-m", subject]);
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

    commitDatabase(workspace, "store main tracker event");

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
    expect((statusBefore.data as { behind: number }).behind).toBeGreaterThan(0);
    expect((statusBefore.data as { ahead: number }).ahead).toBeGreaterThan(0);

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

      const listResult = await runSync({
        args: ["conflicts", "list"],
        cwd: workspace,
        mode: "toon",
      });
      expect(listResult.ok).toBe(true);
      expect((listResult.data as { conflicts: Array<{ id: string }> }).conflicts[0]?.id).toBe(pendingConflict?.id);

      const showResult = await runSync({
        args: ["conflicts", "show", pendingConflict!.id],
        cwd: workspace,
        mode: "toon",
      });
      expect(showResult.ok).toBe(true);
      expect((showResult.data as { conflict: { id: string } }).conflict.id).toBe(pendingConflict?.id);

      const resolveResult = await runSync({
        args: ["resolve", pendingConflict!.id, "--use", "theirs"],
        cwd: workspace,
        mode: "toon",
      });

      expect(resolveResult.ok).toBe(true);

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

    commitDatabase(workspace, "seed malformed payload event");
    runGit(workspace, ["checkout", "-b", "feature/malformed-payload"]);

    const pullResult = await runSync({
      args: ["pull", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });

    expect(pullResult.ok).toBe(true);
    expect((pullResult.data as { scannedEvents: number }).scannedEvents).toBeGreaterThanOrEqual(1);
    expect((pullResult.data as { appliedEvents: number }).appliedEvents).toBe(0);

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
});
