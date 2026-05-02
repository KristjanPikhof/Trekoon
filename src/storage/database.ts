import { existsSync, mkdirSync } from "node:fs";

import { Database } from "bun:sqlite";

import { DomainError } from "../domain/types";
import { LATEST_MIGRATION_VERSION, migrateDatabase, readCurrentMigrationVersionReadOnly } from "./migrations";
import { resolveLegacyWorktreeDatabaseFile, resolveStoragePaths, type StoragePaths } from "./path";
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

/** Default connection-level busy_timeout applied at open time. */
const DEFAULT_BUSY_TIMEOUT_MS = 15000;

/**
 * Maximum time (ms) to wait when acquiring the write lock via BEGIN IMMEDIATE.
 * Kept below the default bun test timeout so that lock-contention surfaces as
 * a SQLITE_BUSY error rather than a test-level timeout.
 */
const WRITE_LOCK_BUSY_TIMEOUT_MS = 3000;

/**
 * Execute a write transaction using BEGIN IMMEDIATE to acquire a reserved lock
 * up-front, avoiding SQLITE_BUSY errors that occur when a deferred transaction
 * is promoted to a write lock after readers have already started.
 *
 * A shorter busy_timeout is applied while acquiring the lock so callers receive
 * a prompt SQLITE_BUSY error instead of blocking for the full connection-level
 * timeout.  The connection-level timeout is restored before returning.
 */
export function writeTransaction<T>(db: Database, fn: (db: Database) => T): T {
  db.exec(`PRAGMA busy_timeout = ${WRITE_LOCK_BUSY_TIMEOUT_MS};`);
  try {
    db.exec("BEGIN IMMEDIATE;");
  } catch (error) {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
    throw error;
  }
  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  try {
    const result: T = fn(db);
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      /* best-effort rollback — propagate the original error */
    }
    throw error;
  }
}

/** Sentinel recovery result for the common case: no legacy worktree DB present. */
const NO_LEGACY_RECOVERY: WorktreeRecoveryDiagnostics = {
  status: "no_legacy_state",
  legacyDatabaseFiles: [],
  backupFiles: [],
  trackedStorageFiles: [],
  autoMigrated: false,
  importedFrom: null,
  operatorAction: "No legacy worktree-local database detected.",
};

/**
 * Process-level cache of opened TrekoonDatabase handles. Enabled only when
 * `TREKOON_DAEMON_INPROCESS=1` is set (the daemon spike sets this on startup).
 * In normal one-shot CLI invocations this map stays empty and the cache layer
 * is bypassed entirely, so default behavior is unchanged.
 *
 * Cached handles override `close()` so callers that follow the
 * `try { ... } finally { db?.close(); }` pattern do not actually tear down
 * the shared connection — instead, `close()` decrements an in-use refcount.
 * The daemon shutdown path calls `closeCachedDatabases()`.
 *
 * The cache is bounded LRU (insertion-order on Map; touched on access) so a
 * long-running daemon serving many distinct cwds does not accumulate open
 * SQLite connections / FDs without bound. Eviction closes the underlying
 * database after a passive WAL checkpoint.
 *
 * In-use protection: each `openTrekoonDatabase` call increments the entry's
 * refcount; the matching `close()` decrements it. Eviction skips entries
 * whose refcount is > 0 — closing them mid-query would surface as
 * SQLITE_MISUSE on the in-flight handler. If every cached entry is in use
 * when a new cwd is opened, we permit temporary growth past the cap and
 * emit a single warning; the next eviction-check after a `close()` will
 * reduce the cache back under the cap.
 */
const CACHED_DATABASES_CAPACITY = 16;

interface CachedEntry {
  readonly handle: TrekoonDatabase;
  refcount: number;
}

const cachedDatabases: Map<string, CachedEntry> = new Map();
let warnedOnTransientOvergrowth = false;

function isDaemonInProcessCacheEnabled(): boolean {
  return process.env.TREKOON_DAEMON_INPROCESS === "1";
}

function closeCachedHandle(handle: TrekoonDatabase): void {
  try {
    handle.db.exec("PRAGMA wal_checkpoint(PASSIVE);");
  } catch {
    /* best effort */
  }
  try {
    handle.db.close(false);
  } catch {
    /* best effort */
  }
}

/**
 * Evict the least-recently-used handle when the cache is at capacity. Map
 * iteration order in JS is insertion order; we re-insert on access (`touch`)
 * to model LRU semantics. Entries whose refcount is > 0 are SKIPPED — closing
 * an in-use handle would surface as SQLITE_MISUSE for the caller currently
 * borrowing it. A subsequent `releaseCachedDatabase` after the caller's
 * `close()` will re-run eviction so transient over-cap growth is bounded by
 * the number of concurrently-borrowed entries, which is in practice tiny.
 */
function evictLruIfNeeded(): void {
  while (cachedDatabases.size >= CACHED_DATABASES_CAPACITY) {
    let evicted = false;
    for (const [key, entry] of cachedDatabases) {
      if (entry.refcount > 0) {
        continue;
      }
      cachedDatabases.delete(key);
      closeCachedHandle(entry.handle);
      evicted = true;
      break;
    }

    if (!evicted) {
      // Every cached entry is currently borrowed. Allow temporary growth
      // past the cap rather than closing an in-use handle. Surface a single
      // warning so an operator can spot pathological concurrency.
      if (!warnedOnTransientOvergrowth) {
        warnedOnTransientOvergrowth = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[trekoon daemon] all ${CACHED_DATABASES_CAPACITY} cached database handles are in use; temporarily growing cache past the cap`,
        );
      }
      return;
    }
  }
}

function touchCachedDatabase(key: string, entry: CachedEntry): void {
  // Re-insert to move to the most-recently-used (tail) end of insertion order.
  cachedDatabases.delete(key);
  cachedDatabases.set(key, entry);
}

/**
 * Decrement the refcount for a cached entry. Called from the cached handle's
 * `close()` method. After a release, re-run eviction in case the cache had
 * grown past the cap because every entry was borrowed.
 */
function releaseCachedDatabase(key: string): void {
  const entry = cachedDatabases.get(key);
  if (!entry) {
    return;
  }
  if (entry.refcount > 0) {
    entry.refcount -= 1;
  }
  if (cachedDatabases.size > CACHED_DATABASES_CAPACITY) {
    evictLruIfNeeded();
  }
}

export function closeCachedDatabases(): void {
  for (const entry of cachedDatabases.values()) {
    closeCachedHandle(entry.handle);
  }
  cachedDatabases.clear();
  warnedOnTransientOvergrowth = false;
}

/**
 * Test-only: report the current size of the daemon-mode database cache.
 * Production code never inspects this — used by `tests/runtime/cache-bound`.
 */
export function cachedDatabasesSize(): number {
  return cachedDatabases.size;
}

export function openTrekoonDatabase(
  workingDirectory: string = process.cwd(),
  options: OpenTrekoonDatabaseOptions = {},
): TrekoonDatabase {
  const paths: StoragePaths = resolveStoragePaths(workingDirectory);

  // Daemon-mode reuse: when running inside `trekoon serve`, return a cached
  // connection so each request avoids the migration probe and database open.
  if (isDaemonInProcessCacheEnabled()) {
    const cachedEntry = cachedDatabases.get(paths.databaseFile);
    if (cachedEntry) {
      // Honor autoMigrate on the cached-handle path: a previous request that
      // opened this DB with `{autoMigrate: false}` (e.g. migrate-status) may
      // have left the schema below LATEST_MIGRATION_VERSION. The next request
      // that asks for autoMigrate (the default) must still get a migrated DB.
      if (
        (options.autoMigrate ?? true)
        && readCurrentMigrationVersionReadOnly(cachedEntry.handle.db) < LATEST_MIGRATION_VERSION
      ) {
        migrateDatabase(cachedEntry.handle.db);
      }
      // Refresh LRU position on access and increment the in-use refcount so
      // `evictLruIfNeeded` cannot close this entry under the borrower.
      cachedEntry.refcount += 1;
      touchCachedDatabase(paths.databaseFile, cachedEntry);
      return cachedEntry.handle;
    }
  }

  // Fast path: if no legacy .trekoon/trekoon.db exists in the current worktree,
  // skip the git-heavy recoverWorktreeDatabaseState entirely.
  const legacyDbFile: string = resolveLegacyWorktreeDatabaseFile(paths.worktreeRoot);
  const recovery: WorktreeRecoveryDiagnostics =
    legacyDbFile !== paths.databaseFile && !existsSync(legacyDbFile)
      ? NO_LEGACY_RECOVERY
      : recoverWorktreeDatabaseState(paths);

  const diagnostics: StorageResolutionDiagnostics = buildStorageResolutionDiagnostics(paths, recovery);

  mkdirSync(paths.storageDir, { recursive: true });

  const db: Database = new Database(paths.databaseFile, { create: true });

  db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  if (options.autoMigrate ?? true) {
    migrateDatabase(db);
  }

  if (isDaemonInProcessCacheEnabled()) {
    const cachedHandle: TrekoonDatabase = {
      db,
      paths,
      diagnostics,
      close(): void {
        // No-op: the daemon owns the lifetime, freed via closeCachedDatabases().
      },
    };
    // Bound the cache before insertion so a daemon serving many distinct
    // cwds doesn't accumulate open FDs without limit.
    evictLruIfNeeded();
    cachedDatabases.set(paths.databaseFile, cachedHandle);
    return cachedHandle;
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
