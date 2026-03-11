import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { Database } from "bun:sqlite";

import { migrateDatabase } from "./migrations";
import { resolveStoragePaths, type StoragePaths } from "./path";

export interface StorageResolutionDiagnostics {
  readonly invocationCwd: string;
  readonly storageMode: StoragePaths["storageMode"];
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly databaseFile: string;
  readonly legacyStateDetected: boolean;
  readonly recoveryRequired: boolean;
}

export interface TrekoonDatabase {
  readonly db: Database;
  readonly paths: StoragePaths;
  readonly diagnostics: StorageResolutionDiagnostics;
  close(): void;
}

export interface OpenTrekoonDatabaseOptions {
  readonly autoMigrate?: boolean;
}

export function openTrekoonDatabase(
  workingDirectory: string = process.cwd(),
  options: OpenTrekoonDatabaseOptions = {},
): TrekoonDatabase {
  const paths: StoragePaths = resolveStoragePaths(workingDirectory);
  const legacyDatabaseFile: string = resolve(paths.worktreeRoot, ".trekoon", "trekoon.db");
  const legacyStateDetected: boolean =
    legacyDatabaseFile !== paths.databaseFile && existsSync(legacyDatabaseFile);
  const recoveryRequired: boolean = legacyStateDetected && !existsSync(paths.databaseFile);
  const diagnostics: StorageResolutionDiagnostics = {
    invocationCwd: paths.invocationCwd,
    storageMode: paths.storageMode,
    repoCommonDir: paths.repoCommonDir,
    worktreeRoot: paths.worktreeRoot,
    sharedStorageRoot: paths.sharedStorageRoot,
    databaseFile: paths.databaseFile,
    legacyStateDetected,
    recoveryRequired,
  };

  mkdirSync(paths.storageDir, { recursive: true });

  const db: Database = new Database(paths.databaseFile, { create: true });

  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  if (options.autoMigrate ?? true) {
    migrateDatabase(db);
  }

  return {
    db,
    paths,
    diagnostics,
    close(): void {
      db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      db.close(false);
    },
  };
}
