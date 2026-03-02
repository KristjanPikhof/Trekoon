import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEvents } from "../../src/commands/events";
import { openTrekoonDatabase } from "../../src/storage/database";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-events-command-"));
  tempDirs.push(workspace);
  return workspace;
}

function seedOldEvent(cwd: string, now: number): string {
  const eventId: string = randomUUID();
  const storage = openTrekoonDatabase(cwd);

  try {
    storage.db
      .query(
        "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', '{}', 'main', NULL, ?, ?, 1);",
      )
      .run(eventId, randomUUID(), now - 120 * DAY_IN_MILLISECONDS, now - 120 * DAY_IN_MILLISECONDS);
  } finally {
    storage.close();
  }

  return eventId;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("events command", (): void => {
  test("rejects missing subcommand", async (): Promise<void> => {
    const workspace: string = createWorkspace();

    const result = await runEvents({
      args: [],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_args");
  });

  test("supports dry-run prune", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const now: number = Date.now();
    seedOldEvent(workspace, now);

    const result = await runEvents({
      args: ["prune", "--dry-run", "--retention-days", "90"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("events.prune");
    const data = result.data as { dryRun: boolean; candidateCount: number; deletedCount: number };
    expect(data.dryRun).toBeTrue();
    expect(data.candidateCount).toBe(1);
    expect(data.deletedCount).toBe(0);
  });

  test("supports archival prune", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const now: number = Date.now();
    const eventId: string = seedOldEvent(workspace, now);

    const result = await runEvents({
      args: ["prune", "--archive", "--retention-days", "90"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeTrue();
    const data = result.data as { archivedCount: number; deletedCount: number };
    expect(data.archivedCount).toBe(1);
    expect(data.deletedCount).toBe(1);

    const storage = openTrekoonDatabase(workspace);
    try {
      const archived = storage.db
        .query("SELECT id FROM event_archive WHERE id = ?;")
        .get(eventId) as { id: string } | null;
      expect(archived?.id).toBe(eventId);
    } finally {
      storage.close();
    }
  });

  test("rejects invalid retention-days", async (): Promise<void> => {
    const workspace: string = createWorkspace();

    const result = await runEvents({
      args: ["prune", "--retention-days", "0"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });
});
