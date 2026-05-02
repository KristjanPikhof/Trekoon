/**
 * WAL watcher.
 *
 * Watches the SQLite WAL sidecar (`<dbfile>-wal`) for mtime changes so
 * mutations issued by another process (e.g. `trekoon task update` running in
 * a different shell) are picked up and pushed to SSE subscribers.
 *
 * The watcher is intentionally _decoupled_ from the in-process MutationService
 * event path: in-process writes already publish their own deltas via the
 * route handler, so we treat WAL mtime changes as a hint that "something
 * changed somewhere" and reconcile by comparing a fresh snapshot against the
 * last snapshot we broadcast. Only entities that actually differ end up in
 * the published delta.
 */

import { existsSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, basename } from "node:path";

import { type Database } from "bun:sqlite";

import { TrackerDomain } from "../domain/tracker-domain";
import { type BoardEventBus } from "./event-bus";
import { buildBoardSnapshot } from "./snapshot";

interface CollectionDiff {
  readonly upserted: unknown[];
  readonly deletedIds: string[];
}

function recordId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * Extract the (version, updatedAt) tuple used to detect content changes.
 *
 * `updatedAt` is bumped on every domain write; `version` is incremented in
 * lockstep at the SQLite layer. Comparing the tuple lets us bail out cheaply
 * when neither has moved, avoiding the JSON.stringify hot path that fires on
 * every WAL tick — including ticks where only non-content shape changed
 * (e.g. dependency reordering of an unrelated record produced an array
 * identity change but no semantic delta for the entity in question).
 */
function recordChangeKey(value: unknown): { version: number | null; updatedAt: number | null } {
  if (!value || typeof value !== "object") {
    return { version: null, updatedAt: null };
  }
  const versionRaw = (value as { version?: unknown }).version;
  const updatedAtRaw = (value as { updatedAt?: unknown }).updatedAt;
  return {
    version: typeof versionRaw === "number" ? versionRaw : null,
    updatedAt: typeof updatedAtRaw === "number" ? updatedAtRaw : null,
  };
}

function changeKeyEqual(
  a: { version: number | null; updatedAt: number | null },
  b: { version: number | null; updatedAt: number | null },
): boolean {
  return a.version === b.version && a.updatedAt === b.updatedAt;
}

function diffById(previous: readonly unknown[] | undefined, current: readonly unknown[] | undefined): CollectionDiff {
  const previousIndex = new Map<string, unknown>();
  for (const record of previous ?? []) {
    const id = recordId(record);
    if (id !== null) {
      previousIndex.set(id, record);
    }
  }

  const upserted: unknown[] = [];
  const seen = new Set<string>();
  for (const record of current ?? []) {
    const id = recordId(record);
    if (id === null) {
      continue;
    }

    seen.add(id);
    const previousRecord = previousIndex.get(id);
    if (!previousRecord) {
      upserted.push(record);
      continue;
    }
    // Tuple compare on (version, updatedAt) — both move in lockstep on every
    // domain write. Equal tuple → no content change → skip the upsert.
    if (!changeKeyEqual(recordChangeKey(previousRecord), recordChangeKey(record))) {
      upserted.push(record);
    }
  }

  const deletedIds: string[] = [];
  for (const id of previousIndex.keys()) {
    if (!seen.has(id)) {
      deletedIds.push(id);
    }
  }

  return { upserted, deletedIds };
}

export interface WalWatcherOptions {
  readonly db: Database;
  readonly databaseFile: string;
  readonly eventBus: BoardEventBus;
  /**
   * How long to coalesce successive mtime change events. Defaults to 150ms
   * which is small enough to feel real-time and large enough to absorb the
   * burst of write events that SQLite emits within a single transaction.
   */
  readonly debounceMs?: number;
  /**
   * Log every Nth reconcile failure at warn level. Defaults to 5.
   */
  readonly logEveryNthFailure?: number;
  /**
   * Optional logger override; defaults to `console.warn`. Used by tests to
   * assert failure-counter behavior without polluting stderr.
   */
  readonly logger?: (message: string, error: unknown) => void;
}

export interface WalWatcher {
  /**
   * Force a reconciliation outside the normal mtime-driven path. Useful for
   * tests and for kicking the watcher after a manual external change.
   */
  reconcile(): void;
  /**
   * Total number of reconcile failures since the watcher started. Exposed for
   * tests and operators; the watcher itself never throws.
   */
  readonly failureCount: () => number;
  close(): void;
}

export function startWalWatcher(options: WalWatcherOptions): WalWatcher {
  const debounceMs = options.debounceMs ?? 150;
  const logEveryNthFailure = Math.max(1, options.logEveryNthFailure ?? 5);
  const logger = options.logger ?? ((message: string, error: unknown): void => {
    // eslint-disable-next-line no-console
    console.warn(message, error);
  });
  const walFile = `${options.databaseFile}-wal`;
  const watchDir = dirname(options.databaseFile);
  const dbBaseName = basename(options.databaseFile);

  // Hoist TrackerDomain construction out of reconcile: build once and reuse
  // across ticks. The domain is a thin wrapper over the bun:sqlite Database
  // handle and holds prepared-statement caches — recreating it per tick burns
  // CPU on large boards. The handle stays valid for the lifetime of the
  // server, so re-binding is unnecessary.
  const domain = new TrackerDomain(options.db);

  let lastSnapshot = buildBoardSnapshot(domain);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let failures = 0;

  function reconcile(): void {
    if (closed) {
      return;
    }

    try {
      const fresh = buildBoardSnapshot(domain);

      const epicsDiff = diffById(lastSnapshot.epics, fresh.epics);
      const tasksDiff = diffById(lastSnapshot.tasks, fresh.tasks);
      const subtasksDiff = diffById(lastSnapshot.subtasks, fresh.subtasks);
      const dependenciesDiff = diffById(lastSnapshot.dependencies, fresh.dependencies);

      const hasChanges =
        epicsDiff.upserted.length > 0 || epicsDiff.deletedIds.length > 0 ||
        tasksDiff.upserted.length > 0 || tasksDiff.deletedIds.length > 0 ||
        subtasksDiff.upserted.length > 0 || subtasksDiff.deletedIds.length > 0 ||
        dependenciesDiff.upserted.length > 0 || dependenciesDiff.deletedIds.length > 0;

      lastSnapshot = fresh;

      if (!hasChanges) {
        return;
      }

      options.eventBus.publishSnapshotDelta({
        generatedAt: Date.now(),
        source: "wal-watcher",
        epics: epicsDiff.upserted,
        tasks: tasksDiff.upserted,
        subtasks: subtasksDiff.upserted,
        dependencies: dependenciesDiff.upserted,
        deletedEpicIds: epicsDiff.deletedIds,
        deletedTaskIds: tasksDiff.deletedIds,
        deletedSubtaskIds: subtasksDiff.deletedIds,
        deletedDependencyIds: dependenciesDiff.deletedIds,
      });
    } catch (error) {
      // Reconciliation must never crash the server. Errors here usually mean
      // the database is mid-write or a downstream snapshot builder threw; the
      // next mtime tick will retry. Log every Nth failure to keep operators
      // informed without flooding stderr on persistent faults.
      failures += 1;
      if (failures % logEveryNthFailure === 0) {
        logger(`wal-watcher: reconcile failed (${failures} total failures)`, error);
      }
    }
  }

  function scheduleReconcile(): void {
    if (closed) {
      return;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      reconcile();
    }, debounceMs);
  }

  // Track WAL mtime when available, so we only react to actual changes rather
  // than spurious watcher fires (e.g. atime-only updates on some filesystems).
  let lastWalMtime: number = readMtime(walFile);

  function readMtime(path: string): number {
    if (!existsSync(path)) {
      return 0;
    }
    try {
      return statSync(path).mtimeMs;
    } catch {
      return 0;
    }
  }

  function maybeScheduleReconcile(): void {
    const currentMtime = readMtime(walFile);
    // mtime can equal 0 when the WAL was just checkpointed and removed; treat
    // any change (including transitions to/from 0) as worth reconciling.
    if (currentMtime !== lastWalMtime) {
      lastWalMtime = currentMtime;
      scheduleReconcile();
    }
  }

  // We watch the directory rather than the WAL file directly because the WAL
  // file can be unlinked (e.g. on checkpoint) which invalidates a direct
  // file watch on some platforms.
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(watchDir, (_eventType, filename) => {
      if (closed) {
        return;
      }
      if (typeof filename === "string" && filename !== `${dbBaseName}-wal` && filename !== dbBaseName) {
        return;
      }
      maybeScheduleReconcile();
    });
    watcher.on("error", () => {
      // Best-effort; ignore transient watcher errors.
    });
  } catch {
    // Filesystem watch is best-effort. If it cannot be set up (e.g. read-only
    // filesystem), the watcher silently degrades and only `reconcile()` calls
    // will publish deltas.
    watcher = null;
  }

  return {
    reconcile,
    failureCount: (): number => failures,
    close(): void {
      closed = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        try {
          watcher.close();
        } catch {
          // Already closed.
        }
        watcher = null;
      }
    },
  };
}
