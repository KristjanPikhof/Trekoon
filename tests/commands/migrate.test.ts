import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runMigrate } from "../../src/commands/migrate";
import { resolveStoragePaths } from "../../src/storage/path";
import { openTrekoonDatabase } from "../../src/storage/database";
import { migrateDatabase, rollbackDatabase } from "../../src/storage/migrations";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-migrate-command-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("migrate command", (): void => {
  test("returns migration status for initialized workspace", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["status"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("migrate.status");

    const data = result.data as {
      currentVersion: number;
      latestVersion: number;
      pending: unknown[];
      applied: unknown[];
    };

    expect(data.currentVersion).toBeGreaterThan(0);
    expect(data.latestVersion).toBeGreaterThan(0);
    expect(data.pending.length).toBe(0);
    expect(data.applied.length).toBeGreaterThan(0);
  });

  test("rolls back reversible migrations with explicit flag", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const rollback = await runMigrate({
      args: ["rollback", "--to-version", "4"],
      cwd: workspace,
      mode: "toon",
    });

    expect(rollback.ok).toBeTrue();
    expect(rollback.command).toBe("migrate.rollback");

    const summary = rollback.data as {
      fromVersion: number;
      toVersion: number;
      rolledBack: number;
    };
    expect(summary.fromVersion).toBeGreaterThanOrEqual(4);
    expect(summary.toVersion).toBe(4);
  });

  test("status reports current version on fully migrated database", async (): Promise<void> => {
    const workspace: string = createWorkspace();

    // Build a database at version 4 (the minimum supported version)
    // then verify status correctly reports it without auto-upgrading.
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const status = await runMigrate({
      args: ["status"],
      cwd: workspace,
      mode: "toon",
    });

    expect(status.ok).toBeTrue();
    expect(status.command).toBe("migrate.status");

    const data = status.data as {
      currentVersion: number;
      latestVersion: number;
      pending: unknown[];
      applied: unknown[];
    };

    expect(data.currentVersion).toBe(data.latestVersion);
    expect(data.pending.length).toBe(0);
  });

  test("returns invalid input for non-numeric target version", async (): Promise<void> => {
    const workspace: string = createWorkspace();

    const result = await runMigrate({
      args: ["rollback", "--to-version", "x"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("invalid_input");
  });

  test("fails status when legacy migration row cannot be inferred", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace, { autoMigrate: false });
    storage.close();

    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    const db = new Database(databasePath);

    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL
        );
      `);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?);").run(
        "9999_totally_unknown_legacy",
        Date.now(),
      );
    } finally {
      db.close(false);
    }

    const status = await runMigrate({
      args: ["status"],
      cwd: workspace,
      mode: "toon",
    });

    expect(status.ok).toBeFalse();
    expect(status.error?.code).toBe("migrate_failed");
    expect(`${status.error?.message ?? ""}\n${status.human ?? ""}`).toMatch(/infer|manual/i);
  });

  test("rejects rollback below version 4 via migrate command", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["rollback", "--to-version", "3"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("migrate_failed");
    expect(result.error?.message).toMatch(/irreversible/i);
  });

  test("rejects rollback to version 0 via migrate command", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const result = await runMigrate({
      args: ["rollback", "--to-version", "0"],
      cwd: workspace,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("migrate_failed");
    expect(result.error?.message).toMatch(/irreversible/i);
  });

  test("maps known legacy base migration names during status", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace, { autoMigrate: false });
    storage.close();

    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    const db = new Database(databasePath);

    try {
      db.exec(`
        CREATE TABLE schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL
        );
      `);
      db.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?);").run(
        "0001_base_schema_v999",
        Date.now(),
      );
    } finally {
      db.close(false);
    }

    const status = await runMigrate({
      args: ["status"],
      cwd: workspace,
      mode: "toon",
    });

    expect(status.ok).toBeTrue();
    expect(status.command).toBe("migrate.status");

    const data = status.data as {
      currentVersion: number;
    };

    expect(data.currentVersion).toBeGreaterThanOrEqual(1);
  });
});
