import { Database } from "bun:sqlite";

import { BASE_SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";

const BASE_MIGRATION_VERSION = 1;
const BASE_MIGRATION_NAME = `0001_base_schema_v${SCHEMA_VERSION}`;

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
  db.query("UPDATE schema_migrations SET version = ? WHERE version IS NULL AND name = ?;").run(
    BASE_MIGRATION_VERSION,
    BASE_MIGRATION_NAME,
  );
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_migrations_version ON schema_migrations(version);");
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

export function migrateDatabase(db: Database): void {
  runExclusive(db, (): void => {
    ensureMigrationTable(db);
    ensureMigrationVersionColumn(db);
    validateMigrationPlan();

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
