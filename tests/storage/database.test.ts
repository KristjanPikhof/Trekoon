import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DomainError } from "../../src/domain/types";
import { openTrekoonDatabase } from "../../src/storage/database";
import { migrateDatabase, rollbackDatabase } from "../../src/storage/migrations";
import {
  resolveLegacyWorktreeDatabaseFile,
  resolveStoragePaths,
  TREKOON_STORAGE_DIRNAME,
} from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-storage-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
}

function createCommittedGitRepository(workspace: string): void {
  initGitRepository(workspace);
  writeFileSync(join(workspace, "README.md"), "# Trekoon\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Trekoon Tests", "-c", "user.email=tests@trekoon.local", "commit", "-m", "Initial commit"],
    { cwd: workspace, stdio: "ignore" },
  );
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

function createLegacyDatabaseFile(workspace: string, title: string): string {
  const databaseFile: string = resolveLegacyWorktreeDatabaseFile(workspace);
  mkdirSync(join(workspace, TREKOON_STORAGE_DIRNAME), { recursive: true });
  const db = new Database(databaseFile, { create: true });

  try {
    migrateDatabase(db);
    db.exec("PRAGMA foreign_keys = ON;");
    db.query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?);").run(
      `epic-${title}`,
      title,
      `Legacy ${title}`,
      "todo",
      1,
      1,
      1,
    );
  } finally {
    db.close(false);
  }

  return realpathSync(databaseFile);
}

function listEpicTitles(databaseFile: string): string[] {
  const db = new Database(databaseFile, { create: false, readonly: true });

  try {
    const rows = db.query("SELECT title FROM epics ORDER BY title ASC;").all() as Array<{ title: string }>;
    return rows.map((row) => row.title);
  } finally {
    db.close(false);
  }
}

function canonicalPath(filePath: string): string {
  return realpathSync(filePath);
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

  test("resolves same canonical database file from nested cwd", (): void => {
    const workspace: string = createWorkspace();
    initGitRepository(workspace);
    const nestedCwd: string = join(workspace, "apps", "cli", "nested");
    mkdirSync(nestedCwd, { recursive: true });
    const rootPaths = resolveStoragePaths(workspace);

    const rootStorage = openTrekoonDatabase(workspace);
    const nestedStorage = openTrekoonDatabase(nestedCwd);

    try {
      expect(rootStorage.paths.storageMode).toBe("git_common_dir");
      expect(rootStorage.paths.repoCommonDir).toBe(rootPaths.repoCommonDir);
      expect(rootStorage.paths.sharedStorageRoot).toBe(rootPaths.sharedStorageRoot);
      expect(rootStorage.paths.databaseFile).toBe(join(rootStorage.paths.sharedStorageRoot, ".trekoon", "trekoon.db"));
      expect(nestedStorage.paths.databaseFile).toBe(rootStorage.paths.databaseFile);
      expect(nestedStorage.paths.worktreeRoot).toBe(rootStorage.paths.worktreeRoot);
      expect(nestedStorage.paths.sharedStorageRoot).toBe(rootStorage.paths.sharedStorageRoot);
      expect(nestedStorage.paths.diagnostics.warnings.map((warning) => warning.code)).toEqual(["storage_root_diverged_from_cwd"]);
    } finally {
      nestedStorage.close();
      rootStorage.close();
    }
  });

  test("reuses one shared database across linked worktrees", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-shared-test", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const primaryStorage = openTrekoonDatabase(workspace);
    const secondaryStorage = openTrekoonDatabase(linkedWorktree);
    const primaryPaths = resolveStoragePaths(workspace);
    const linkedPaths = resolveStoragePaths(linkedWorktree);

    try {
      expect(primaryStorage.paths.databaseFile).toBe(secondaryStorage.paths.databaseFile);
      expect(primaryStorage.paths.sharedStorageRoot).toBe(secondaryStorage.paths.sharedStorageRoot);
      expect(primaryStorage.paths.worktreeRoot).toBe(primaryPaths.worktreeRoot);
      expect(secondaryStorage.paths.worktreeRoot).toBe(linkedPaths.worktreeRoot);
      expect(secondaryStorage.paths.sharedStorageRoot).toBe(primaryPaths.worktreeRoot);
      expect(secondaryStorage.paths.repoCommonDir).toBe(primaryStorage.paths.repoCommonDir);
      expect(secondaryStorage.paths.diagnostics.warnings.map((warning) => warning.code)).toContain(
        "shared_storage_root_differs_from_worktree_root",
      );
    } finally {
      secondaryStorage.close();
      primaryStorage.close();
    }
  });

  test("reports no legacy recovery work when shared state is clean", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const storage = openTrekoonDatabase(workspace);

    try {
      expect(storage.diagnostics.recoveryStatus).toBe("no_legacy_state");
      expect(storage.diagnostics.legacyStateDetected).toBe(false);
      expect(storage.diagnostics.recoveryRequired).toBe(false);
    } finally {
      storage.close();
    }
  });

  test("imports a single legacy worktree database into shared storage", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-import-test", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyDatabaseFile: string = createLegacyDatabaseFile(linkedWorktree, "linked-worktree");
    const sharedDatabaseFile: string = resolveStoragePaths(linkedWorktree).databaseFile;

    expect(existsSync(sharedDatabaseFile)).toBe(false);

    const storage = openTrekoonDatabase(linkedWorktree);

    try {
      expect(storage.diagnostics.recoveryStatus).toBe("safe_auto_migrate");
      expect(storage.diagnostics.autoMigratedLegacyState).toBe(true);
      expect(storage.diagnostics.importedFromLegacyDatabase).toBe(legacyDatabaseFile);
      expect(storage.diagnostics.backupFiles).toHaveLength(1);
      expect(existsSync(storage.diagnostics.backupFiles[0]!)).toBe(true);
      expect(listEpicTitles(storage.paths.databaseFile)).toEqual(["linked-worktree"]);
    } finally {
      storage.close();
    }
  });

  test("imports identical legacy databases from multiple worktrees once", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktreeA: string = createWorkspace();
    const linkedWorktreeB: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-identical-a", linkedWorktreeA, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });
    execFileSync("git", ["worktree", "add", "-b", "storage-identical-b", linkedWorktreeB, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    createLegacyDatabaseFile(linkedWorktreeA, "same-state");
    createLegacyDatabaseFile(linkedWorktreeB, "same-state");

    const storage = openTrekoonDatabase(linkedWorktreeA);

    try {
      expect(storage.diagnostics.recoveryStatus).toBe("safe_auto_migrate");
      expect(storage.diagnostics.autoMigratedLegacyState).toBe(true);
      expect(storage.diagnostics.legacyDatabaseFiles).toHaveLength(2);
      expect(storage.diagnostics.backupFiles).toHaveLength(2);
      expect(listEpicTitles(storage.paths.databaseFile)).toEqual(["same-state"]);
    } finally {
      storage.close();
    }
  });

  test("refuses to merge divergent legacy worktree databases", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktreeA: string = createWorkspace();
    const linkedWorktreeB: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-divergent-a", linkedWorktreeA, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });
    execFileSync("git", ["worktree", "add", "-b", "storage-divergent-b", linkedWorktreeB, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    createLegacyDatabaseFile(linkedWorktreeA, "first-state");
    createLegacyDatabaseFile(linkedWorktreeB, "second-state");

    expect((): void => {
      openTrekoonDatabase(linkedWorktreeA);
    }).toThrow(DomainError);

    try {
      openTrekoonDatabase(linkedWorktreeA);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("ambiguous_legacy_state");
      expect(domainError.details?.status).toBe("ambiguous_recovery");
    }
  });

  test("blocks tracked .trekoon files that conflict with ignored storage", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    mkdirSync(join(workspace, TREKOON_STORAGE_DIRNAME), { recursive: true });
    const trackedFile: string = join(workspace, TREKOON_STORAGE_DIRNAME, "tracked.txt");
    writeFileSync(trackedFile, "tracked state\n", "utf8");
    execFileSync("git", ["add", "-f", trackedFile], { cwd: workspace, stdio: "ignore" });

    expect((): void => {
      openTrekoonDatabase(workspace);
    }).toThrow(DomainError);

    try {
      openTrekoonDatabase(workspace);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("tracked_ignored_mismatch");
      expect(domainError.details?.trackedStorageFiles).toEqual([canonicalPath(trackedFile)]);
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

  test("skips exclusive migration lock when schema is current", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    storage.close();

    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    const lockHolder = new Database(databasePath);
    const migrator = new Database(databasePath);

    try {
      migrator.exec("PRAGMA busy_timeout = 1;");

      lockHolder.exec("BEGIN IMMEDIATE;");

      expect((): void => migrateDatabase(migrator)).not.toThrow();
    } finally {
      lockHolder.exec("ROLLBACK;");
      lockHolder.close(false);
      migrator.close(false);
    }
  });

  test("uses transactional migration path when schema is not current", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      rollbackDatabase(storage.db, 1);
    } finally {
      storage.close();
    }

    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    const lockHolder = new Database(databasePath);
    const migrator = new Database(databasePath);

    try {
      migrator.exec("PRAGMA busy_timeout = 1;");

      lockHolder.exec("BEGIN IMMEDIATE;");

      expect((): void => migrateDatabase(migrator)).toThrow(/locked/i);
    } finally {
      lockHolder.exec("ROLLBACK;");
      lockHolder.close(false);
      migrator.close(false);
    }
  });
});
