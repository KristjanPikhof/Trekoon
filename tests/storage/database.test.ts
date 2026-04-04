import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DomainError } from "../../src/domain/types";
import { openTrekoonDatabase, resolveStorageResolutionDiagnostics } from "../../src/storage/database";
import { migrateDatabase, rollbackDatabase } from "../../src/storage/migrations";
import {
  resolveLegacyWorktreeDatabaseFile,
  resolveStoragePaths,
  TREKOON_STORAGE_DIRNAME,
} from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(prefix = "trekoon-storage-"): string {
  const workspace: string = mkdtempSync(join(tmpdir(), prefix));
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

interface LegacyWalBackedDatabase {
  readonly databaseFile: string;
  readonly walFrames: number;
}

function createLegacyWalBackedDatabaseFile(
  workspace: string,
  title: string,
): LegacyWalBackedDatabase {
  const databaseFile: string = resolveLegacyWorktreeDatabaseFile(workspace);
  mkdirSync(join(workspace, TREKOON_STORAGE_DIRNAME), { recursive: true });
  const initializer = new Database(databaseFile, { create: true });

  try {
    initializer.exec("PRAGMA journal_mode = WAL;");
    initializer.exec("PRAGMA wal_autocheckpoint = 0;");
    migrateDatabase(initializer);
  } finally {
    initializer.close(false);
  }

  let walFrames = 0;
  const blocker = new Database(databaseFile);

  try {
    blocker.exec("PRAGMA journal_mode = WAL;");
    blocker.exec("BEGIN;");
    blocker.query("SELECT COUNT(*) AS count FROM epics;").get();

    const writer = new Database(databaseFile);

    try {
      writer.exec("PRAGMA journal_mode = WAL;");
      writer.exec("PRAGMA wal_autocheckpoint = 0;");
      writer.exec("PRAGMA foreign_keys = ON;");
      writer.query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?);").run(
      `epic-${title}`,
      title,
      `Legacy ${title}`,
      "todo",
      1,
      1,
      1,
      );
    } finally {
      writer.close(false);
    }

    const checkpointResult: string = execFileSync("sqlite3", [databaseFile, "PRAGMA wal_checkpoint(NOOP);"], {
      encoding: "utf8",
    }).trim();
    const checkpointFields: string[] = checkpointResult.split("|");
    walFrames = Number.parseInt(checkpointFields[1] ?? "0", 10);
  } finally {
    blocker.exec("ROLLBACK;");
    blocker.close(false);
  }

  return {
    databaseFile: realpathSync(databaseFile),
    walFrames,
  };
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

  test("imports committed legacy WAL state into shared storage", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-import-wal", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyWalDatabase: LegacyWalBackedDatabase = createLegacyWalBackedDatabaseFile(linkedWorktree, "wal-backed");
    expect(existsSync(`${legacyWalDatabase.databaseFile}-wal`)).toBe(true);
    expect(legacyWalDatabase.walFrames).toBeGreaterThan(0);

    const storage = openTrekoonDatabase(linkedWorktree);

    try {
      expect(storage.diagnostics.recoveryStatus).toBe("safe_auto_migrate");
      expect(storage.diagnostics.autoMigratedLegacyState).toBe(true);
      expect(storage.diagnostics.importedFromLegacyDatabase).toBe(legacyWalDatabase.databaseFile);
      expect(storage.diagnostics.backupFiles).toHaveLength(1);
      expect(existsSync(storage.diagnostics.backupFiles[0]!)).toBe(true);
      expect(listEpicTitles(storage.paths.databaseFile)).toEqual(["wal-backed"]);
    } finally {
      storage.close();
    }
  });

  test("imports legacy state when worktree paths contain spaces", (): void => {
    const workspace: string = createWorkspace("trekoon storage root ");
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace("trekoon linked worktree ");

    execFileSync("git", ["worktree", "add", "-b", "storage-import-spaces", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyDatabaseFile: string = createLegacyDatabaseFile(linkedWorktree, "spaced-worktree");
    const sharedDatabaseFile: string = resolveStoragePaths(linkedWorktree).databaseFile;

    expect(legacyDatabaseFile).toContain(" ");
    expect(sharedDatabaseFile).toContain(" ");

    const storage = openTrekoonDatabase(linkedWorktree);

    try {
      expect(storage.diagnostics.recoveryStatus).toBe("safe_auto_migrate");
      expect(storage.diagnostics.autoMigratedLegacyState).toBe(true);
      expect(storage.diagnostics.importedFromLegacyDatabase).toBe(legacyDatabaseFile);
      expect(storage.diagnostics.backupFiles).toHaveLength(1);
      expect(existsSync(storage.diagnostics.backupFiles[0]!)).toBe(true);
      expect(listEpicTitles(storage.paths.databaseFile)).toEqual(["spaced-worktree"]);
    } finally {
      storage.close();
    }
  });

  test("reports importable legacy state without mutating storage", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-readonly-probe", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const legacyDatabaseFile: string = createLegacyDatabaseFile(linkedWorktree, "linked-worktree");
    const sharedDatabaseFile: string = resolveStoragePaths(linkedWorktree).databaseFile;

    const diagnostics = resolveStorageResolutionDiagnostics(linkedWorktree);

    expect(diagnostics.recoveryStatus).toBe("safe_auto_migrate");
    expect(diagnostics.legacyStateDetected).toBe(true);
    expect(diagnostics.autoMigratedLegacyState).toBe(false);
    expect(diagnostics.importedFromLegacyDatabase).toBeNull();
    expect(diagnostics.legacyDatabaseFiles).toEqual([legacyDatabaseFile]);
    expect(diagnostics.backupFiles).toEqual([]);
    expect(diagnostics.operatorAction).toContain("can be imported into shared storage during init/open");
    expect(existsSync(sharedDatabaseFile)).toBe(false);
    expect(listEpicTitles(legacyDatabaseFile)).toEqual(["linked-worktree"]);
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

    const legacyDatabaseFileA: string = createLegacyDatabaseFile(linkedWorktreeA, "same-state");
    const legacyDatabaseFileB: string = resolveLegacyWorktreeDatabaseFile(linkedWorktreeB);
    mkdirSync(join(linkedWorktreeB, TREKOON_STORAGE_DIRNAME), { recursive: true });
    copyFileSync(legacyDatabaseFileA, legacyDatabaseFileB);

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
      expect(domainError.details?.legacyDatabaseFiles).toEqual(
        [
          canonicalPath(resolveLegacyWorktreeDatabaseFile(linkedWorktreeA)),
          canonicalPath(resolveLegacyWorktreeDatabaseFile(linkedWorktreeB)),
        ].sort(),
      );
      expect(domainError.details?.trackedStorageFiles).toEqual([]);
      expect(domainError.details?.operatorAction).toContain("Choose one source database");
      expect(domainError.details?.operatorAction).toContain("sqlite3 .backup");
      expect(domainError.details?.operatorAction).toContain("mkdir -p");
      expect(domainError.details?.operatorAction).toContain(canonicalPath(resolveLegacyWorktreeDatabaseFile(linkedWorktreeA)));
      expect(domainError.details?.operatorAction).toContain("remove or reconcile the other divergent legacy database files before rerunning trekoon init");
      expect(domainError.details?.operatorAction).not.toContain("Example: cp ");
      expect(domainError.details?.operatorAction).toContain(resolveStoragePaths(linkedWorktreeA).databaseFile);
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
      expect(domainError.details?.status).toBe("tracked_ignored_mismatch");
      expect(domainError.details?.legacyDatabaseFiles).toEqual([]);
      expect(domainError.details?.trackedStorageFiles).toEqual([canonicalPath(trackedFile)]);
      expect(domainError.details?.operatorAction).toContain(`Tracked path(s): '${canonicalPath(trackedFile)}'`);
      expect(domainError.details?.operatorAction).toContain(
        `git -C '${canonicalPath(workspace)}' rm --cached -- '.trekoon/tracked.txt'`,
      );
    }
  });

  test("blocks linked-worktree tracked .trekoon files", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-tracked-linked", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    mkdirSync(join(linkedWorktree, TREKOON_STORAGE_DIRNAME), { recursive: true });
    const trackedFile: string = join(linkedWorktree, TREKOON_STORAGE_DIRNAME, "tracked.txt");
    writeFileSync(trackedFile, "linked tracked state\n", "utf8");
    execFileSync("git", ["add", "-f", trackedFile], { cwd: linkedWorktree, stdio: "ignore" });

    expect((): void => {
      openTrekoonDatabase(workspace);
    }).toThrow(DomainError);

    try {
      openTrekoonDatabase(workspace);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("tracked_ignored_mismatch");
      expect(domainError.details?.status).toBe("tracked_ignored_mismatch");
      expect(domainError.details?.legacyDatabaseFiles).toEqual([]);
      expect(domainError.details?.trackedStorageFiles).toEqual([canonicalPath(trackedFile)]);
      expect(domainError.details?.operatorAction).toContain(`Tracked path(s): '${canonicalPath(trackedFile)}'`);
      expect(domainError.details?.operatorAction).toContain(
        `git -C '${canonicalPath(linkedWorktree)}' rm --cached -- '.trekoon/tracked.txt'`,
      );
      expect(domainError.details?.operatorAction).not.toContain(
        `git -C '${canonicalPath(workspace)}' rm --cached -- '.trekoon/tracked.txt'`,
      );
    }
  });

  test("reports stale legacy worktree files once shared storage exists", (): void => {
    const workspace: string = createWorkspace();
    createCommittedGitRepository(workspace);
    const linkedWorktree: string = createWorkspace();

    execFileSync("git", ["worktree", "add", "-b", "storage-stale-legacy", linkedWorktree, "HEAD"], {
      cwd: workspace,
      stdio: "ignore",
    });

    const primaryStorage = openTrekoonDatabase(workspace);
    try {
      primaryStorage.db
        .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?);")
        .run("epic-shared-state", "shared-state", "Shared state", "todo", 1, 1, 1);
    } finally {
      primaryStorage.close();
    }

    const legacyDatabaseFile: string = createLegacyDatabaseFile(linkedWorktree, "stale-linked-worktree");

    expect((): void => {
      openTrekoonDatabase(linkedWorktree);
    }).toThrow(DomainError);

    try {
      openTrekoonDatabase(linkedWorktree);
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(DomainError);
      const domainError = error as DomainError;
      expect(domainError.code).toBe("ambiguous_legacy_state");
      expect(domainError.details?.status).toBe("ambiguous_recovery");
      expect(domainError.details?.legacyDatabaseFiles).toEqual([legacyDatabaseFile]);
      expect(domainError.details?.trackedStorageFiles).toEqual([]);
      expect(domainError.details?.operatorAction).toContain("Choose one source database");
      expect(domainError.details?.operatorAction).toContain(`sqlite3 '${legacyDatabaseFile}' '.backup`);
      expect(domainError.details?.operatorAction).toContain("remove the remaining divergent legacy database before rerunning trekoon init");
      expect(domainError.details?.operatorAction).not.toContain(`sqlite3 '${resolveStoragePaths(workspace).databaseFile}' '.backup`);
      expect(domainError.details?.operatorAction).toContain(resolveStoragePaths(workspace).databaseFile);
    }

    expect(listEpicTitles(resolveStoragePaths(workspace).databaseFile)).toEqual(["shared-state"]);
    expect(listEpicTitles(legacyDatabaseFile)).toEqual(["stale-linked-worktree"]);
  });

  test("bootstraps required sync tables", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const tables = ["git_context", "sync_cursors", "sync_conflicts"];
      tables.push("board_idempotency_keys");

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
      expect(indexes).toContain("idx_conflicts_resolution_updated_at");
      expect(indexes).toContain("idx_board_idempotency_created_at");
      expect(indexes).not.toContain("idx_conflicts_entity");
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

  test("rejects rollback from v5 to v4 with irreversible error", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      expect((): void => {
        rollbackDatabase(storage.db, 4);
      }).toThrow(/irreversible/i);
    } finally {
      storage.close();
    }
  });

  test("preserves schema_migrations after rejected v6 rollback", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      try {
        rollbackDatabase(storage.db, 5);
      } catch {
        // Expected to throw
      }

      const row = storage.db
        .query("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations;")
        .get() as { version: number };

      expect(row.version).toBe(10);
    } finally {
      storage.close();
    }
  });

  test("rollback to v8 from v8 is a valid no-op", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const summary = rollbackDatabase(storage.db, 9);

      expect(summary.fromVersion).toBe(9);
      expect(summary.toVersion).toBe(9);
      expect(summary.rolledBack).toBe(0);
      expect(summary.rolledBackMigrations).toEqual([]);
    } finally {
      storage.close();
    }
  });

  test("rollback to v3 rejects with irreversible migration error", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      let errorMessage = "";

      try {
        // Roll back to v3 to trigger irreversible errors. v7 can roll
        // back cleanly, then v6 throws.
        rollbackDatabase(storage.db, 3);
      } catch (error: unknown) {
        errorMessage = (error as Error).message;
      }

      expect(errorMessage).toContain("add_owner_column");
    } finally {
      storage.close();
    }
  });

  test("rollback from v8 to v6 drops lookup and sync scaling indexes", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const summary = rollbackDatabase(storage.db, 6);
      const indexes: string[] = indexNames(storage.db);

      expect(summary.fromVersion).toBe(9);
      expect(summary.toVersion).toBe(6);
      expect(summary.rolledBack).toBe(3);
      expect(summary.rolledBackMigrations).toEqual([
        "0009_board_idempotency_storage",
        "0008_sync_scaling_indexes",
        "0007_add_lookup_indexes",
      ]);
      expect(indexes).not.toContain("idx_conflicts_resolution_updated_at");
      expect(indexes).not.toContain("idx_dependencies_depends_on_kind");
      expect(indexes).not.toContain("idx_tasks_owner");
      expect(indexes).not.toContain("idx_subtasks_owner");
      expect(indexes).not.toContain("idx_board_idempotency_created_at");
    } finally {
      storage.close();
    }
  });

  test("migration 5 creates the unique index on dependencies", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const indexes: string[] = indexNames(storage.db);
      expect(indexes).toContain("idx_dependencies_edge");
    } finally {
      storage.close();
    }
  });

  test("creates durable board idempotency storage", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const columns: string[] = tableColumns(storage.db, "board_idempotency_keys");
      expect(columns).toEqual([
        "scope",
        "idempotency_key",
        "request_fingerprint",
        "state",
        "response_status",
        "response_body",
        "created_at",
      ]);
    } finally {
      storage.close();
    }
  });

  test("backfills legacy board idempotency state only when needed", (): void => {
    const workspace: string = createWorkspace();
    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });

    const initializer = new Database(databasePath, { create: true });

    try {
      initializer.exec("PRAGMA journal_mode = WAL;");
      initializer.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER NOT NULL UNIQUE,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL
        );
      `);
      initializer.exec(`
        CREATE TABLE IF NOT EXISTS board_idempotency_keys (
          scope TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_fingerprint TEXT NOT NULL,
          response_status INTEGER NOT NULL,
          response_body TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (scope, idempotency_key)
        );
      `);
      initializer.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(
        9,
        "0009_board_idempotency_storage",
        1,
      );
      initializer.query(`
        INSERT INTO board_idempotency_keys (
          scope,
          idempotency_key,
          request_fingerprint,
          response_status,
          response_body,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?);
      `).run("board", "legacy-key", "fingerprint", 200, "{}", 1);
    } finally {
      initializer.close(false);
    }

    const storage = openTrekoonDatabase(workspace);

    try {
      const columns: string[] = tableColumns(storage.db, "board_idempotency_keys");
      expect(columns).toContain("state");

      const row = storage.db
        .query("SELECT state FROM board_idempotency_keys WHERE scope = ? AND idempotency_key = ?;")
        .get("board", "legacy-key") as { state: string } | null;
      expect(row?.state).toBe("completed");
    } finally {
      storage.close();
    }
  });

  test("migration 5 cleans up orphaned dependencies", (): void => {
    const workspace: string = createWorkspace();
    const databasePath: string = resolveStoragePaths(workspace).databaseFile;
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const db = new Database(databasePath, { create: true });

    try {
      // Apply migrations 1-4 only
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER NOT NULL UNIQUE,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL
        );
      `);

      // Run base schema
      db.exec("PRAGMA foreign_keys = ON;");
      db.exec(`
        CREATE TABLE IF NOT EXISTS epics (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          epic_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (epic_id) REFERENCES epics (id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS subtasks (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS dependencies (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          depends_on_id TEXT NOT NULL,
          depends_on_kind TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (
          id TEXT PRIMARY KEY,
          entity_kind TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          payload TEXT NOT NULL,
          git_branch TEXT,
          git_head TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS git_context (
          id TEXT PRIMARY KEY,
          metadata_scope TEXT NOT NULL DEFAULT 'worktree',
          worktree_path TEXT NOT NULL,
          branch_name TEXT,
          head_sha TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          UNIQUE (metadata_scope, worktree_path)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_cursors (
          id TEXT PRIMARY KEY,
          owner_scope TEXT NOT NULL DEFAULT 'worktree',
          owner_worktree_path TEXT NOT NULL,
          source_branch TEXT NOT NULL,
          cursor_token TEXT NOT NULL,
          last_event_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          UNIQUE (owner_scope, owner_worktree_path, source_branch)
        );
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_conflicts (
          id TEXT PRIMARY KEY,
          event_id TEXT NOT NULL,
          entity_kind TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          field_name TEXT NOT NULL,
          ours_value TEXT,
          theirs_value TEXT,
          resolution TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          version INTEGER NOT NULL DEFAULT 1
        );
      `);

      // Record migrations 1-4
      const now = Date.now();
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(1, "0001_base_schema_v1", now);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(2, "0002_sync_dependency_indexes", now);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(3, "0003_event_archive_retention", now);
      db.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(4, "0004_worktree_scoped_sync_metadata", now);

      // Seed a valid task and an orphaned dependency
      db.query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
        .run("epic-1", "Epic", "", "todo", now, now);
      db.query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
        .run("task-1", "epic-1", "Task", "", "todo", now, now);

      // Orphaned: depends_on_id references a non-existent task
      db.query("INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
        .run("dep-orphaned", "task-1", "task", "missing-task", "task", now, now);

      // Orphaned: source_id references a non-existent task
      db.query("INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
        .run("dep-orphaned-source", "missing-source", "task", "task-1", "task", now, now);

      const beforeCount = (db.query("SELECT COUNT(*) AS count FROM dependencies;").get() as { count: number }).count;
      expect(beforeCount).toBe(2);

      // Run migration 5
      migrateDatabase(db);

      const afterCount = (db.query("SELECT COUNT(*) AS count FROM dependencies;").get() as { count: number }).count;
      expect(afterCount).toBe(0);
    } finally {
      db.close(false);
    }
  });

  test("unique constraint prevents duplicate logical dependency edges at the DB level", (): void => {
    const workspace: string = createWorkspace();
    const storage = openTrekoonDatabase(workspace);

    try {
      const now = Date.now();
      storage.db
        .query("INSERT INTO epics (id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 1);")
        .run("epic-uc", "Epic", "", "todo", now, now);
      storage.db
        .query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
        .run("task-uc-a", "epic-uc", "A", "", "todo", now, now);
      storage.db
        .query("INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, 1);")
        .run("task-uc-b", "epic-uc", "B", "", "todo", now, now);

      storage.db
        .query("INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, 'task', ?, 'task', ?, ?, 1);")
        .run("dep-uc-1", "task-uc-a", "task-uc-b", now, now);

      expect((): void => {
        storage.db
          .query("INSERT INTO dependencies (id, source_id, source_kind, depends_on_id, depends_on_kind, created_at, updated_at, version) VALUES (?, ?, 'task', ?, 'task', ?, ?, 1);")
          .run("dep-uc-2", "task-uc-a", "task-uc-b", now, now);
      }).toThrow(/UNIQUE constraint failed/i);
    } finally {
      storage.close();
    }
  });

  test("uses transactional migration path when schema is not current", (): void => {
    const workspace: string = createWorkspace();
    const databasePath: string = resolveStoragePaths(workspace).databaseFile;

    // Simulate a partially-migrated database by creating the migration
    // table with only the base migration recorded, bypassing rollback
    // restrictions from migration 0004.
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });
    const setupDb = new Database(databasePath, { create: true });

    try {
      setupDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          version INTEGER NOT NULL UNIQUE,
          name TEXT NOT NULL UNIQUE,
          applied_at INTEGER NOT NULL
        );
      `);
      setupDb.query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?);").run(
        1,
        "0001_base_schema_v1",
        Date.now(),
      );
    } finally {
      setupDb.close(false);
    }

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
