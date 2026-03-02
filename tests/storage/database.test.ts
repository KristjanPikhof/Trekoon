import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-storage-"));
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

function tableColumns(db: ReturnType<typeof openTrekoonDatabase>["db"], tableName: string): string[] {
  const rows = db.query(`PRAGMA table_info(${tableName});`).all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(db: ReturnType<typeof openTrekoonDatabase>["db"]): string[] {
  const rows = db
    .query("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%';")
    .all() as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

describe("storage lifecycle", (): void => {
  test("creates .trekoon database in current workspace", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      expect(storage.paths.databaseFile).toBe(join(workspace, ".trekoon", "trekoon.db"));

      const epicsTable = storage.db
        .query("SELECT name FROM sqlite_master WHERE type='table' AND name='epics';")
        .get() as { name: string } | null;

      expect(epicsTable?.name).toBe("epics");
    } finally {
      storage.close();
    }
  });

  test("bootstraps required sync tables", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const tables = ["git_context", "sync_cursors", "sync_conflicts"];

      for (const table of tables) {
        const row = storage.db
          .query("SELECT name FROM sqlite_master WHERE type='table' AND name=?;")
          .get(table) as { name: string } | null;
        expect(row?.name).toBe(table);
      }
    } finally {
      storage.close();
    }
  });

  test("tracks updated_at and version for mutable rows", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const mutableTables = [
        "epics",
        "tasks",
        "subtasks",
        "dependencies",
        "git_context",
        "sync_cursors",
        "sync_conflicts",
      ];

      for (const tableName of mutableTables) {
        const columns: string[] = tableColumns(storage.db, tableName);
        expect(columns).toContain("updated_at");
        expect(columns).toContain("version");
      }
    } finally {
      storage.close();
    }
  });

  test("creates required indexes for sync and dependencies", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const indexes: string[] = indexNames(storage.db);

      expect(indexes).toContain("idx_events_created_at");
      expect(indexes).toContain("idx_events_git_branch");
      expect(indexes).toContain("idx_events_created_at_id");
      expect(indexes).toContain("idx_dependencies_source");
      expect(indexes).toContain("idx_dependencies_depends_on");
    } finally {
      storage.close();
    }
  });
});
