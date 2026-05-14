import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  readMigrationVersionMarker,
  runExclusive,
  rollbackDatabase,
  writeMigrationVersionMarker,
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

describe("storage migrations: exclusive transaction errors", (): void => {
  test("rollback failure preserves the original migration error as the thrown error", (): void => {
    const db = new Database(":memory:");
    const originalExec = db.exec.bind(db);
    const migrationError = new Error("original migration failure");
    const rollbackFailure = new Error("forced rollback failure");

    try {
      let rollbackAttempts = 0;
      (db as unknown as { exec: (sql: string) => void }).exec = (sql: string): void => {
        if (sql === "ROLLBACK;") {
          rollbackAttempts += 1;
          throw rollbackFailure;
        }
        originalExec(sql);
      };

      let caught: unknown;
      try {
        runExclusive(db, (): void => {
          throw migrationError;
        });
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBe(migrationError);
      expect((caught as Error).message).toBe("original migration failure");
      expect((caught as Error).cause).toBe(rollbackFailure);
      expect(rollbackAttempts).toBe(1);
    } finally {
      db.close();
    }
  });
});

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

  test("rollback to v5 first hits the v6 down() guard (descending order)", (): void => {
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
      // Rollback walks descending; the first irreversible guard is v6.
      expect(domainError.details?.migrationName).toBe("0006_add_owner_column");
      expect(domainError.message).toContain("trekoon migrate backup");
    } finally {
      storage.close();
    }
  });

  test("v5 down() guard fires when only v5 sits above the target", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      // Manually drop schema_migrations rows for versions 6+ so the next
      // rollback walk hits 0005's guard first instead of 0006's.
      storage.db.exec("DELETE FROM schema_migrations WHERE version >= 6;");

      let caught: unknown;
      try {
        rollbackDatabase(storage.db, 4);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).details?.migrationName).toBe("0005_dependency_edge_integrity");
      expect((caught as DomainError).message).toContain("trekoon migrate backup");
    } finally {
      storage.close();
    }
  });

  test("v4 down() guard fires when only v4 sits above the target", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      storage.db.exec("DELETE FROM schema_migrations WHERE version >= 5;");

      let caught: unknown;
      try {
        rollbackDatabase(storage.db, 3);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(DomainError);
      expect((caught as DomainError).details?.migrationName).toBe("0004_worktree_scoped_sync_metadata");
      expect((caught as DomainError).message).toContain("trekoon migrate backup");
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
    const domainError = caught as DomainError;
    expect(domainError.code).toBe("backup_already_exists");
    // Collision message must reflect millisecond filename resolution, not
    // the legacy "wait one second" wording.
    expect(domainError.message).toMatch(/millisecond/iu);
    expect(domainError.message).not.toMatch(/wait at least one second/iu);
  });

  test("retain keeps only the last N backups and prunes older siblings", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const baseMs: number = new Date("2026-05-02T13:45:30.000Z").getTime();
    // Take 7 timestamped backups, retaining 5. Two oldest must be pruned.
    for (let i = 0; i < 7; i += 1) {
      createMigrationBackup({
        cwd: workspace,
        now: new Date(baseMs + i * 1000),
        retain: 5,
      });
    }

    const remaining = listBackups(workspace).sort();
    expect(remaining.length).toBe(5);
    // The 5 newest (indexes 2..6) must be the retained set.
    const expectedSuffixes = [2, 3, 4, 5, 6].map((i): string => {
      return new Date(baseMs + i * 1000).toISOString().replace(/[:.]/gu, "-");
    });
    for (const suffix of expectedSuffixes) {
      expect(remaining.some((entry) => entry.includes(suffix))).toBe(true);
    }
  });

  test("retain default is 10", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const baseMs: number = new Date("2026-05-02T13:45:30.000Z").getTime();
    for (let i = 0; i < 12; i += 1) {
      createMigrationBackup({
        cwd: workspace,
        now: new Date(baseMs + i * 1000),
      });
    }

    expect(listBackups(workspace).length).toBe(10);
  });

  test("retain reports retainedCount and prunedPaths", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const baseMs: number = new Date("2026-05-02T13:45:30.000Z").getTime();
    // Pre-populate three backups outside the retention window.
    for (let i = 0; i < 3; i += 1) {
      createMigrationBackup({
        cwd: workspace,
        now: new Date(baseMs + i * 1000),
        retain: 100,
      });
    }

    const result = createMigrationBackup({
      cwd: workspace,
      now: new Date(baseMs + 3 * 1000),
      retain: 2,
    });

    expect(result.retainedCount).toBe(2);
    expect(result.prunedPaths.length).toBe(2);
    for (const pruned of result.prunedPaths) {
      expect(existsSync(pruned)).toBe(false);
    }
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

  test("does not mutate the live database (no migration writes during backup)", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const databaseFile: string = resolveStoragePaths(workspace).databaseFile;
    const before: number = statSync(databaseFile).mtimeMs;

    // Wait a few ms so any mtime change would be observable on most filesystems.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    createMigrationBackup({ cwd: workspace });
    const after: number = statSync(databaseFile).mtimeMs;
    // Backup is a pure read on the source via VACUUM INTO; mtime should be unchanged.
    expect(after).toBe(before);
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

  test("subcommand --retain trims sibling count to N", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    // Pre-populate four backups directly via the helper.
    const baseMs: number = new Date("2026-05-02T13:45:30.000Z").getTime();
    for (let i = 0; i < 4; i += 1) {
      createMigrationBackup({
        cwd: workspace,
        now: new Date(baseMs + i * 1000),
        retain: 100,
      });
    }

    const result = await runMigrate({
      args: ["backup", "--retain", "2"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeTrue();
    const data = result.data as {
      retain: number;
      retainedCount: number;
      prunedPaths: string[];
    };
    expect(data.retain).toBe(2);
    expect(data.retainedCount).toBe(2);
    expect(data.prunedPaths.length).toBeGreaterThan(0);
    expect(listBackups(workspace).length).toBe(2);
  });

  test("subcommand rejects --retain with non-integer value", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["backup", "--retain", "abc"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("subcommand rejects --retain 0", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["backup", "--retain", "0"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
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

// ---------------------------------------------------------------------------
// Migration version marker file tests
// ---------------------------------------------------------------------------

describe("migration-version marker: written after migrate", (): void => {
  test("marker file is created after migrateDatabase", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const markerPath = join(workspace, ".trekoon", "migration-version");
      expect(existsSync(markerPath)).toBe(true);
      const version = readMigrationVersionMarker(storage.db);
      expect(version).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      storage.close();
    }
  });

  test("readMigrationVersionMarker returns null for :memory: db", (): void => {
    const db = new Database(":memory:");
    try {
      expect(readMigrationVersionMarker(db)).toBeNull();
    } finally {
      db.close(false);
    }
  });

  test("writeMigrationVersionMarker is a no-op for :memory: db", (): void => {
    const db = new Database(":memory:");
    try {
      // Should not throw.
      writeMigrationVersionMarker(db, LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });
});

describe("migration-version marker: probe skipped on second call", (): void => {
  test("second migrateDatabase call is skipped via marker (no exception, correct version)", (): void => {
    const workspace: string = createWorkspace();
    // First call — runs migrations and writes marker.
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    // Re-open and call migrateDatabase again; marker should cause probe skip.
    const dbPath = join(workspace, ".trekoon", "trekoon.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      // This must not throw and must not regress schema.
      migrateDatabase(db);
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });
});

describe("migration-version marker: stale marker falls back to probe", (): void => {
  test("marker older than DB triggers probe and still succeeds", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    // First pass: create DB + marker.
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Make the marker appear older than the DB by back-dating it.
    const oldTime = new Date(Date.now() - 5000);
    const { utimesSync } = await import("node:fs");
    utimesSync(markerPath, oldTime, oldTime);

    // Verify the DB is now newer than the marker.
    expect(statSync(dbPath).mtimeMs).toBeGreaterThan(statSync(markerPath).mtimeMs);

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      // Even with a stale marker the migration runner must succeed gracefully.
      expect((): void => migrateDatabase(db)).not.toThrow();
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });
});

describe("migration-version marker: missing marker falls back to probe", (): void => {
  test("absent marker causes normal probe without throwing", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Delete the marker.
    rmSync(markerPath);
    expect(existsSync(markerPath)).toBe(false);

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      expect((): void => migrateDatabase(db)).not.toThrow();
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });
});

describe("migration-version marker: malformed marker falls back to probe", (): void => {
  test("corrupt marker content probes normally without throwing", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Overwrite with garbage.
    const { writeFileSync } = require("node:fs");
    writeFileSync(markerPath, "not-a-number", "utf8");

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      expect((): void => migrateDatabase(db)).not.toThrow();
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Warm-start benchmark: 5 consecutive marker-skipped migrateDatabase calls
// must complete in under 100ms total.
// ---------------------------------------------------------------------------

describe("migration-version marker: warm-start benchmark", (): void => {
  test("5 warm migrateDatabase calls complete under 100ms total", (): void => {
    const workspace: string = createWorkspace();
    // Perform cold start so the marker is written.
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Open a persistent connection for the bench iterations.
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      // Warm-up: one call outside the timed window.
      migrateDatabase(db);

      const start = performance.now();
      for (let i = 0; i < 5; i++) {
        migrateDatabase(db);
      }
      const elapsedMs = performance.now() - start;

      expect(elapsedMs).toBeLessThan(100);
    } finally {
      db.close(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Marker fast-path hardening: PRAGMA user_version fingerprint replaces the
// previous mtime defensive check (Finding #8).
// ---------------------------------------------------------------------------

describe("migration-version marker: PRAGMA user_version fingerprint", (): void => {
  test("marker payload is JSON with version + userVersion fields", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const raw: string = readFileSync(markerPath, "utf8").trim();
    expect(raw.startsWith("{")).toBe(true);

    const parsed = JSON.parse(raw) as { version: number; userVersion: number };
    expect(parsed.version).toBe(LATEST_MIGRATION_VERSION);
    expect(parsed.userVersion).toBe(LATEST_MIGRATION_VERSION);
  });

  test("DB header user_version is stamped to LATEST after migrate", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    try {
      const row = storage.db.query("PRAGMA user_version;").get() as { user_version: number } | null;
      expect(row?.user_version).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      storage.close();
    }
  });

  test("legacy bare-integer marker forces a probe (rewrites in v2 form)", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Overwrite with the legacy v1 format.
    writeFileSync(markerPath, String(LATEST_MIGRATION_VERSION), "utf8");

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    try {
      expect((): void => migrateDatabase(db)).not.toThrow();
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }

    // Marker should now be in v2 JSON form.
    const after: string = readFileSync(markerPath, "utf8").trim();
    expect(after.startsWith("{")).toBe(true);
  });

  test("restored-from-backup with stale user_version probes despite fresh marker", (): void => {
    // (b) from finding #8: a DB restored from an older backup keeps its
    // pre-restore user_version baked into the SQLite header. The marker on
    // disk still claims LATEST, but the header tells the truth.
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const dbPath = join(workspace, ".trekoon", "trekoon.db");
    const markerPath = join(workspace, ".trekoon", "migration-version");

    // Take a snapshot of the live DB, then mutate the snapshot to look like
    // an older schema by setting its user_version to 0. Restore over the
    // current DB.
    const snapshotPath = join(workspace, ".trekoon", "trekoon.db.restore-source");
    copyFileSync(dbPath, snapshotPath);

    const tampered = new Database(snapshotPath);
    try {
      tampered.exec("PRAGMA user_version = 0;");
    } finally {
      tampered.close(false);
    }

    // Restore: overwrite the live DB bytes with the tampered snapshot.
    copyFileSync(snapshotPath, dbPath);

    // Marker still on disk from the original migrate run.
    expect(existsSync(markerPath)).toBe(true);

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      // user_version is now 0 (stale) — fast path must NOT skip the probe.
      const beforeRow = db.query("PRAGMA user_version;").get() as { user_version: number } | null;
      expect(beforeRow?.user_version).toBe(0);

      // migrate must complete without throwing and re-stamp user_version.
      expect((): void => migrateDatabase(db)).not.toThrow();

      const afterRow = db.query("PRAGMA user_version;").get() as { user_version: number } | null;
      expect(afterRow?.user_version).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });

  test("rollback updates DB header user_version inside transaction", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    try {
      // Roll back two index-only migrations (10 -> 9 -> 8 -> 7) which are
      // safely reversible. Stop at the first irreversible boundary (v6).
      const summary = rollbackDatabase(storage.db, 7);
      expect(summary.toVersion).toBe(7);

      const row = storage.db.query("PRAGMA user_version;").get() as { user_version: number } | null;
      expect(row?.user_version).toBe(7);
    } finally {
      storage.close();
    }
  });

  test("rollback marker reflects post-rollback userVersion", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    try {
      rollbackDatabase(storage.db, 7);
    } finally {
      storage.close();
    }

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const raw: string = readFileSync(markerPath, "utf8").trim();
    const parsed = JSON.parse(raw) as { version: number; userVersion: number };
    expect(parsed.version).toBe(7);
    expect(parsed.userVersion).toBe(7);
  });

  test("rollback unlinks stale marker when fresh marker write fails", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const tmpMarkerPath = `${markerPath}.tmp`;

    try {
      // Pre-create a directory at the temp-marker path so writeFileSync()
      // fails with EISDIR; the rollback code path detects that and unlinks
      // the now-stale on-disk marker (which still points at LATEST).
      const { mkdirSync } = require("node:fs");
      mkdirSync(tmpMarkerPath, { recursive: true });

      try {
        rollbackDatabase(storage.db, 7);
      } finally {
        // Always clean up the obstruction so afterEach() can recurse.
        rmSync(tmpMarkerPath, { recursive: true, force: true });
      }

      // The pre-rollback marker pointed at LATEST. The new marker write
      // failed because of the EISDIR obstruction, so the rollback path
      // must have unlinked the stale marker.
      expect(existsSync(markerPath)).toBe(false);

      // PRAGMA user_version was committed inside the rollback transaction,
      // so the DB header is the source of truth even though the sidecar
      // file is now absent.
      const row = storage.db.query("PRAGMA user_version;").get() as { user_version: number } | null;
      expect(row?.user_version).toBe(7);
    } finally {
      storage.close();
    }
  });

  test("warm migrate with matching user_version fingerprint skips probe", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const dbPath = join(workspace, ".trekoon", "trekoon.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      // Sanity: user_version is stamped at LATEST.
      const row = db.query("PRAGMA user_version;").get() as { user_version: number } | null;
      expect(row?.user_version).toBe(LATEST_MIGRATION_VERSION);

      // Warm calls succeed without modifying schema.
      for (let i = 0; i < 3; i += 1) {
        migrateDatabase(db);
      }
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }
  });

  test("marker payload mismatch (userVersion drift) forces probe", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const markerPath = join(workspace, ".trekoon", "migration-version");
    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Tamper the marker so userVersion no longer matches the DB header.
    writeFileSync(
      markerPath,
      JSON.stringify({ version: LATEST_MIGRATION_VERSION, userVersion: 0 }),
      "utf8",
    );

    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    try {
      expect((): void => migrateDatabase(db)).not.toThrow();
      expect(readCurrentMigrationVersionReadOnly(db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      db.close(false);
    }

    // Probe should have rewritten the marker with a correct fingerprint.
    const raw: string = readFileSync(markerPath, "utf8").trim();
    const parsed = JSON.parse(raw) as { version: number; userVersion: number };
    expect(parsed.userVersion).toBe(LATEST_MIGRATION_VERSION);
  });
});

describe("migration fast-path: racing rollback vs unlocked stamp", (): void => {
  test("rollback applied between probe and lock leaves user_version pinned to rollback target", (): void => {
    // Models two CLI processes: A observes a fully-migrated schema via the
    // unlocked fast-path probe; B then runs `rollbackDatabase` (acquiring
    // BEGIN EXCLUSIVE) before A can stamp user_version. Without the
    // re-read-under-lock guard, A would proceed to stamp user_version =
    // LATEST despite schema_migrations now reporting a lower version,
    // violating the invariant that the marker / user_version never points
    // higher than schema_migrations.
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const dbPath = join(workspace, ".trekoon", "trekoon.db");

    // Connection A: simulates process A entering migrateDatabase.
    const dbA = new Database(dbPath);
    dbA.exec("PRAGMA journal_mode = WAL;");
    dbA.exec("PRAGMA foreign_keys = ON;");
    dbA.exec("PRAGMA busy_timeout = 5000;");

    // Connection B: simulates process B running a concurrent rollback.
    const dbB = new Database(dbPath);
    dbB.exec("PRAGMA journal_mode = WAL;");
    dbB.exec("PRAGMA foreign_keys = ON;");
    dbB.exec("PRAGMA busy_timeout = 5000;");

    try {
      // Process B rolls back before Process A's lock acquisition. In
      // practice this race is the small window between the unlocked
      // schema_migrations probe and the BEGIN EXCLUSIVE — we mirror that
      // here by performing the rollback first, then having A run
      // migrateDatabase against the now-rolled-back DB. The fast-path
      // probe inside migrateDatabase must NOT stamp user_version =
      // LATEST when the under-lock recheck disagrees with the unlocked
      // probe.
      rollbackDatabase(dbB, 7);

      // A's call to migrateDatabase: under the new guard this falls
      // through to the slow path, which re-applies migrations 8..LATEST.
      // Crucially, between the unlocked probe and the lock the schema is
      // NOT at LATEST, so the lock-confirmed branch must not run.
      expect((): void => migrateDatabase(dbA)).not.toThrow();

      // Final invariant: user_version must equal schema_migrations.MAX —
      // never higher.
      const userVersionRow = dbA
        .query("PRAGMA user_version;")
        .get() as { user_version: number } | null;
      const schemaMigrationsMax: number = readCurrentMigrationVersionReadOnly(dbA);
      expect(userVersionRow?.user_version).toBe(schemaMigrationsMax);
      expect(userVersionRow?.user_version).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      dbA.close(false);
      dbB.close(false);
    }
  });

  test("under-lock disagreement bails to slow path without stamping a higher user_version", (): void => {
    // Direct invariant check: drop user_version to a stale value that
    // disagrees with schema_migrations (modelling the half-applied state
    // an interrupted rollback could leave). The fast-path's confirmed
    // branch must not silently re-stamp to LATEST without going through
    // the slow migrate path, which records every applied migration.
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const dbPath = join(workspace, ".trekoon", "trekoon.db");
    const db = new Database(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");

    try {
      // Tamper schema_migrations to remove the LATEST row only — the
      // table still exists but its MAX(version) now lags. The unlocked
      // fast-path probe will not skip (distinct_versions !== latest), so
      // we go through the slow path; user_version gets stamped to LATEST
      // again only after the missing migration row is reinstated.
      db.exec("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations);");

      // Reset the marker so the marker fast-path can't short-circuit
      // before the schema fast-path runs.
      const markerPath = join(workspace, ".trekoon", "migration-version");
      writeFileSync(markerPath, JSON.stringify({ version: 0, userVersion: 0 }), "utf8");

      // migrateDatabase must complete and not leave user_version higher
      // than schema_migrations at any commit boundary.
      expect((): void => migrateDatabase(db)).not.toThrow();

      const userVersionRow = db
        .query("PRAGMA user_version;")
        .get() as { user_version: number } | null;
      const schemaMigrationsMax: number = readCurrentMigrationVersionReadOnly(db);
      expect(userVersionRow?.user_version).toBe(schemaMigrationsMax);
    } finally {
      db.close(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Migration 0012: dependency polymorphic-edge indexes
// ---------------------------------------------------------------------------

describe("migration 0012: dependency kind indexes", (): void => {
  test("creates idx_dependencies_source, idx_dependencies_target, uniq_dependencies_edge", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const indexRows = storage.db
        .query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dependencies';")
        .all() as Array<{ name: string }>;

      const names = new Set(indexRows.map((row) => row.name));
      expect(names.has("idx_dependencies_source")).toBe(true);
      expect(names.has("idx_dependencies_target")).toBe(true);
      expect(names.has("uniq_dependencies_edge")).toBe(true);
    } finally {
      storage.close();
    }
  });

  test("uniq_dependencies_edge rejects duplicate 4-tuple inserts", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const now = Date.now();
      storage.db
        .query(
          "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run("dep-a", "src-1", "task", "tgt-1", "task", now, now);

      let caught: unknown;
      try {
        storage.db
          .query(
            "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
          )
          .run("dep-b", "src-1", "task", "tgt-1", "task", now, now);
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeDefined();
      expect(String((caught as Error).message ?? "")).toMatch(/UNIQUE|constraint/iu);
    } finally {
      storage.close();
    }
  });

  test("dedupe step keeps lowest created_at row when duplicates exist on legacy DB", (): void => {
    // Simulate a pre-0012 DB by rolling back to v11 (drops the indexes and
    // the schema_migrations row), seeding duplicate rows, then re-running
    // migrateDatabase. The dedupe step must collapse duplicates so the
    // UNIQUE index creation succeeds.
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      // Drop the v12+ schema_migrations rows and the indexes/UNIQUE so we
      // can stage a "before" snapshot the migration will fix up.
      storage.db.exec("DELETE FROM schema_migrations WHERE version >= 12;");
      storage.db.exec("DROP INDEX IF EXISTS uniq_dependencies_edge;");
      storage.db.exec("DROP INDEX IF EXISTS idx_dependencies_target;");
      storage.db.exec("DROP INDEX IF EXISTS idx_dependencies_source;");
      // Restore the v2 single-column source index so the dependencies
      // table looks like a pre-v12 schema before we seed duplicates.
      storage.db.exec("CREATE INDEX IF NOT EXISTS idx_dependencies_source ON dependencies(source_id);");
      // Also drop the v5 (source_id, depends_on_id) UNIQUE so we can insert
      // duplicates that share the full 4-tuple. v5 is irreversible via the
      // normal rollback path, so we surgically drop the index here for the
      // test fixture only.
      storage.db.exec("DROP INDEX IF EXISTS idx_dependencies_edge;");

      const base = Date.now();
      // Two duplicate rows for the same logical edge — different ids, different created_at.
      storage.db
        .query(
          "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run("dup-old", "src-1", "task", "tgt-1", "task", base, base);
      storage.db
        .query(
          "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run("dup-new", "src-1", "task", "tgt-1", "task", base + 1000, base + 1000);
      // A non-duplicate row that must survive untouched.
      storage.db
        .query(
          "INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);",
        )
        .run("solo", "src-2", "task", "tgt-2", "subtask", base, base);

      // Reset user_version + marker so the slow path runs.
      storage.db.exec("PRAGMA user_version = 11;");
      const markerPath = join(workspace, ".trekoon", "migration-version");
      writeFileSync(markerPath, JSON.stringify({ version: 11, userVersion: 11 }), "utf8");

      migrateDatabase(storage.db);

      const rows = storage.db
        .query("SELECT id FROM dependencies ORDER BY id ASC;")
        .all() as Array<{ id: string }>;
      const ids = rows.map((row) => row.id).sort();
      // Lowest-created_at survivor wins per logical edge.
      expect(ids).toContain("dup-old");
      expect(ids).not.toContain("dup-new");
      expect(ids).toContain("solo");
      expect(readCurrentMigrationVersionReadOnly(storage.db)).toBe(LATEST_MIGRATION_VERSION);
    } finally {
      storage.close();
    }
  });

  test("rollback to v11 drops new indexes and restores v2 single-column source/target indexes", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const summary = rollbackDatabase(storage.db, 11);
      expect(summary.toVersion).toBe(11);

      const indexRows = storage.db
        .query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'dependencies';")
        .all() as Array<{ name: string; sql: string | null }>;

      const byName = new Map(indexRows.map((row) => [row.name, row.sql ?? ""]));
      expect(byName.has("uniq_dependencies_edge")).toBe(false);
      expect(byName.has("idx_dependencies_target")).toBe(false);
      // Source-side index restored to its v2 single-column shape.
      expect(byName.get("idx_dependencies_source")).toMatch(/\(\s*source_id\s*\)/u);
      expect(byName.get("idx_dependencies_depends_on")).toMatch(/\(\s*depends_on_id\s*\)/u);
    } finally {
      storage.close();
    }
  });

  test("0013 indexes exist and survive rollback round-trip cleanly", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const initial = storage.db
        .query("SELECT name FROM sqlite_master WHERE type = 'index';")
        .all() as Array<{ name: string }>;
      const initialNames = new Set(initial.map((row) => row.name));
      expect(initialNames.has("idx_tasks_epic_created")).toBe(true);
      expect(initialNames.has("idx_subtasks_task_created")).toBe(true);

      // Roll back v13 and confirm the indexes are gone. v12 above v13 is
      // index-only, so the rollback should reverse cleanly without
      // tripping the irreversible guards.
      const summary = rollbackDatabase(storage.db, 12);
      expect(summary.toVersion).toBe(12);

      const after = storage.db
        .query("SELECT name FROM sqlite_master WHERE type = 'index';")
        .all() as Array<{ name: string }>;
      const afterNames = new Set(after.map((row) => row.name));
      expect(afterNames.has("idx_tasks_epic_created")).toBe(false);
      expect(afterNames.has("idx_subtasks_task_created")).toBe(false);
    } finally {
      storage.close();
    }
  });

  test("tasks WHERE epic_id ORDER BY created_at, id plan uses idx_tasks_epic_created (no temp b-tree)", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const plan = storage.db
        .query(
          "EXPLAIN QUERY PLAN SELECT id, epic_id, title, status, created_at FROM tasks WHERE epic_id = ? ORDER BY created_at ASC, id ASC LIMIT ?;",
        )
        .all("epic-1", 50) as Array<{ detail: string }>;
      const text = plan.map((row) => row.detail ?? "").join(" | ");
      expect(text).toContain("idx_tasks_epic_created");
      expect(text).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      storage.close();
    }
  });

  test("subtasks WHERE task_id ORDER BY created_at, id plan uses idx_subtasks_task_created", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const plan = storage.db
        .query(
          "EXPLAIN QUERY PLAN SELECT id, task_id, title, status, created_at FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC LIMIT ?;",
        )
        .all("task-1", 50) as Array<{ detail: string }>;
      const text = plan.map((row) => row.detail ?? "").join(" | ");
      expect(text).toContain("idx_subtasks_task_created");
      expect(text).not.toContain("USE TEMP B-TREE FOR ORDER BY");
    } finally {
      storage.close();
    }
  });

  test("dep list / dep reverse query plans use the new indexes", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      // dep list reads dependencies WHERE source_id = ? — should use the
      // source-side index (either the new composite or the existing v2
      // single-col idx_dependencies_source -> v12 replaces with composite).
      const sourcePlan = storage.db
        .query(
          "EXPLAIN QUERY PLAN SELECT id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at FROM dependencies WHERE source_id = ? ORDER BY created_at ASC, id ASC;",
        )
        .all("src-1") as Array<{ detail: string }>;
      const sourcePlanText = sourcePlan.map((row) => row.detail ?? "").join(" | ");
      expect(sourcePlanText).toMatch(/idx_dependencies_(source|edge)/iu);

      // dep reverse seeds the recursive CTE with WHERE depends_on_id = ?
      // and joins on depends_on_id again — should use the target index.
      const targetPlan = storage.db
        .query("EXPLAIN QUERY PLAN SELECT source_id, source_kind FROM dependencies WHERE depends_on_id = ?;")
        .all("tgt-1") as Array<{ detail: string }>;
      const targetPlanText = targetPlan.map((row) => row.detail ?? "").join(" | ");
      expect(targetPlanText).toMatch(/idx_dependencies_(target|depends_on)/iu);
    } finally {
      storage.close();
    }
  });
});
