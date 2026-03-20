import { type Database } from "bun:sqlite";

import { writeTransaction } from "./database";

export const DEFAULT_EVENT_RETENTION_DAYS = 90;
const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export interface EventPruneOptions {
  readonly retentionDays?: number;
  readonly dryRun?: boolean;
  readonly archive?: boolean;
  readonly now?: number;
}

export interface EventPruneSummary {
  readonly retentionDays: number;
  readonly cutoffTimestamp: number;
  readonly dryRun: boolean;
  readonly archive: boolean;
  readonly candidateCount: number;
  readonly archivedCount: number;
  readonly deletedCount: number;
  readonly staleCursorCount: number;
}

function ensureArchiveTable(db: Database): void {
  db.exec(`
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
}

function assertRetentionDays(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("retentionDays must be a positive integer.");
  }

  return value;
}

function countCandidates(db: Database, cutoffTimestamp: number): number {
  const row = db.query("SELECT COUNT(*) AS count FROM events WHERE created_at < ?;").get(cutoffTimestamp) as
    | { count: number }
    | null;

  return row?.count ?? 0;
}

function oldestCursorTimestamp(db: Database): number | null {
  const row = db
    .query("SELECT MIN(last_event_at) AS oldest FROM sync_cursors WHERE last_event_at IS NOT NULL;")
    .get() as { oldest: number | null } | null;

  return row?.oldest ?? null;
}

function countStaleCursors(db: Database): number {
  // A cursor is stale when its last_event_at references a timestamp
  // that has no corresponding event remaining in the events table.
  // We detect this by checking if the oldest event in the table is
  // newer than the cursor's last_event_at.
  const oldestEventRow = db
    .query("SELECT MIN(created_at) AS oldest FROM events;")
    .get() as { oldest: number | null } | null;

  const oldestEventAt: number | null = oldestEventRow?.oldest ?? null;

  if (oldestEventAt === null) {
    // No events at all — any cursor with a last_event_at is stale.
    const row = db
      .query("SELECT COUNT(*) AS count FROM sync_cursors WHERE last_event_at IS NOT NULL;")
      .get() as { count: number } | null;
    return row?.count ?? 0;
  }

  const row = db
    .query(
      "SELECT COUNT(*) AS count FROM sync_cursors WHERE last_event_at IS NOT NULL AND last_event_at < ?;",
    )
    .get(oldestEventAt) as { count: number } | null;

  return row?.count ?? 0;
}

export function pruneEvents(db: Database, options: EventPruneOptions = {}): EventPruneSummary {
  const retentionDays: number = assertRetentionDays(options.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS);
  const dryRun: boolean = options.dryRun ?? false;
  const archive: boolean = options.archive ?? false;
  const now: number = options.now ?? Date.now();
  const retentionCutoff: number = now - retentionDays * DAY_IN_MILLISECONDS;

  // Guard: never prune events that a sync cursor still references.
  // The effective cutoff is the earlier of the retention cutoff and
  // the oldest cursor timestamp — so cursors always have replayable history.
  const oldest: number | null = oldestCursorTimestamp(db);
  const effectiveCutoff: number = oldest !== null ? Math.min(retentionCutoff, oldest) : retentionCutoff;

  const candidateCount: number = countCandidates(db, effectiveCutoff);
  const staleCursors: number = countStaleCursors(db);

  if (dryRun || candidateCount === 0) {
    return {
      retentionDays,
      cutoffTimestamp: effectiveCutoff,
      dryRun,
      archive,
      candidateCount,
      archivedCount: 0,
      deletedCount: 0,
      staleCursorCount: staleCursors,
    };
  }

  return db.transaction((): EventPruneSummary => {
    let archivedCount = 0;

    if (archive) {
      ensureArchiveTable(db);
      const archived = db
        .query(
          `
          INSERT INTO event_archive (
            id,
            entity_kind,
            entity_id,
            operation,
            payload,
            git_branch,
            git_head,
            created_at,
            updated_at,
            version
          )
          SELECT
            id,
            entity_kind,
            entity_id,
            operation,
            payload,
            git_branch,
            git_head,
            created_at,
            updated_at,
            version
          FROM events
          WHERE created_at < ?
          ON CONFLICT(id) DO UPDATE SET
            entity_kind = excluded.entity_kind,
            entity_id = excluded.entity_id,
            operation = excluded.operation,
            payload = excluded.payload,
            git_branch = excluded.git_branch,
            git_head = excluded.git_head,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            version = excluded.version;
          `,
        )
        .run(effectiveCutoff);

      archivedCount = archived.changes;
    }

    const deleted = db.query("DELETE FROM events WHERE created_at < ?;").run(effectiveCutoff);

    return {
      retentionDays,
      cutoffTimestamp: effectiveCutoff,
      dryRun,
      archive,
      candidateCount,
      archivedCount,
      deletedCount: deleted.changes,
      staleCursorCount: staleCursors,
    };
  })();
}
