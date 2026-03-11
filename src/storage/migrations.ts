import { Database } from "bun:sqlite";

import { BASE_SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";

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

function tableHasColumn(db: Database, tableName: string, columnName: string): boolean {
  const columns = db.query(`PRAGMA table_info(${tableName});`).all() as Array<{ name: string }>;
  return columns.some((column) => column.name === columnName);
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
    down(db: Database): void {
      db.exec("DROP INDEX IF EXISTS idx_sync_cursors_owner;");
      db.exec("DROP INDEX IF EXISTS idx_git_context_scope_path;");
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

  // Fast path: avoid BEGIN EXCLUSIVE when schema is already current.
  // This reduces startup lock contention while keeping the explicit
  // transactional migration path for non-current/legacy schemas.
  if (isSchemaCurrentFastPath(db, latestVersion)) {
    return;
  }

  runExclusive(db, (): void => {
    ensureMigrationTable(db);
    ensureMigrationVersionColumn(db);

    const version: number = currentVersion(db);

    for (const migration of MIGRATIONS) {
      if (migration.version <= version) {
        continue;
      }

      migration.up(db);
      recordMigration(db, migration);
    }
  });
}

export function describeMigrations(db: Database): MigrationStatus {
  ensureMigrationTable(db);
  ensureMigrationVersionColumn(db);
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

  return runExclusive(db, (): RollbackSummary => {
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

    return {
      fromVersion,
      toVersion: targetVersion,
      rolledBack: appliedDescending.length,
      rolledBackMigrations,
    };
  });
}
