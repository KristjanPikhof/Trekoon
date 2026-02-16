import { Database } from "bun:sqlite";

import { BASE_SCHEMA_STATEMENTS, SCHEMA_VERSION } from "./schema";

const BASE_MIGRATION_NAME = `0001_base_schema_v${SCHEMA_VERSION}`;

function hasMigration(db: Database, name: string): boolean {
  const migrationTableExists: { count: number } | null = db
    .query(
      `
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations';
      `,
    )
    .get() as { count: number } | null;

  if (!migrationTableExists || migrationTableExists.count === 0) {
    return false;
  }

  const row: { count: number } | null = db
    .query("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?;")
    .get(name) as { count: number } | null;

  return Boolean(row && row.count > 0);
}

export function migrateDatabase(db: Database): void {
  if (hasMigration(db, BASE_MIGRATION_NAME)) {
    return;
  }

  const now: number = Date.now();

  db.transaction((): void => {
    for (const statement of BASE_SCHEMA_STATEMENTS) {
      db.exec(statement);
    }

    db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?);").run(
      BASE_MIGRATION_NAME,
      now,
    );
  })();
}
