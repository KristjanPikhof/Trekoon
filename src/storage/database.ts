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

/**
 * Re-inspect worktree state on a daemon-mode cache hit so out-of-band changes
 * to the worktree (e.g. an operator restoring a legacy `.trekoon/trekoon.db`
 * after the daemon started, or a new tracked-vs-ignored conflict) surface to
 * the caller through `diagnostics.recoveryRequired` instead of being masked
 * by the cached handle's stale snapshot. Returns NO_LEGACY_RECOVERY when the
 * fast-path no-legacy-DB shortcut applies and falls back to the
 * DomainError-aware capture used by `resolveStorageResolutionDiagnostics`
 * when inspection itself raises (e.g. tracked_ignored_mismatch).
 */
function reinspectRecoveryForCacheHit(paths: StoragePaths): WorktreeRecoveryDiagnostics {
  const legacyDbFile: string = resolveLegacyWorktreeDatabaseFile(paths.worktreeRoot);
  if (legacyDbFile !== paths.databaseFile && !existsSync(legacyDbFile)) {
    return NO_LEGACY_RECOVERY;
  }

  try {
    return inspectWorktreeDatabaseState(paths);
  } catch (error) {
    if (!(error instanceof DomainError)) {
      throw error;
    }
    const details: Record<string, unknown> = error.details ?? {};
    return {
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
  }
}

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
  for (const [key, entry] of cachedDatabases) {
    if (entry.refcount > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[trekoon daemon] leaving cached database open during shutdown because it is still borrowed: ${key}`,
      );
      continue;
    }
    closeCachedHandle(entry.handle);
    cachedDatabases.delete(key);
  }
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

      // Re-inspect worktree state on every cache hit so out-of-band changes
      // (legacy DB restored after daemon start, fresh tracked/ignored
      // mismatch, etc.) surface to callers through fresh diagnostics. The
      // cached `handle.diagnostics` is a frozen snapshot from the original
      // open and would otherwise mask a freshly-required recovery — leading
      // `session` and friends to silently proceed against a stale state.
      const refreshedRecovery: WorktreeRecoveryDiagnostics = reinspectRecoveryForCacheHit(paths);
      const refreshedDiagnostics: StorageResolutionDiagnostics =
        buildStorageResolutionDiagnostics(paths, refreshedRecovery);

      // Refresh LRU position on access and increment the in-use refcount so
      // `evictLruIfNeeded` cannot close this entry under the borrower.
      cachedEntry.refcount += 1;
      touchCachedDatabase(paths.databaseFile, cachedEntry);

      const cacheKey: string = paths.databaseFile;
      // Return a per-request handle wrapper that exposes the refreshed
      // diagnostics while sharing the underlying connection. The wrapper's
      // close() releases the same cache key the cached entry's close()
      // does, so refcount accounting stays consistent regardless of which
      // handle the caller holds.
      return {
        db: cachedEntry.handle.db,
        paths: cachedEntry.handle.paths,
        diagnostics: refreshedDiagnostics,
        close(): void {
          releaseCachedDatabase(cacheKey);
        },
      };
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

  // Open-time read+write throughput tuning. WAL is required (set above);
  // the rest are layered on top.
  //
  // synchronous: WAL+NORMAL is the documented standard pairing
  // (https://www.sqlite.org/wal.html#performance_considerations) — durability
  // semantics: on a hard kernel/OS crash the last unfsynced transactions can
  // be lost, but the DB file itself never corrupts. Operators who want the
  // pre-tuning behaviour (synchronous=FULL) can set
  // TREKOON_SQLITE_DURABILITY=full at open time.
  const durabilityMode: string = (process.env.TREKOON_SQLITE_DURABILITY ?? "").toLowerCase();
  if (durabilityMode === "full") {
    db.exec("PRAGMA synchronous = FULL;");
  } else {
    db.exec("PRAGMA synchronous = NORMAL;");
  }

  // temp_store=MEMORY keeps temp B-tree sorts and intermediate result sets
  // out of the temp file on disk — most relevant for the ORDER BY paths
  // that pre-0013 schemas relied on temp-b-tree sorts for.
  db.exec("PRAGMA temp_store = MEMORY;");

  // mmap_size: opportunistic memory-mapped reads for the first 256 MiB of
  // the DB file. Reduces read syscall overhead for hot pages. bun:sqlite
  // forwards the PRAGMA to libsqlite3; the connection will silently keep
  // the previous value if the platform does not support mmap.
  db.exec("PRAGMA mmap_size = 268435456;");

  // cache_size negative value -> KiB, positive value -> pages.
  // Default: 64 MiB. Override with TREKOON_SQLITE_CACHE_MIB (integer MiB).
  // Negative values are rejected. With 16-handle daemon mode the per-process
  // page cache approaches CACHED_DATABASES_CAPACITY × cache_size, so
  // operators should lower TREKOON_SQLITE_CACHE_MIB (e.g. to 16) when memory
  // is constrained.
  const cacheMibRaw: string = (process.env.TREKOON_SQLITE_CACHE_MIB ?? "").trim();
  const cacheMib: number = cacheMibRaw.length > 0 ? Number(cacheMibRaw) : 64;
  if (!Number.isInteger(cacheMib) || cacheMib < 0) {
    throw new DomainError({
      code: "invalid_config",
      message:
        `TREKOON_SQLITE_CACHE_MIB must be a non-negative integer (got ${JSON.stringify(cacheMibRaw)}).`,
      details: { envVar: "TREKOON_SQLITE_CACHE_MIB", provided: cacheMibRaw },
    });
  }
  db.exec(`PRAGMA cache_size = ${-(cacheMib * 1024)};`);

  // Trigger a checkpoint roughly every 1000 frames so the WAL file does
  // not grow unbounded under sustained writes. Default is 1000 already,
  // but we pin it explicitly so the value cannot drift if libsqlite3
  // changes its default in a future bump.
  db.exec("PRAGMA wal_autocheckpoint = 1000;");

  if (options.autoMigrate ?? true) {
    migrateDatabase(db);
  }

  if (isDaemonInProcessCacheEnabled()) {
    const cacheKey: string = paths.databaseFile;
    const cachedHandle: TrekoonDatabase = {
      db,
      paths,
      diagnostics,
      close(): void {
        // The daemon owns the lifetime (freed via closeCachedDatabases()), but
        // we still need to track in-use refcount so eviction does not close a
        // handle that an in-flight request is still using.
        releaseCachedDatabase(cacheKey);
      },
    };
    // Bound the cache before insertion so a daemon serving many distinct
    // cwds doesn't accumulate open FDs without limit. Eviction will skip
    // entries that other requests are currently borrowing.
    evictLruIfNeeded();
    // Initial refcount = 1 reflects the borrow taken by THIS caller.
    cachedDatabases.set(cacheKey, { handle: cachedHandle, refcount: 1 });
    return cachedHandle;
  }

  return {
    db,
    paths,
    diagnostics,
    close(): void {
      // Best-effort checkpoint: matches closeCachedHandle's posture. WAL
      // checkpointing is maintenance, not durability — skipping it cannot
      // corrupt the DB. Suppressing errors here lets read-only contexts
      // (read-only filesystem, immutable DB file, sandboxed agents) close
      // cleanly instead of throwing SQLITE_READONLY on the very last
      // syscall before db.close().
      try {
        db.exec("PRAGMA wal_checkpoint(PASSIVE);");
      } catch {
        /* best effort — checkpoint is maintenance, not durability */
      }
      try {
        db.close(false);
      } catch {
        /* best effort — handle may already be closing */
      }
    },
  };
}
