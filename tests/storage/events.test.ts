import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { pruneEvents } from "../../src/storage/events-retention";
import { openTrekoonDatabase } from "../../src/storage/database";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-storage-events-"));
  tempDirs.push(workspace);
  return workspace;
}

function insertEvent(
  db: ReturnType<typeof openTrekoonDatabase>["db"],
  params: {
    readonly id: string;
    readonly entityId: string;
    readonly createdAt: number;
    readonly payload?: string;
  },
): void {
  db.query(
    "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', ?, 'main', NULL, ?, ?, 1);",
  ).run(params.id, params.entityId, params.payload ?? "{}", params.createdAt, params.createdAt);
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("event retention", (): void => {
  test("returns candidate count in dry-run mode", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: now - 120 * DAY_IN_MILLISECONDS,
      });
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: now - 2 * DAY_IN_MILLISECONDS,
      });

      const summary = pruneEvents(storage.db, {
        retentionDays: 90,
        dryRun: true,
        now,
      });

      expect(summary.candidateCount).toBe(1);
      expect(summary.archivedCount).toBe(0);
      expect(summary.deletedCount).toBe(0);

      const row = storage.db.query("SELECT COUNT(*) AS count FROM events;").get() as { count: number } | null;
      expect(row?.count).toBe(2);
    } finally {
      storage.close();
    }
  });

  test("deletes old events when pruning", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: now - 120 * DAY_IN_MILLISECONDS,
      });
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: now - DAY_IN_MILLISECONDS,
      });

      const summary = pruneEvents(storage.db, {
        retentionDays: 90,
        now,
      });

      expect(summary.candidateCount).toBe(1);
      expect(summary.deletedCount).toBe(1);

      const row = storage.db.query("SELECT COUNT(*) AS count FROM events;").get() as { count: number } | null;
      expect(row?.count).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("archives events before delete when enabled", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      const oldEventId: string = randomUUID();
      insertEvent(storage.db, {
        id: oldEventId,
        entityId: randomUUID(),
        createdAt: now - 120 * DAY_IN_MILLISECONDS,
      });

      const summary = pruneEvents(storage.db, {
        retentionDays: 90,
        archive: true,
        now,
      });

      expect(summary.candidateCount).toBe(1);
      expect(summary.archivedCount).toBe(1);
      expect(summary.deletedCount).toBe(1);

      const archived = storage.db
        .query("SELECT id FROM event_archive WHERE id = ?;")
        .get(oldEventId) as { id: string } | null;
      expect(archived?.id).toBe(oldEventId);
    } finally {
      storage.close();
    }
  });

  test("upserts archived row when archive has same event id", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      const eventId = "event-conflict-id";
      const sourceEntityId = "entity-source";
      const sourcePayload = '{"state":"fresh"}';
      const sourceCreatedAt = now - 120 * DAY_IN_MILLISECONDS;

      insertEvent(storage.db, {
        id: eventId,
        entityId: sourceEntityId,
        createdAt: sourceCreatedAt,
        payload: sourcePayload,
      });

      storage.db.exec(`
        CREATE TABLE IF NOT EXISTS event_archive (
          id TEXT PRIMARY KEY,
          entity_kind TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload TEXT NOT NULL,
          git_branch TEXT,
          git_head TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
      `);
      storage.db
        .query(
          "INSERT INTO event_archive (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', 'entity-stale', 'delete', '{\"state\":\"stale\"}', 'old-branch', 'old-head', ?, ?, 999);",
        )
        .run(eventId, sourceCreatedAt - DAY_IN_MILLISECONDS, sourceCreatedAt - DAY_IN_MILLISECONDS);

      const summary = pruneEvents(storage.db, {
        retentionDays: 90,
        archive: true,
        now,
      });

      expect(summary.candidateCount).toBe(1);
      expect(summary.archivedCount).toBe(1);
      expect(summary.deletedCount).toBe(1);

      const remaining = storage.db.query("SELECT COUNT(*) AS count FROM events WHERE id = ?;").get(eventId) as
        | { count: number }
        | null;
      expect(remaining?.count).toBe(0);

      const archived = storage.db
        .query("SELECT payload, entity_id, operation, version FROM event_archive WHERE id = ?;")
        .get(eventId) as
        | { payload: string; entity_id: string; operation: string; version: number }
        | null;

      expect(archived).not.toBeNull();
      expect(archived?.payload).toBe(sourcePayload);
      expect(archived?.entity_id).toBe(sourceEntityId);
      expect(archived?.operation).toBe("upsert");
      expect(archived?.version).toBe(1);
    } finally {
      storage.close();
    }
  });
});
