import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { DomainError } from "../domain/types";
import { BASE_SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";

const BACKUP_HINT = "Run 'trekoon migrate backup' to snapshot .trekoon/trekoon.db before any manual recovery.";

function migrationDownUnsupported(migrationName: string, version: number): DomainError {
  return new DomainError({
    code: "migration_down_unsupported",
    message:
      `Migration ${migrationName} is irreversible: rolling back below version ${version} is not supported. ` +
      `${BACKUP_HINT}`,
    details: {
      migrationName,
      version,
      backupCommand: "trekoon migrate backup",
    },
  });
}

const BASE_MIGRATION_VERSION = 1;
const BASE_MIGRATION_NAME = `0001_base_schema_v${SCHEMA_VERSION}`;
const LEGACY_BASE_MIGRATION_NAME_PATTERNS: readonly string[] = [
  "0001_base_schema_v*",
];

const BASE_ROLLBACK_STATEMENTS: readonly string[] = [
  "DROP TABLE IF EXISTS sync_conflicts;",
  "DROP TABLE IF EXISTS sync_cursors;",
  "DROP TABLE IF EXISTS git_context;",
  "DROP TABLE IF EXISTS events;",
  "DROP TABLE IF EXISTS dependencies;",
  "DROP TABLE IF EXISTS subtasks;",
  "DROP TABLE IF EXISTS tasks;",
  "DROP TABLE IF EXISTS epics;",
];

const INDEX_MIGRATION_UP_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);",
  "CREATE INDEX IF NOT EXISTS idx_events_git_branch ON events(git_branch);",
  "CREATE INDEX IF NOT EXISTS idx_events_created_at_id ON events(created_at, id);",
  "CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_id);",
  "CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on ON dependencies(depends_on_id);",
];

const INDEX_MIGRATION_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_events_created_at;",
  "DROP INDEX IF EXISTS idx_events_git_branch;",
  "DROP INDEX IF EXISTS idx_events_created_at_id;",
  "DROP INDEX IF EXISTS idx_dependencies_source;",
  "DROP INDEX IF EXISTS idx_dependencies_depends_on;",
];

const EVENT_ARCHIVE_MIGRATION_UP_STATEMENTS: readonly string[] = [
  `
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
  `,
  "CREATE INDEX IF NOT EXISTS idx_event_archive_created_at ON event_archive(created_at);",
];

const EVENT_ARCHIVE_MIGRATION_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_event_archive_created_at;",
  "DROP TABLE IF EXISTS event_archive;",
];

const LOOKUP_INDEX_MIGRATION_UP_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_dependencies_depends_on_kind ON dependencies(depends_on_id, depends_on_kind);",
  "CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner);",
  "CREATE INDEX IF NOT EXISTS idx_subtasks_owner ON subtasks(owner);",
  "CREATE INDEX IF NOT EXISTS idx_conflicts_resolution_updated_at ON sync_conflicts(resolution, updated_at);",
];

const LOOKUP_INDEX_MIGRATION_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_conflicts_resolution_updated_at;",
  "DROP INDEX IF EXISTS idx_subtasks_owner;",
  "DROP INDEX IF EXISTS idx_tasks_owner;",
  "DROP INDEX IF EXISTS idx_dependencies_depends_on_kind;",
];

const SYNC_SCALING_MIGRATION_UP_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_events_branch_cursor ON events(git_branch, created_at, id);",
  "CREATE INDEX IF NOT EXISTS idx_events_entity_branch_cursor ON events(entity_kind, entity_id, git_branch, created_at, id);",
  "CREATE INDEX IF NOT EXISTS idx_conflicts_resolution_entity_field_id ON sync_conflicts(resolution, entity_id, field_name, id);",
];

const SYNC_SCALING_MIGRATION_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_conflicts_resolution_entity_field_id;",
  "DROP INDEX IF EXISTS idx_events_entity_branch_cursor;",
  "DROP INDEX IF EXISTS idx_events_branch_cursor;",
];

const BOARD_IDEMPOTENCY_MIGRATION_UP_STATEMENTS: readonly string[] = [
  `
  CREATE TABLE IF NOT EXISTS board_idempotency_keys (
    scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'completed',
    response_status INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, idempotency_key)
  );
  `,
  "CREATE INDEX IF NOT EXISTS idx_board_idempotency_created_at ON board_idempotency_keys(created_at);",
];

const BOARD_IDEMPOTENCY_MIGRATION_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_board_idempotency_created_at;",
  "DROP TABLE IF EXISTS board_idempotency_keys;",
];

const BOARD_IDEMPOTENCY_RETENTION_INDEX_UP_STATEMENTS: readonly string[] = [
  "CREATE INDEX IF NOT EXISTS idx_board_idempotency_state_created_at ON board_idempotency_keys(state, created_at);",
];

const BOARD_IDEMPOTENCY_RETENTION_INDEX_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_board_idempotency_state_created_at;",
];

const SYNC_CONFLICTS_SCOPE_DOWN_STATEMENTS: readonly string[] = [
  "DROP INDEX IF EXISTS idx_sync_conflicts_scope_entity;",
  "DROP INDEX IF EXISTS idx_sync_conflicts_scope_resolution;",
];

function migrateSyncConflictsScope(db: Database): void {
  if (!tableExists(db, "sync_conflicts")) {
    return;
  }

  if (!tableHasColumn(db, "sync_conflicts", "worktree_path")) {
    db.exec("ALTER TABLE sync_conflicts ADD COLUMN worktree_path TEXT NOT NULL DEFAULT '';");
  }

  if (!tableHasColumn(db, "sync_conflicts", "current_branch")) {
    db.exec("ALTER TABLE sync_conflicts ADD COLUMN current_branch TEXT NOT NULL DEFAULT '';");
  }

  // Backfill legacy rows from the most-recent git_context entry so existing
  // pending conflicts remain reachable to the current worktree. Pre-existing
  // rows from peer worktrees (rare in practice — pre-fix the bug erased
  // them anyway) end up scoped to the current worktree's branch; this is a
  // best-effort migration since we have no historical context to recover.
  db.exec(`
    UPDATE sync_conflicts
    SET worktree_path = COALESCE(
      NULLIF(worktree_path, ''),
      (SELECT worktree_path FROM git_context ORDER BY updated_at DESC LIMIT 1),
      ''
    )
    WHERE worktree_path IS NULL OR worktree_path = '';
  `);

  db.exec(`
    UPDATE sync_conflicts
    SET current_branch = COALESCE(
      NULLIF(current_branch, ''),
      (SELECT branch_name FROM git_context ORDER BY updated_at DESC LIMIT 1),
      ''
    )
    WHERE current_branch IS NULL OR current_branch = '';
  `);

  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sync_conflicts_scope_entity ON sync_conflicts(worktree_path, current_branch, entity_kind, entity_id);",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_sync_conflicts_scope_resolution ON sync_conflicts(worktree_path, current_branch, resolution);",
  );
}

function tableHasColumn(db: Database, tableName: string, columnName: string): boolean {
  const columns = db.query(`PRAGMA table_info(${tableName});`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?;")
    .get(tableName) as { count: number } | null;
  return (row?.count ?? 0) > 0;
}

function migrateWorktreeScopedSyncMetadata(db: Database): void {
  if (!tableHasColumn(db, "git_context", "metadata_scope")) {
    db.exec("ALTER TABLE git_context ADD COLUMN metadata_scope TEXT NOT NULL DEFAULT 'worktree';");
  }

  db.exec("UPDATE git_context SET metadata_scope = 'worktree' WHERE metadata_scope IS NULL OR metadata_scope = ''; ");
  db.exec("UPDATE git_context SET id = worktree_path WHERE id = 'current' AND worktree_path <> ''; ");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_git_context_scope_path ON git_context(metadata_scope, worktree_path);");

  if (!tableHasColumn(db, "sync_cursors", "owner_scope")) {
    db.exec("ALTER TABLE sync_cursors ADD COLUMN owner_scope TEXT NOT NULL DEFAULT 'worktree';");
  }

  if (!tableHasColumn(db, "sync_cursors", "owner_worktree_path")) {
    db.exec("ALTER TABLE sync_cursors ADD COLUMN owner_worktree_path TEXT NOT NULL DEFAULT ''; ");
  }

  db.exec("UPDATE sync_cursors SET owner_scope = 'worktree' WHERE owner_scope IS NULL OR owner_scope = ''; ");
  db.exec(`
    UPDATE sync_cursors
    SET owner_worktree_path = COALESCE(
      NULLIF(owner_worktree_path, ''),
      (SELECT worktree_path FROM git_context ORDER BY updated_at DESC LIMIT 1),
      ''
    );
  `);
  db.exec("UPDATE sync_cursors SET id = owner_worktree_path || '::' || source_branch;");
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_cursors_owner ON sync_cursors(owner_scope, owner_worktree_path, source_branch);",
  );
}

function migrateBoardIdempotencyState(db: Database): void {
  if (!tableExists(db, "board_idempotency_keys")) {
    return;
  }

  if (!tableHasColumn(db, "board_idempotency_keys", "state")) {
    db.exec("ALTER TABLE board_idempotency_keys ADD COLUMN state TEXT NOT NULL DEFAULT 'completed';");
    db.exec("UPDATE board_idempotency_keys SET state = 'completed' WHERE state IS NULL OR state = ''; ");
    return;
  }

  const row = db
    .query(
      `
      SELECT COUNT(*) AS count
      FROM board_idempotency_keys
      WHERE state IS NULL OR state = '';
      `,
    )
    .get() as { count: number } | null;

  if ((row?.count ?? 0) > 0) {
    db.exec("UPDATE board_idempotency_keys SET state = 'completed' WHERE state IS NULL OR state = ''; ");
  }
}

interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: Database): void;
  down(db: Database): void;
}

interface AppliedMigrationRow {
  readonly version: number;
  readonly name: string;
  readonly applied_at: number;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly appliedAt: number;
}

export interface MigrationStatus {
  readonly currentVersion: number;
  readonly latestVersion: number;
  readonly applied: readonly AppliedMigration[];
  readonly pending: ReadonlyArray<{ version: number; name: string }>;
}

export interface RollbackSummary {
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly rolledBack: number;
  readonly rolledBackMigrations: readonly string[];
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: BASE_MIGRATION_VERSION,
    name: BASE_MIGRATION_NAME,
    up(db: Database): void {
      for (const statement of BASE_SCHEMA_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of BASE_ROLLBACK_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 2,
    name: "0002_sync_dependency_indexes",
    up(db: Database): void {
      for (const statement of INDEX_MIGRATION_UP_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of INDEX_MIGRATION_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 3,
    name: "0003_event_archive_retention",
    up(db: Database): void {
      for (const statement of EVENT_ARCHIVE_MIGRATION_UP_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of EVENT_ARCHIVE_MIGRATION_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 4,
    name: "0004_worktree_scoped_sync_metadata",
    up(db: Database): void {
      migrateWorktreeScopedSyncMetadata(db);
    },
    down(_db: Database): void {
      throw migrationDownUnsupported("0004_worktree_scoped_sync_metadata", 4);
    },
  },
  {
    version: 5,
    name: "0005_dependency_edge_integrity",
    up(db: Database): void {
      // Clean up orphaned dependency rows where source or target no longer exists.
      db.exec(`
        DELETE FROM dependencies
        WHERE source_id NOT IN (SELECT id FROM tasks UNION ALL SELECT id FROM subtasks)
           OR depends_on_id NOT IN (SELECT id FROM tasks UNION ALL SELECT id FROM subtasks);
      `);

      // Deduplicate any existing duplicate edges before creating the unique index.
      // Keep one arbitrary row per logical edge (MIN(id) is lexicographic, not chronological, but any survivor is equivalent).
      db.exec(`
        DELETE FROM dependencies
        WHERE id NOT IN (
          SELECT MIN(id) FROM dependencies
          GROUP BY source_id, depends_on_id
        );
      `);

      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_dependencies_edge ON dependencies (source_id, depends_on_id);");
    },
    down(_db: Database): void {
      throw migrationDownUnsupported("0005_dependency_edge_integrity", 5);
    },
  },
  {
    version: 6,
    name: "0006_add_owner_column",
    up(db: Database): void {
      if (!tableHasColumn(db, "tasks", "owner")) {
        db.exec("ALTER TABLE tasks ADD COLUMN owner TEXT;");
      }
      if (!tableHasColumn(db, "subtasks", "owner")) {
        db.exec("ALTER TABLE subtasks ADD COLUMN owner TEXT;");
      }
    },
    down(_db: Database): void {
      throw migrationDownUnsupported("0006_add_owner_column", 6);
    },
  },
  {
    version: 7,
    name: "0007_add_lookup_indexes",
    up(db: Database): void {
      for (const statement of LOOKUP_INDEX_MIGRATION_UP_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of LOOKUP_INDEX_MIGRATION_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 8,
    name: "0008_sync_scaling_indexes",
    up(db: Database): void {
      for (const statement of SYNC_SCALING_MIGRATION_UP_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of SYNC_SCALING_MIGRATION_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 9,
    name: "0009_board_idempotency_storage",
    up(db: Database): void {
      for (const statement of BOARD_IDEMPOTENCY_MIGRATION_UP_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of BOARD_IDEMPOTENCY_MIGRATION_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 10,
    name: "0010_board_idempotency_retention_index",
    up(db: Database): void {
      for (const statement of BOARD_IDEMPOTENCY_RETENTION_INDEX_UP_STATEMENTS) {
        db.exec(statement);
      }
    },
    down(db: Database): void {
      for (const statement of BOARD_IDEMPOTENCY_RETENTION_INDEX_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
  {
    version: 11,
    name: "0011_sync_conflicts_worktree_branch_scope",
    up(db: Database): void {
      migrateSyncConflictsScope(db);
    },
    down(db: Database): void {
      // Dropping columns requires a table rewrite in SQLite (PRAGMA) — not
      // strictly reversible without potential data loss. We drop the new
      // indexes; the columns persist with their default empty-string values
      // so a re-up no-ops cleanly.
      for (const statement of SYNC_CONFLICTS_SCOPE_DOWN_STATEMENTS) {
        db.exec(statement);
      }
    },
  },
];

function migrationTableExists(db: Database): boolean {
  const row = db
    .query(
      `
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations';
      `,
    )
    .get() as { count: number } | null;

  return (row?.count ?? 0) > 0;
}

function hasMigrationVersionColumn(db: Database): boolean {
  const columns = db.query("PRAGMA table_info(schema_migrations);").all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "version");
}

function ensureMigrationTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    );
  `);
}

function ensureMigrationVersionColumn(db: Database): void {
  if (!migrationTableExists(db) || hasMigrationVersionColumn(db)) {
    return;
  }

  db.exec("ALTER TABLE schema_migrations ADD COLUMN version INTEGER;");
  db.query("UPDATE schema_migrations SET version = ? WHERE version IS NULL AND name = ?;").run(BASE_MIGRATION_VERSION, BASE_MIGRATION_NAME);

  for (const legacyPattern of LEGACY_BASE_MIGRATION_NAME_PATTERNS) {
    db.query("UPDATE schema_migrations SET version = ? WHERE version IS NULL AND name GLOB ?;").run(
      BASE_MIGRATION_VERSION,
      legacyPattern,
    );
  }

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migrations_version ON schema_migrations(version);");

  const unresolvedRow = db
    .query(
      `
      SELECT COUNT(*) AS count
      FROM schema_migrations
      WHERE version IS NULL;
      `,
    )
    .get() as { count: number } | null;

  if ((unresolvedRow?.count ?? 0) > 0) {
    throw new Error(
      "Unable to infer one or more schema_migrations.version values during legacy upgrade. Repair schema_migrations entries manually so every row has a valid version, then rerun migrations.",
    );
  }
}

function validateMigrationPlan(): void {
  const seen = new Set<number>();

  for (let index = 0; index < MIGRATIONS.length; index += 1) {
    const migration: Migration = MIGRATIONS[index]!;

    if (migration.version !== index + 1) {
      throw new Error(`Migration versions must be contiguous from 1 (found ${migration.version} at index ${index}).`);
    }

    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}.`);
    }

    seen.add(migration.version);
  }
}

function runExclusive<T>(db: Database, operation: () => T): T {
  db.exec("BEGIN EXCLUSIVE TRANSACTION;");

  try {
    const result: T = operation();
    db.exec("COMMIT;");
    return result;
  } catch (error: unknown) {
    db.exec("ROLLBACK;");
    throw error;
  }
}

function currentVersion(db: Database): number {
  if (!migrationTableExists(db)) {
    return 0;
  }

  const row = db
    .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations;")
    .get() as { version: number } | null;

  return row?.version ?? 0;
}

function listAppliedMigrations(db: Database): AppliedMigrationRow[] {
  if (!migrationTableExists(db)) {
    return [];
  }

  return db
    .query(
      `
      SELECT version, name, applied_at
      FROM schema_migrations
      WHERE version IS NOT NULL
      ORDER BY version ASC;
      `,
    )
    .all() as AppliedMigrationRow[];
}

function migrationForVersion(version: number): Migration {
  const found = MIGRATIONS.find((migration) => migration.version === version);

  if (!found) {
    throw new Error(`No migration definition found for version ${version}.`);
  }

  return found;
}

function recordMigration(db: Database, migration: Migration): void {
  db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(
    migration.version,
    migration.name,
    Date.now(),
  );
}

/** Name of the marker file relative to the .trekoon storage directory. */
const MIGRATION_VERSION_MARKER_FILENAME = "migration-version";

/**
 * On-disk marker payload. The legacy v1 format was a bare integer. v2 stores a
 * JSON object so we can pin the marker to a content fingerprint of the DB
 * (PRAGMA user_version) instead of relying on filesystem mtimes — which the
 * old defensive check could not distinguish from a DB restored from a backup
 * with an older user_version but a newer mtime.
 */
interface MarkerPayload {
  readonly version: number;
  readonly userVersion: number;
}

/**
 * Derive the path to the migration-version marker file from the database
 * connection's filename. Returns null for in-memory databases.
 */
function resolveMarkerPath(db: Database): string | null {
  const dbFile: string = db.filename;
  if (!dbFile || dbFile === ":memory:") {
    return null;
  }
  return join(dirname(dbFile), MIGRATION_VERSION_MARKER_FILENAME);
}

/**
 * Read `PRAGMA user_version` from the connection. SQLite stores this as a
 * 32-bit signed integer in the database header — every restore-from-backup
 * naturally carries the original `user_version` along with the bytes.
 */
function readUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version;").get() as { user_version: number } | null;
  return row?.user_version ?? 0;
}

/**
 * Set `PRAGMA user_version`. Used as a content-stamp written inside the same
 * transaction that applies (or rolls back) migrations so the DB header is
 * always authoritative for the current schema state — independent of the
 * sidecar marker file.
 *
 * NOTE: PRAGMA does not support parameter binding. The caller must pass an
 * integer or a value that will throw at the SQL level otherwise.
 */
function setUserVersion(db: Database, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`PRAGMA user_version must be a non-negative integer (got ${version}).`);
  }
  db.exec(`PRAGMA user_version = ${version};`);
}

/**
 * Read the marker payload from disk. Falls back to parsing the legacy v1
 * format (bare integer) so previously-installed markers still work without a
 * cold reset.
 */
function readMarkerPayload(markerPath: string): MarkerPayload | null {
  try {
    if (!existsSync(markerPath)) {
      return null;
    }

    const raw: string = readFileSync(markerPath, "utf8").trim();
    if (raw.length === 0) {
      return null;
    }

    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as Partial<MarkerPayload>;
      const version: number | undefined = parsed.version;
      const userVersion: number | undefined = parsed.userVersion;
      if (
        typeof version !== "number" ||
        !Number.isFinite(version) ||
        version < 0 ||
        typeof userVersion !== "number" ||
        !Number.isFinite(userVersion) ||
        userVersion < 0
      ) {
        return null;
      }
      return { version, userVersion };
    }

    // Legacy v1 format: bare integer. Treat it as having no fingerprint;
    // returning userVersion: -1 forces canSkipProbeViaMarker to fall through
    // to the slow path, which then rewrites the marker in v2 form.
    const legacyVersion: number = parseInt(raw, 10);
    if (!Number.isFinite(legacyVersion) || legacyVersion < 0) {
      return null;
    }
    return { version: legacyVersion, userVersion: -1 };
  } catch {
    return null;
  }
}

/**
 * Read the migration version stored in the marker file. Returns null when the
 * file is absent, unreadable, or malformed. Kept for backwards-compatible
 * test/inspection use; the in-process fast-path uses {@link readMarkerPayload}.
 */
export function readMigrationVersionMarker(db: Database): number | null {
  const markerPath: string | null = resolveMarkerPath(db);
  if (!markerPath) {
    return null;
  }

  const payload: MarkerPayload | null = readMarkerPayload(markerPath);
  return payload?.version ?? null;
}

interface WriteMarkerResult {
  readonly written: boolean;
  readonly skipped: boolean;
}

/**
 * Internal marker writer that surfaces the outcome to callers. Writes
 * atomically via temp + rename. Returns `{written:false}` on filesystem
 * errors so callers (e.g. {@link rollbackDatabase}) can attempt a stale-marker
 * cleanup instead of silently leaving a misleading hint on disk.
 */
function writeMarkerPayload(
  db: Database,
  payload: MarkerPayload,
): WriteMarkerResult {
  const markerPath: string | null = resolveMarkerPath(db);
  if (!markerPath) {
    return { written: false, skipped: true };
  }

  try {
    mkdirSync(dirname(markerPath), { recursive: true });
    const tmpPath = `${markerPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(payload), "utf8");
    renameSync(tmpPath, markerPath);
    return { written: true, skipped: false };
  } catch {
    return { written: false, skipped: false };
  }
}

/**
 * Best-effort: remove a stale marker so the next cold start re-probes the
 * schema. Used when a fresh marker write fails after a rollback (or other
 * version-changing op) to avoid leaving the previous version's marker on disk
 * pointing at a now-incorrect schema state.
 */
function unlinkMarkerIfExists(db: Database): void {
  const markerPath: string | null = resolveMarkerPath(db);
  if (!markerPath) {
    return;
  }
  try {
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }
  } catch (error) {
    // Defense-in-depth — the worst case is that the next cold start spends
    // one extra schema probe noticing the marker mismatch. We surface the
    // failure at warn level (System Hardening 0.4.2, finding 30) so that
    // operators can spot recurring stale-marker issues without escalating
    // a one-off cleanup failure to a hard error.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[trekoon] failed to unlink stale schema marker at ${markerPath}: ${message}`,
    );
  }
}

/**
 * Write the migration version to the marker file atomically (temp + rename).
 * Public, backwards-compatible signature. Reads the current PRAGMA user_version
 * from the connection so fast-path consumers can verify the marker against the
 * DB header on the next call.
 */
export function writeMigrationVersionMarker(db: Database, version: number): void {
  const markerPath: string | null = resolveMarkerPath(db);
  if (!markerPath) {
    return;
  }
  const userVersion: number = readUserVersion(db);
  writeMarkerPayload(db, { version, userVersion });
}

/**
 * Determine whether the marker file allows skipping the schema probe query.
 * Returns true only when:
 *   1. The marker file exists, parses cleanly, and reports
 *      `version === LATEST_MIGRATION_VERSION`.
 *   2. The DB's PRAGMA user_version matches the marker's recorded user_version
 *      AND equals `LATEST_MIGRATION_VERSION`.
 *
 * The user_version match is the load-bearing freshness check — replacing the
 * previous mtime heuristic, which could not distinguish a DB restored from an
 * older backup (older user_version, fresh mtime) from a healthy current DB.
 * Restoring a backup brings the original user_version with the bytes, so the
 * pragma check naturally fails over to the slow path even when the marker
 * file is "newer" than the DB on disk.
 */
function canSkipProbeViaMarker(db: Database): boolean {
  const markerPath: string | null = resolveMarkerPath(db);
  if (!markerPath) {
    return false;
  }

  try {
    const payload: MarkerPayload | null = readMarkerPayload(markerPath);
    if (!payload) {
      return false;
    }

    if (payload.version !== LATEST_MIGRATION_VERSION) {
      return false;
    }

    if (payload.userVersion !== LATEST_MIGRATION_VERSION) {
      // Legacy v1 markers report userVersion: -1; force probe so the marker
      // gets rewritten in v2 form.
      return false;
    }

    const dbFile: string = db.filename;
    if (!dbFile || !existsSync(dbFile)) {
      return false;
    }

    const dbUserVersion: number = readUserVersion(db);
    return dbUserVersion === payload.userVersion;
  } catch {
    return false;
  }
}

function isSchemaCurrentFastPath(db: Database, latestVersion: number): boolean {
  if (latestVersion === 0 || !migrationTableExists(db) || !hasMigrationVersionColumn(db)) {
    return false;
  }

  const row = db
    .query(
      `
      SELECT
        COALESCE(MIN(version), 0) AS min_version,
        COALESCE(MAX(version), 0) AS max_version,
        COUNT(DISTINCT version) AS distinct_versions,
        SUM(CASE WHEN version IS NULL THEN 1 ELSE 0 END) AS null_versions
      FROM schema_migrations;
      `,
    )
    .get() as
    | {
        min_version: number;
        max_version: number;
        distinct_versions: number;
        null_versions: number;
      }
    | null;

  if (!row) {
    return false;
  }

  return (
    row.null_versions === 0 &&
    row.min_version === 1 &&
    row.max_version === latestVersion &&
    row.distinct_versions === latestVersion
  );
}

export function migrateDatabase(db: Database): void {
  validateMigrationPlan();

  const latestVersion: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

  // Marker fast path: skip ALL probe queries when the persisted marker file
  // records the latest version and is newer than the DB file. This saves the
  // schema_migrations SELECT on warm CLI starts.
  if (canSkipProbeViaMarker(db)) {
    migrateBoardIdempotencyState(db);
    return;
  }

  // Schema fast path: avoid BEGIN EXCLUSIVE when schema is already current.
  // This reduces startup lock contention while keeping the explicit
  // transactional migration path for non-current/legacy schemas.
  if (isSchemaCurrentFastPath(db, latestVersion)) {
    migrateBoardIdempotencyState(db);

    // Re-confirm the schema state under an EXCLUSIVE lock before stamping
    // the DB header. Without the lock, a concurrent rollback in another
    // process can interleave between the unlocked probe above and the
    // setUserVersion call below, leaving PRAGMA user_version pointing at a
    // higher version than schema_migrations actually reflects. If the
    // recheck disagrees we bail to the slow migrate path which will
    // re-apply any missing migrations transactionally.
    let fastPathConfirmed = false;
    runExclusive(db, (): void => {
      if (currentVersion(db) !== latestVersion) {
        return;
      }
      // Stamp the DB header inside the same exclusive transaction so the
      // user_version cannot diverge from schema_migrations on commit.
      // This also covers first runs after the v1 marker format upgrade and
      // restored-from-backup DBs whose schema_migrations happens to match
      // latest but whose user_version still trails.
      setUserVersion(db, latestVersion);
      fastPathConfirmed = true;
    });

    if (fastPathConfirmed) {
      // Persist the marker so the next cold start can short-circuit. The
      // marker is a sidecar hint — even if this write fails, the DB header
      // (stamped inside the tx above) remains authoritative.
      writeMigrationVersionMarker(db, latestVersion);
      return;
    }
    // Disagreement: fall through to the slow path below.
  }

  runExclusive(db, (): void => {
    ensureMigrationTable(db);
    ensureMigrationVersionColumn(db);

    // Backfill the legacy board_idempotency_keys.state column before running
    // any migrations so that later migrations (e.g. 0010's state-scoped index)
    // can assume the column exists on databases whose 0009 predates it.
    migrateBoardIdempotencyState(db);

    const version: number = currentVersion(db);

    for (const migration of MIGRATIONS) {
      if (migration.version <= version) {
        continue;
      }

      migration.up(db);
      recordMigration(db, migration);
    }

    // Stamp the DB header inside the same exclusive transaction so the
    // user_version cannot diverge from schema_migrations on commit.
    setUserVersion(db, latestVersion);
  });

  // Persist the new version so the next cold start can skip the probe.
  writeMigrationVersionMarker(db, latestVersion);
}

export const LATEST_MIGRATION_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Read the highest applied migration version from a database without mutating
 * it. Safe to call against a connection opened in `readonly: true` mode.
 * Returns 0 when the schema_migrations table does not exist or has no rows.
 */
export function readCurrentMigrationVersionReadOnly(db: Database): number {
  if (!migrationTableExists(db)) {
    return 0;
  }

  if (!hasMigrationVersionColumn(db)) {
    return 0;
  }

  const row = db
    .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations WHERE version IS NOT NULL;")
    .get() as { version: number } | null;

  return row?.version ?? 0;
}

export function describeMigrations(db: Database): MigrationStatus {
  ensureMigrationTable(db);
  ensureMigrationVersionColumn(db);
  migrateBoardIdempotencyState(db);
  validateMigrationPlan();

  const appliedRows: AppliedMigrationRow[] = listAppliedMigrations(db);
  const latestVersion: number = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  const activeVersion: number = appliedRows[appliedRows.length - 1]?.version ?? 0;
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  return {
    currentVersion: activeVersion,
    latestVersion,
    applied: appliedRows.map((row) => ({
      version: row.version,
      name: row.name,
      appliedAt: row.applied_at,
    })),
    pending: MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version)).map((migration) => ({
      version: migration.version,
      name: migration.name,
    })),
  };
}

export function rollbackDatabase(db: Database, targetVersion: number): RollbackSummary {
  if (!Number.isInteger(targetVersion) || targetVersion < 0) {
    throw new Error("Rollback target version must be a non-negative integer.");
  }

  const summary: RollbackSummary = runExclusive(db, (): RollbackSummary => {
    ensureMigrationTable(db);
    ensureMigrationVersionColumn(db);
    validateMigrationPlan();

    const fromVersion: number = currentVersion(db);
    if (targetVersion > fromVersion) {
      throw new Error(`Cannot roll back to version ${targetVersion}; current version is ${fromVersion}.`);
    }

    const appliedDescending = db
      .query(
        `
        SELECT version, name, applied_at
        FROM schema_migrations
        WHERE version IS NOT NULL AND version > ?
        ORDER BY version DESC;
        `,
      )
      .all(targetVersion) as AppliedMigrationRow[];

    const rolledBackMigrations: string[] = [];

    for (const row of appliedDescending) {
      const migration: Migration = migrationForVersion(row.version);
      migration.down(db);
      db.query("DELETE FROM schema_migrations WHERE version = ?;").run(row.version);
      rolledBackMigrations.push(migration.name);
    }

    // Stamp the DB header inside the rollback transaction so the
    // user_version is authoritative for the post-rollback schema state. If
    // the sidecar marker write below fails for any reason, the next
    // canSkipProbeViaMarker() check will see a stale marker.userVersion and
    // fall through to the slow probe path — no silent drift.
    setUserVersion(db, targetVersion);

    return {
      fromVersion,
      toVersion: targetVersion,
      rolledBack: appliedDescending.length,
      rolledBackMigrations,
    };
  });

  // Update the marker so the next start reflects the rolled-back version.
  // If the write fails, attempt to delete the now-stale marker so a future
  // cold start re-probes instead of trusting a marker that points at the
  // pre-rollback version.
  const markerPath: string | null = resolveMarkerPath(db);
  if (markerPath) {
    const userVersion: number = readUserVersion(db);
    const markerResult: WriteMarkerResult = writeMarkerPayload(db, {
      version: targetVersion,
      userVersion,
    });
    if (!markerResult.written && !markerResult.skipped) {
      unlinkMarkerIfExists(db);
    }
  }

  return summary;
}
