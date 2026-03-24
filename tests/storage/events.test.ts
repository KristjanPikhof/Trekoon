import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { type EventPruneSummary, pruneEvents, pruneResolvedConflicts } from "../../src/storage/events-retention";
import { nextEventTimestamp } from "../../src/sync/event-writes";
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

function insertConflict(
  db: ReturnType<typeof openTrekoonDatabase>["db"],
  params: {
    readonly id: string;
    readonly eventId: string;
    readonly entityId: string;
    readonly resolution: string;
    readonly updatedAt: number;
  },
): void {
  db.query(
    "INSERT INTO sync_conflicts (id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at, version) VALUES (?, ?, 'task', ?, 'title', 'ours', 'theirs', ?, ?, ?, 1);",
  ).run(params.id, params.eventId, params.entityId, params.resolution, params.updatedAt, params.updatedAt);
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

  test("prune preserves events referenced by sync cursors", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      // Insert an old event that a cursor still references.
      const cursorEventId: string = randomUUID();
      const cursorEventCreatedAt: number = now - 120 * DAY_IN_MILLISECONDS;
      insertEvent(storage.db, {
        id: cursorEventId,
        entityId: randomUUID(),
        createdAt: cursorEventCreatedAt,
      });

      // Insert a newer event that is also old enough to prune.
      const safeEventId: string = randomUUID();
      insertEvent(storage.db, {
        id: safeEventId,
        entityId: randomUUID(),
        createdAt: now - 100 * DAY_IN_MILLISECONDS,
      });

      // Insert a recent event that is never a prune candidate.
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: now - DAY_IN_MILLISECONDS,
      });

      // Create a sync cursor pointing at the old event.
      const cursorToken = `${cursorEventCreatedAt}:${cursorEventId}`;
      storage.db
        .query(
          `INSERT INTO sync_cursors (id, owner_scope, owner_worktree_path, source_branch, cursor_token, last_event_at, created_at, updated_at, version)
           VALUES (?, 'worktree', '/tmp/wt', 'main', ?, ?, ?, ?, 1);`,
        )
        .run(randomUUID(), cursorToken, cursorEventCreatedAt, now, now);

      const summary: EventPruneSummary = pruneEvents(storage.db, {
        retentionDays: 90,
        now,
      });

      // The pruned events must not go below the oldest cursor reference.
      // The cursor-referenced event and anything after it must survive.
      const remaining = storage.db.query("SELECT COUNT(*) AS count FROM events;").get() as { count: number };
      expect(remaining.count).toBeGreaterThanOrEqual(2);
      expect(summary.staleCursorCount).toBe(0);

      // The cursor-referenced event must still exist.
      const cursorEvent = storage.db
        .query("SELECT id FROM events WHERE id = ?;")
        .get(cursorEventId) as { id: string } | null;
      expect(cursorEvent?.id).toBe(cursorEventId);
    } finally {
      storage.close();
    }
  });

  test("prune reports stale cursors when cursor references pruned events", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      // Insert only a recent event — the cursor-referenced event is already gone.
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: now - DAY_IN_MILLISECONDS,
      });

      // Create a cursor that references an event timestamp far in the past
      // (event no longer exists).
      const staleTimestamp: number = now - 200 * DAY_IN_MILLISECONDS;
      storage.db
        .query(
          `INSERT INTO sync_cursors (id, owner_scope, owner_worktree_path, source_branch, cursor_token, last_event_at, created_at, updated_at, version)
           VALUES (?, 'worktree', '/tmp/stale-wt', 'main', ?, ?, ?, ?, 1);`,
        )
        .run(randomUUID(), `${staleTimestamp}:stale-id`, staleTimestamp, now, now);

      const summary: EventPruneSummary = pruneEvents(storage.db, {
        retentionDays: 90,
        now,
      });

      expect(summary.staleCursorCount).toBeGreaterThanOrEqual(1);
    } finally {
      storage.close();
    }
  });

  test("conflict prune dry-run reports eligible resolved conflicts only", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      const oldEventId = randomUUID();
      insertEvent(storage.db, {
        id: oldEventId,
        entityId: randomUUID(),
        createdAt: now - 120 * DAY_IN_MILLISECONDS,
      });

      insertConflict(storage.db, {
        id: randomUUID(),
        eventId: oldEventId,
        entityId: randomUUID(),
        resolution: "ours",
        updatedAt: now - 40 * DAY_IN_MILLISECONDS,
      });
      insertConflict(storage.db, {
        id: randomUUID(),
        eventId: oldEventId,
        entityId: randomUUID(),
        resolution: "pending",
        updatedAt: now - 40 * DAY_IN_MILLISECONDS,
      });

      const summary = pruneResolvedConflicts(storage.db, {
        retentionDays: 30,
        dryRun: true,
        now,
      });

      expect(summary.candidateCount).toBe(1);
      expect(summary.deletedCount).toBe(0);
    } finally {
      storage.close();
    }
  });

  test("nextEventTimestamp returns Date.now when no events exist", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const before: number = Date.now();
      const ts: number = nextEventTimestamp(storage.db);
      const after: number = Date.now();

      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    } finally {
      storage.close();
    }
  });

  test("nextEventTimestamp returns latest + 1 when Date.now would collide", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      // Insert an event with a timestamp far in the future so Date.now() < latest.
      const futureTimestamp: number = Date.now() + 1_000_000;
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: futureTimestamp,
      });

      const ts: number = nextEventTimestamp(storage.db);

      expect(ts).toBe(futureTimestamp + 1);
    } finally {
      storage.close();
    }
  });

  test("nextEventTimestamp returns strictly increasing values for consecutive calls", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const ts1: number = nextEventTimestamp(storage.db);
      // Simulate the first event being written at ts1.
      insertEvent(storage.db, {
        id: randomUUID(),
        entityId: randomUUID(),
        createdAt: ts1,
      });

      const ts2: number = nextEventTimestamp(storage.db);

      expect(ts2).toBeGreaterThan(ts1);
    } finally {
      storage.close();
    }
  });

  test("conflict prune deletes only resolved conflicts older than the retention window", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const now: number = Date.now();

    try {
      const oldEventId = randomUUID();
      insertEvent(storage.db, {
        id: oldEventId,
        entityId: randomUUID(),
        createdAt: now - 120 * DAY_IN_MILLISECONDS,
      });

      const oldResolvedConflictId = randomUUID();
      insertConflict(storage.db, {
        id: oldResolvedConflictId,
        eventId: oldEventId,
        entityId: randomUUID(),
        resolution: "theirs",
        updatedAt: now - 45 * DAY_IN_MILLISECONDS,
      });
      insertConflict(storage.db, {
        id: randomUUID(),
        eventId: oldEventId,
        entityId: randomUUID(),
        resolution: "pending",
        updatedAt: now - 45 * DAY_IN_MILLISECONDS,
      });
      insertConflict(storage.db, {
        id: randomUUID(),
        eventId: oldEventId,
        entityId: randomUUID(),
        resolution: "ours",
        updatedAt: now - 5 * DAY_IN_MILLISECONDS,
      });

      const summary = pruneResolvedConflicts(storage.db, {
        retentionDays: 30,
        now,
      });

      expect(summary.candidateCount).toBe(1);
      expect(summary.deletedCount).toBe(1);

      const deletedConflict = storage.db.query("SELECT id FROM sync_conflicts WHERE id = ?;").get(oldResolvedConflictId) as
        | { id: string }
        | null;
      const remainingCount = storage.db.query("SELECT COUNT(*) AS count FROM sync_conflicts;").get() as { count: number };

      expect(deletedConflict).toBeNull();
      expect(remainingCount.count).toBe(2);
    } finally {
      storage.close();
    }
  });
});
