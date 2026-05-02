import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runMigrate } from "../../src/commands/migrate";
import { DomainError } from "../../src/domain/types";
import { createMigrationBackup } from "../../src/storage/backup";
import { openTrekoonDatabase } from "../../src/storage/database";
import {
  LATEST_MIGRATION_VERSION,
  migrateDatabase,
  readCurrentMigrationVersionReadOnly,
  rollbackDatabase,
} from "../../src/storage/migrations";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-migrations-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

function listBackups(workspace: string): string[] {
  const storageDir = join(workspace, ".trekoon");
  if (!existsSync(storageDir)) {
    return [];
  }
  return readdirSync(storageDir).filter((entry) => entry.startsWith("trekoon.db.backup-"));
}

describe("storage migrations: down() v4-v6", (): void => {
  test("rollback below v4 throws DomainError with migration_down_unsupported and backup hint", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      let caught: unknown;
      try {
        rollbackDatabase(storage.db, 3);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      const domainError = caught as DomainError;
      expect(domainError.code).toBe("migration_down_unsupported");
      expect(domainError.message).toMatch(/irreversible/i);
      expect(domainError.message).toContain("trekoon migrate backup");
      expect(domainError.details?.backupCommand).toBe("trekoon migrate backup");
    } finally {
      storage.close();
    }
  });

  test("rollback below v5 throws DomainError referencing the backup command", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      let caught: unknown;
      try {
        rollbackDatabase(storage.db, 4);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      const domainError = caught as DomainError;
      expect(domainError.code).toBe("migration_down_unsupported");
      expect(domainError.details?.migrationName).toBe("0005_dependency_edge_integrity");
      expect(domainError.message).toContain("trekoon migrate backup");
    } finally {
      storage.close();
    }
  });

  test("rollback below v6 throws DomainError referencing the backup command", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      let caught: unknown;
      try {
        rollbackDatabase(storage.db, 5);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      const domainError = caught as DomainError;
      expect(domainError.code).toBe("migration_down_unsupported");
      expect(domainError.details?.migrationName).toBe("0006_add_owner_column");
      expect(domainError.message).toContain("trekoon migrate backup");
    } finally {
      storage.close();
    }
  });
});

describe("storage backup: createMigrationBackup", (): void => {
  test("creates a timestamped sibling backup file inside .trekoon", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const databasePath: string = storage.paths.databaseFile;
    storage.close();

    const result = createMigrationBackup({ cwd: workspace });

    expect(result.backupPath).toMatch(/\.trekoon\/trekoon\.db\.backup-\d{4}-\d{2}-\d{2}T/u);
    expect(existsSync(result.backupPath)).toBe(true);
    expect(statSync(result.backupPath).isFile()).toBe(true);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.migrationVersion).toBe(LATEST_MIGRATION_VERSION);
    expect(result.latestVersion).toBe(LATEST_MIGRATION_VERSION);
    expect(databasePath).toMatch(/\.trekoon\/trekoon\.db$/u);
    expect(result.backupPath.startsWith(join(workspace, ".trekoon"))).toBe(true);
  });

  test("backup is a valid SQLite database with all schema_migrations rows", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = createMigrationBackup({ cwd: workspace });

    const backup = new Database(result.backupPath, { readonly: true });
    try {
      const version: number = readCurrentMigrationVersionReadOnly(backup);
      expect(version).toBe(LATEST_MIGRATION_VERSION);

      const epicTable = backup
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='epics';")
        .get() as { name: string } | null;
      expect(epicTable?.name).toBe("epics");
    } finally {
      backup.close(false);
    }
  });

  test("two consecutive backups produce distinct files when timestamps differ", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const first = createMigrationBackup({ cwd: workspace, now: new Date("2026-05-02T13:45:30.123Z") });
    const second = createMigrationBackup({ cwd: workspace, now: new Date("2026-05-02T13:45:31.456Z") });

    expect(first.backupPath).not.toBe(second.backupPath);
    expect(existsSync(first.backupPath)).toBe(true);
    expect(existsSync(second.backupPath)).toBe(true);
    expect(listBackups(workspace).length).toBe(2);
  });

  test("rejects backup when target file already exists at the same timestamp", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const fixedTimestamp = new Date("2026-05-02T13:45:30.123Z");
    createMigrationBackup({ cwd: workspace, now: fixedTimestamp });

    let caught: unknown;
    try {
      createMigrationBackup({ cwd: workspace, now: fixedTimestamp });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("backup_already_exists");
  });

  test("rejects backup when the database file is missing", (): void => {
    const workspace: string = createWorkspace();
    // Do not initialize storage. The DB file should be absent.
    const databaseFile: string = resolveStoragePaths(workspace).databaseFile;
    expect(existsSync(databaseFile)).toBe(false);

    let caught: unknown;
    try {
      createMigrationBackup({ cwd: workspace });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    expect((caught as DomainError).code).toBe("backup_database_missing");
  });

  test("does not mutate the live database (no migration writes during backup)", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const databaseFile: string = resolveStoragePaths(workspace).databaseFile;
    const before: number = statSync(databaseFile).mtimeMs;

    // Wait a few ms so any mtime change would be observable on most filesystems.
    const wait = (): Promise<void> => new Promise((r) => setTimeout(r, 50));
    return wait().then((): void => {
      createMigrationBackup({ cwd: workspace });
      const after: number = statSync(databaseFile).mtimeMs;
      // Backup is a pure read on the source via VACUUM INTO; mtime should be unchanged.
      expect(after).toBe(before);
    });
  });

  test("migrateDatabase succeeds after a backup has been taken", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    createMigrationBackup({ cwd: workspace });

    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    const db = new Database(databasePath);
    try {
      expect((): void => migrateDatabase(db)).not.toThrow();
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });
});

describe("migrate backup CLI", (): void => {
  test("subcommand snapshots the DB and reports machine-readable result", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["backup"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("migrate.backup");

    const data = result.data as {
      backupPath: string;
      bytes: number;
      migrationVersion: number;
      latestVersion: number;
      timestamp: string;
    };

    expect(data.backupPath).toMatch(/\.trekoon\/trekoon\.db\.backup-/u);
    expect(existsSync(data.backupPath)).toBe(true);
    expect(data.bytes).toBeGreaterThan(0);
    expect(data.migrationVersion).toBe(LATEST_MIGRATION_VERSION);
    expect(data.latestVersion).toBe(LATEST_MIGRATION_VERSION);
    expect(data.timestamp.length).toBeGreaterThan(0);
  });

  test("subcommand rejects unknown options", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["backup", "--bogus", "x"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("unknown_option");
  });

  test("subcommand fails cleanly when DB is missing", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    // Do not initialize.

    const result = await runMigrate({
      args: ["backup"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("backup_database_missing");
  });
});
