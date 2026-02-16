import { mkdirSync } from "node:fs";

import { Database } from "bun:sqlite";

import { migrateDatabase } from "./migrations";
import { resolveStoragePaths, type StoragePaths } from "./path";

export interface TrekoonDatabase {
  readonly db: Database;
  readonly paths: StoragePaths;
  close(): void;
}

export function openTrekoonDatabase(workingDirectory: string = process.cwd()): TrekoonDatabase {
  const paths: StoragePaths = resolveStoragePaths(workingDirectory);

  mkdirSync(paths.storageDir, { recursive: true });

  const db: Database = new Database(paths.databaseFile, { create: true });

  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  migrateDatabase(db);

  return {
    db,
    paths,
    close(): void {
      db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      db.close(false);
    },
  };
}
