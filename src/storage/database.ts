import { mkdirSync } from "node:fs";

import { Database } from "bun:sqlite";

import { DomainError } from "../domain/types";
import { migrateDatabase } from "./migrations";
import { resolveStoragePaths, type StoragePaths } from "./path";
import {
  inspectWorktreeDatabaseState,
  recoverWorktreeDatabaseState,
  type WorktreeRecoveryDiagnostics,
} from "./worktree-recovery";

export interface StorageResolutionDiagnostics {
  readonly invocationCwd: string;
  readonly storageMode: StoragePaths["storageMode"];
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly databaseFile: string;
  readonly legacyStateDetected: boolean;
  readonly recoveryRequired: boolean;
  readonly recoveryStatus: WorktreeRecoveryDiagnostics["status"];
  readonly legacyDatabaseFiles: readonly string[];
  readonly backupFiles: readonly string[];
  readonly trackedStorageFiles: readonly string[];
  readonly autoMigratedLegacyState: boolean;
  readonly importedFromLegacyDatabase: string | null;
  readonly operatorAction: string;
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

function buildStorageResolutionDiagnostics(
  paths: StoragePaths,
  recovery: WorktreeRecoveryDiagnostics,
): StorageResolutionDiagnostics {
  const legacyStateDetected: boolean = recovery.legacyDatabaseFiles.length > 0;
  const recoveryRequired: boolean =
    recovery.status === "ambiguous_recovery" || recovery.status === "tracked_ignored_mismatch";

  return {
    invocationCwd: paths.invocationCwd,
    storageMode: paths.storageMode,
    repoCommonDir: paths.repoCommonDir,
    worktreeRoot: paths.worktreeRoot,
    sharedStorageRoot: paths.sharedStorageRoot,
    databaseFile: paths.databaseFile,
    legacyStateDetected,
    recoveryRequired,
    recoveryStatus: recovery.status,
    legacyDatabaseFiles: recovery.legacyDatabaseFiles,
    backupFiles: recovery.backupFiles,
    trackedStorageFiles: recovery.trackedStorageFiles,
    autoMigratedLegacyState: recovery.autoMigrated,
    importedFromLegacyDatabase: recovery.importedFrom,
    operatorAction: recovery.operatorAction,
  };
}

export function resolveStorageResolutionDiagnostics(
  workingDirectory: string = process.cwd(),
): StorageResolutionDiagnostics {
  const paths: StoragePaths = resolveStoragePaths(workingDirectory);

  try {
    return buildStorageResolutionDiagnostics(paths, inspectWorktreeDatabaseState(paths));
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }

    const details: Record<string, unknown> = error.details ?? {};
    const recovery: WorktreeRecoveryDiagnostics = {
      status: (details.status as WorktreeRecoveryDiagnostics["status"] | undefined) ?? "no_legacy_state",
      legacyDatabaseFiles: Array.isArray(details.legacyDatabaseFiles)
        ? (details.legacyDatabaseFiles as string[])
        : [],
      backupFiles: Array.isArray(details.backupFiles) ? (details.backupFiles as string[]) : [],
      trackedStorageFiles: Array.isArray(details.trackedStorageFiles)
        ? (details.trackedStorageFiles as string[])
        : [],
      autoMigrated: details.autoMigrated === true,
      importedFrom: typeof details.importedFrom === "string" ? details.importedFrom : null,
      operatorAction: typeof details.operatorAction === "string" ? details.operatorAction : error.message,
    };

    return buildStorageResolutionDiagnostics(paths, recovery);
  }
}

export function openTrekoonDatabase(
  workingDirectory: string = process.cwd(),
  options: OpenTrekoonDatabaseOptions = {},
): TrekoonDatabase {
  const paths: StoragePaths = resolveStoragePaths(workingDirectory);
  const recovery: WorktreeRecoveryDiagnostics = recoverWorktreeDatabaseState(paths);
  const diagnostics: StorageResolutionDiagnostics = buildStorageResolutionDiagnostics(paths, recovery);

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
