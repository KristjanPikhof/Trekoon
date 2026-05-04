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
import { buildBoardSnapshot, type BoardSnapshot } from "./snapshot";

const IN_PROCESS_WAL_SUPPRESS_MS = 500;

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

function recordMatchesPublishedDelta(record: unknown, publishedRecord: unknown): boolean {
  const recordKey = recordChangeKey(record);
  const publishedKey = recordChangeKey(publishedRecord);
  const hasComparableKey =
    recordKey.version !== null ||
    recordKey.updatedAt !== null ||
    publishedKey.version !== null ||
    publishedKey.updatedAt !== null;

  if (hasComparableKey) {
    return changeKeyEqual(recordKey, publishedKey);
  }

  return JSON.stringify(record) === JSON.stringify(publishedRecord);
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

function recordsByIdFromDelta(delta: Record<string, unknown> | null, key: string): Map<string, unknown> {
  const records = delta?.[key];
  const index = new Map<string, unknown>();
  if (!Array.isArray(records)) {
    return index;
  }

  for (const record of records) {
    const id = recordId(record);
    if (id !== null) {
      index.set(id, record);
    }
  }

  return index;
}

function deletedIdsFromDelta(delta: Record<string, unknown> | null, key: string): Set<string> {
  const ids = delta?.[key];
  if (!Array.isArray(ids)) {
    return new Set();
  }

  return new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0));
}

function suppressAlreadyPublishedDiff(
  diff: CollectionDiff,
  publishedRecords: Map<string, unknown>,
  publishedDeletedIds: Set<string>,
): CollectionDiff {
  return {
    upserted: diff.upserted.filter((record) => {
      const id = recordId(record);
      if (id === null) {
        return true;
      }

      const publishedRecord = publishedRecords.get(id);
      return publishedRecord === undefined || !recordMatchesPublishedDelta(record, publishedRecord);
    }),
    deletedIds: diff.deletedIds.filter((id) => !publishedDeletedIds.has(id)),
  };
}

function hasDiffChanges(...diffs: readonly CollectionDiff[]): boolean {
  return diffs.some((diff) => diff.upserted.length > 0 || diff.deletedIds.length > 0);
}

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
  /**
   * Optional snapshot builder override. Defaults to {@link buildBoardSnapshot}.
   * Tests inject a throwing or stubbed builder to exercise failure paths.
   */
  readonly buildSnapshot?: (domain: TrackerDomain) => BoardSnapshot;
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
  const buildSnapshot = options.buildSnapshot ?? buildBoardSnapshot;

  let lastSnapshot = buildSnapshot(domain);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let failures = 0;
  let lastSuppressedInProcessWriteAt = 0;

  function reconcile(): void {
    if (closed) {
      return;
    }
    const inProcessWriteAt = options.eventBus.lastInProcessWriteAt;
    const shouldSuppressInProcessTick =
      inProcessWriteAt > lastSuppressedInProcessWriteAt &&
      Date.now() - inProcessWriteAt <= IN_PROCESS_WAL_SUPPRESS_MS;

    try {
      const fresh = buildSnapshot(domain);
      const epicsDiff = diffById(lastSnapshot.epics, fresh.epics);
      const tasksDiff = diffById(lastSnapshot.tasks, fresh.tasks);
      const subtasksDiff = diffById(lastSnapshot.subtasks, fresh.subtasks);
      const dependenciesDiff = diffById(lastSnapshot.dependencies, fresh.dependencies);

      const shouldSuppressDiff = shouldSuppressInProcessTick
        ? {
            epics: suppressAlreadyPublishedDiff(
              epicsDiff,
              recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "epics"),
              deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedEpicIds"),
            ),
            tasks: suppressAlreadyPublishedDiff(
              tasksDiff,
              recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "tasks"),
              deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedTaskIds"),
            ),
            subtasks: suppressAlreadyPublishedDiff(
              subtasksDiff,
              recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "subtasks"),
              deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedSubtaskIds"),
            ),
            dependencies: suppressAlreadyPublishedDiff(
              dependenciesDiff,
              recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "dependencies"),
              deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedDependencyIds"),
            ),
          }
        : null;

      if (shouldSuppressInProcessTick) {
        lastSuppressedInProcessWriteAt = inProcessWriteAt;
      }

      const publishEpicsDiff = shouldSuppressDiff?.epics ?? epicsDiff;
      const publishTasksDiff = shouldSuppressDiff?.tasks ?? tasksDiff;
      const publishSubtasksDiff = shouldSuppressDiff?.subtasks ?? subtasksDiff;
      const publishDependenciesDiff = shouldSuppressDiff?.dependencies ?? dependenciesDiff;

      const hasChanges = hasDiffChanges(publishEpicsDiff, publishTasksDiff, publishSubtasksDiff, publishDependenciesDiff);

      lastSnapshot = fresh;

      if (!hasChanges) {
        return;
      }

      options.eventBus.publishSnapshotDelta({
        generatedAt: Date.now(),
        source: "wal-watcher",
        epics: publishEpicsDiff.upserted,
        tasks: publishTasksDiff.upserted,
        subtasks: publishSubtasksDiff.upserted,
        dependencies: publishDependenciesDiff.upserted,
        deletedEpicIds: publishEpicsDiff.deletedIds,
        deletedTaskIds: publishTasksDiff.deletedIds,
        deletedSubtaskIds: publishSubtasksDiff.deletedIds,
        deletedDependencyIds: publishDependenciesDiff.deletedIds,
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
