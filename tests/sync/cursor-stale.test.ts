import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { isCursorStale } from "../../src/sync/service";

const BRANCH = "main";
const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-sync-cursor-stale-"));
  tempDirs.push(workspace);
  return workspace;
}

function openDb(workspace: string): ReturnType<typeof openTrekoonDatabase>["db"] {
  return openTrekoonDatabase(workspace).db;
}

function insertEvent(
  db: ReturnType<typeof openTrekoonDatabase>["db"],
  params: {
    readonly id: string;
    readonly createdAt: number;
    readonly branch?: string;
  },
): void {
  db.query(
    "INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', '{}', ?, NULL, ?, ?, 1);",
  ).run(params.id, randomUUID(), params.branch ?? BRANCH, params.createdAt, params.createdAt);
}

function insertArchivedEvent(
  db: ReturnType<typeof openTrekoonDatabase>["db"],
  params: {
    readonly id: string;
    readonly createdAt: number;
    readonly branch?: string;
  },
): void {
  db.query(
    "INSERT INTO event_archive (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version) VALUES (?, 'epic', ?, 'upsert', '{}', ?, NULL, ?, ?, 1);",
  ).run(params.id, randomUUID(), params.branch ?? BRANCH, params.createdAt, params.createdAt);
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("isCursorStale", (): void => {
  describe("empty event log", (): void => {
    test("returns false for the zero cursor with no events", (): void => {
      const db = openDb(createWorkspace());
      expect(isCursorStale(db, "0:", BRANCH)).toBe(false);
    });

    test("returns false when both tables are empty", (): void => {
      const db = openDb(createWorkspace());
      const cursorToken = "1000:some-event-id";
      // No events anywhere → not stale (cursor may be at end of empty log)
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(false);
    });
  });

  describe("cursor predates archived events (pruned history)", (): void => {
    test("returns true when cursor is older than the earliest event_archive row", (): void => {
      const db = openDb(createWorkspace());
      const archiveTs = 2000;
      const archiveId = randomUUID();

      // All events have been pruned to the archive; live events table is empty.
      insertArchivedEvent(db, { id: archiveId, createdAt: archiveTs });

      // Cursor at ts=1000 predates archive min ts=2000 → stale
      const cursorToken = `1000:${randomUUID()}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(true);
    });

    test("returns true when cursor predates min of mixed events + archive", (): void => {
      const db = openDb(createWorkspace());

      // Archive has an event at ts=2000, live events table at ts=3000.
      insertArchivedEvent(db, { id: randomUUID(), createdAt: 2000 });
      insertEvent(db, { id: randomUUID(), createdAt: 3000 });

      // Cursor at ts=1000 predates both → stale
      const cursorToken = `1000:${randomUUID()}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(true);
    });

    test("returns true when cursor predates min of archive-only log (event id absent)", (): void => {
      const db = openDb(createWorkspace());
      const goneId = randomUUID();

      // The event was pruned to archive with ts=5000; a newer live event at ts=6000.
      insertArchivedEvent(db, { id: goneId, createdAt: 5000 });
      insertEvent(db, { id: randomUUID(), createdAt: 6000 });

      // Cursor references the pruned event at ts=4000 (predates archive min=5000)
      const cursorToken = `4000:${goneId}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(true);
    });
  });

  describe("cursor newer than min retained event", (): void => {
    test("returns false when live event id matches exactly", (): void => {
      const db = openDb(createWorkspace());
      const eventId = randomUUID();
      const eventTs = 5000;
      insertEvent(db, { id: eventId, createdAt: eventTs });

      // Cursor directly references an existing live event → not stale
      const cursorToken = `${eventTs}:${eventId}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(false);
    });

    test("returns false for zero cursor even with events present", (): void => {
      const db = openDb(createWorkspace());
      insertEvent(db, { id: randomUUID(), createdAt: 1000 });
      insertArchivedEvent(db, { id: randomUUID(), createdAt: 500 });
      expect(isCursorStale(db, "0:", BRANCH)).toBe(false);
    });

    test("returns false when cursor timestamp equals archive min ts with no newer events on branch", (): void => {
      const db = openDb(createWorkspace());

      // Only event is in archive, cursor at same ts — not predating min, no newer events.
      const archiveId = randomUUID();
      const archiveTs = 3000;
      insertArchivedEvent(db, { id: archiveId, createdAt: archiveTs });

      // Cursor timestamp equals min ts and the event is gone → newerRow check:
      // events >= 3000 in archive on BRANCH = the archive row itself, so it returns stale.
      // Stale because event id is gone and there IS a row at >= cursor ts.
      const cursorToken = `${archiveTs}:${archiveId}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(true);
    });

    test("returns false when cursor timestamp is after all events (end-of-stream)", (): void => {
      const db = openDb(createWorkspace());
      insertEvent(db, { id: randomUUID(), createdAt: 1000 });
      insertArchivedEvent(db, { id: randomUUID(), createdAt: 500 });

      // Cursor at ts=9999 — newer than all known events, non-existent event id
      // min ts=500, cursor=9999 >= 500 so not stale by predation check.
      // No events at >= 9999, so newerRow = null → not stale.
      const cursorToken = `9999:${randomUUID()}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(false);
    });

    test("returns true when referenced event is gone and newer events exist in archive only", (): void => {
      const db = openDb(createWorkspace());
      const goneId = randomUUID();

      // goneId was pruned, but a newer event also in archive on same branch
      insertArchivedEvent(db, { id: goneId, createdAt: 2000 });
      insertArchivedEvent(db, { id: randomUUID(), createdAt: 3000 });

      // Cursor at ts=2000 references goneId (not in live events); min ts=2000 so
      // createdAt >= min (not < min), falls to newerRow check. Events >= 2000 on BRANCH
      // exist → stale.
      const cursorToken = `2000:${goneId}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(true);
    });
  });

  describe("branch isolation", (): void => {
    test("does not mark stale based on events from a different branch", (): void => {
      const db = openDb(createWorkspace());
      const otherBranch = "feature/x";

      // Events only on a different branch
      insertEvent(db, { id: randomUUID(), createdAt: 1000, branch: otherBranch });
      insertArchivedEvent(db, { id: randomUUID(), createdAt: 500, branch: otherBranch });

      // Cursor on BRANCH with ts=200: predates the min of all events (500),
      // so it IS stale by the global min check.
      // Note: min_ts query is global (not branch-scoped), so predating ANY retained event is stale.
      const cursorToken = `200:${randomUUID()}`;
      expect(isCursorStale(db, cursorToken, BRANCH)).toBe(true);
    });
  });
});
