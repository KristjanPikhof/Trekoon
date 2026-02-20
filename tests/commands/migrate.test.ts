import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runMigrate } from "../../src/commands/migrate";
import { resolveStoragePaths } from "../../src/storage/path";

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

  test("rolls back to version 0 with explicit flag", async (): Promise<void> => {
    const workspace: string = createWorkspace();

    const rollback = await runMigrate({
      args: ["rollback", "--to-version", "0"],
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
    expect(summary.fromVersion).toBeGreaterThan(0);
    expect(summary.toVersion).toBe(0);
    expect(summary.rolledBack).toBeGreaterThan(0);

    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    const db = new Database(databasePath, { create: false });

    try {
      const epicsTable = db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='epics';")
        .get() as { name: string } | null;
      expect(epicsTable).toBeNull();
    } finally {
      db.close(false);
    }
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
});
