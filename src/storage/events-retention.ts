import { type Database } from "bun:sqlite";

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

export function pruneEvents(db: Database, options: EventPruneOptions = {}): EventPruneSummary {
  const retentionDays: number = assertRetentionDays(options.retentionDays ?? DEFAULT_EVENT_RETENTION_DAYS);
  const dryRun: boolean = options.dryRun ?? false;
  const archive: boolean = options.archive ?? false;
  const now: number = options.now ?? Date.now();
  const cutoffTimestamp: number = now - retentionDays * DAY_IN_MILLISECONDS;
  const candidateCount: number = countCandidates(db, cutoffTimestamp);

  if (dryRun || candidateCount === 0) {
    return {
      retentionDays,
      cutoffTimestamp,
      dryRun,
      archive,
      candidateCount,
      archivedCount: 0,
      deletedCount: 0,
    };
  }

  return db.transaction((): EventPruneSummary => {
    let archivedCount = 0;

    if (archive) {
      ensureArchiveTable(db);
      const archived = db
        .query(
          `
          INSERT OR IGNORE INTO event_archive (
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
          WHERE created_at < ?;
          `,
        )
        .run(cutoffTimestamp);

      archivedCount = archived.changes;
    }

    const deleted = db.query("DELETE FROM events WHERE created_at < ?;").run(cutoffTimestamp);

    return {
      retentionDays,
      cutoffTimestamp,
      dryRun,
      archive,
      candidateCount,
      archivedCount,
      deletedCount: deleted.changes,
    };
  })();
}
