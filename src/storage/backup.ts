import { existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { DomainError } from "../domain/types";
import { LATEST_MIGRATION_VERSION } from "./migrations";
import { resolveStoragePaths } from "./path";

export interface MigrateBackupResult {
  readonly backupPath: string;
  readonly bytes: number;
  readonly migrationVersion: number;
  readonly latestVersion: number;
  readonly timestamp: string;
}

function isoTimestampForFilename(now: Date): string {
  // ISO 8601 with colons replaced for filesystem-safe use across macOS/Linux/Windows.
  // Example input: 2026-05-02T13:45:30.123Z -> 2026-05-02T13-45-30-123Z
  return now.toISOString().replace(/[:.]/gu, "-");
}

function quoteForVacuumInto(filePath: string): string {
  // SQLite path literal: wrap in single quotes and escape embedded single quotes by doubling.
  return `'${filePath.replace(/'/gu, "''")}'`;
}

interface CreateMigrationBackupOptions {
  readonly cwd: string;
  readonly now?: Date;
}

export function createMigrationBackup(options: CreateMigrationBackupOptions): MigrateBackupResult {
  const cwd: string = options.cwd;
  const now: Date = options.now ?? new Date();
  const storagePaths = resolveStoragePaths(cwd);
  const databaseFile: string = storagePaths.databaseFile;

  if (!existsSync(databaseFile)) {
    throw new DomainError({
      code: "backup_database_missing",
      message: `Cannot back up Trekoon database: ${databaseFile} does not exist. Run 'trekoon init' first.`,
      details: { databaseFile },
    });
  }

  const timestamp: string = isoTimestampForFilename(now);
  const storageDir: string = dirname(databaseFile);
  const backupFilename = `trekoon.db.backup-${timestamp}`;
  const backupPath: string = resolve(storageDir, backupFilename);

  if (existsSync(backupPath)) {
    throw new DomainError({
      code: "backup_already_exists",
      message: `Backup already exists at ${backupPath}. Wait at least one second between backups.`,
      details: { backupPath },
    });
  }

  // VACUUM INTO writes a fully-consistent snapshot at a single transaction
  // boundary, including any uncommitted WAL state once the read transaction
  // is taken. This is the SQLite-recommended way to atomically clone a DB.
  const sourceDb = new Database(databaseFile, { readonly: true });
  let migrationVersion = 0;
  let latestVersion = 0;
  try {
    const status = describeMigrations(sourceDb);
    migrationVersion = status.currentVersion;
    latestVersion = status.latestVersion;
    sourceDb.exec(`VACUUM INTO ${quoteForVacuumInto(backupPath)};`);
  } finally {
    sourceDb.close(false);
  }

  const stats = statSync(backupPath);

  return {
    backupPath,
    bytes: stats.size,
    migrationVersion,
    latestVersion,
    timestamp,
  };
}
