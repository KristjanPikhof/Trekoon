import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { Database } from "bun:sqlite";

import { DomainError } from "../domain/types";
import { LATEST_MIGRATION_VERSION, readCurrentMigrationVersionReadOnly } from "./migrations";
import { resolveStoragePaths } from "./path";

export interface MigrateBackupResult {
  readonly backupPath: string;
  readonly bytes: number;
  readonly migrationVersion: number;
  readonly latestVersion: number;
  readonly timestamp: string;
  readonly retainedCount: number;
  readonly prunedPaths: readonly string[];
}

/** Default retention count when --retain is not provided. */
export const DEFAULT_BACKUP_RETENTION = 10;

/** Filename prefix shared by every backup snapshot. */
const BACKUP_FILENAME_PREFIX = "trekoon.db.backup-";

function isoTimestampForFilename(now: Date): string {
  // ISO 8601 with colons and dots replaced for filesystem-safe use across
  // macOS/Linux/Windows. Resolution is millisecond-precise so two backups in
  // the same second still produce distinct filenames.
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
  /**
   * Maximum number of timestamped backup siblings to retain (including the
   * one being created). Older snapshots are pruned. Defaults to
   * {@link DEFAULT_BACKUP_RETENTION}. Pass `Infinity` or any non-positive
   * number to disable pruning.
   */
  readonly retain?: number;
}

interface ListedBackup {
  readonly filename: string;
  readonly fullPath: string;
}

function listExistingBackups(storageDir: string): ListedBackup[] {
  if (!existsSync(storageDir)) {
    return [];
  }

  return readdirSync(storageDir)
    .filter((entry) => entry.startsWith(BACKUP_FILENAME_PREFIX))
    .map((entry) => ({ filename: entry, fullPath: resolve(storageDir, entry) }));
}

function pruneOlderBackups(storageDir: string, keepCount: number): string[] {
  if (!Number.isFinite(keepCount) || keepCount <= 0) {
    return [];
  }

  const existing = listExistingBackups(storageDir);
  if (existing.length <= keepCount) {
    return [];
  }

  // Filename suffix is a millisecond-precise ISO timestamp, so a lexicographic
  // sort is equivalent to chronological order. Most-recent first.
  const sorted = [...existing].sort((left, right) => {
    if (left.filename < right.filename) {
      return 1;
    }
    if (left.filename > right.filename) {
      return -1;
    }
    return 0;
  });

  const toPrune = sorted.slice(keepCount);
  const pruned: string[] = [];

  for (const candidate of toPrune) {
    try {
      unlinkSync(candidate.fullPath);
      pruned.push(candidate.fullPath);
    } catch {
      // Best-effort prune: a transient unlink failure (concurrent backup,
      // permissions, etc.) must not abort the surrounding backup operation.
    }
  }

  return pruned;
}

export function createMigrationBackup(options: CreateMigrationBackupOptions): MigrateBackupResult {
  const cwd: string = options.cwd;
  const now: Date = options.now ?? new Date();
  const retainRaw: number = options.retain ?? DEFAULT_BACKUP_RETENTION;
  const retainCount: number =
    Number.isFinite(retainRaw) && retainRaw > 0 ? Math.floor(retainRaw) : Number.POSITIVE_INFINITY;
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
  const backupFilename = `${BACKUP_FILENAME_PREFIX}${timestamp}`;
  const backupPath: string = resolve(storageDir, backupFilename);

  if (existsSync(backupPath)) {
    throw new DomainError({
      code: "backup_already_exists",
      message:
        `Backup already exists at ${backupPath}. ` +
        `Backup filenames are millisecond-precise; two backups can only collide ` +
        `when the same explicit timestamp is reused. Wait at least one millisecond ` +
        `between backups or pass a distinct now/timestamp.`,
      details: { backupPath },
    });
  }

  // VACUUM INTO writes a fully-consistent snapshot at a single transaction
  // boundary, including any uncommitted WAL state once the read transaction
  // is taken. This is the SQLite-recommended way to atomically clone a DB.
  // Open read-only so we never mutate the live DB while snapshotting.
  const sourceDb = new Database(databaseFile, { readonly: true });
  let migrationVersion = 0;
  const latestVersion: number = LATEST_MIGRATION_VERSION;
  try {
    migrationVersion = readCurrentMigrationVersionReadOnly(sourceDb);
    sourceDb.exec(`VACUUM INTO ${quoteForVacuumInto(backupPath)};`);
  } finally {
    sourceDb.close(false);
  }

  const stats = statSync(backupPath);

  const prunedPaths: readonly string[] = pruneOlderBackups(storageDir, retainCount);
  const retainedCount: number = listExistingBackups(storageDir).length;

  return {
    backupPath,
    bytes: stats.size,
    migrationVersion,
    latestVersion,
    timestamp,
    retainedCount,
    prunedPaths,
  };
}
