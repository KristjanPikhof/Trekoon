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

interface SnapshotRecord {
  readonly id: string;
  readonly updatedAt?: number;
}

interface CollectionDiff {
  readonly upserted: Record<string, unknown>[];
  readonly deletedIds: string[];
}

function diffById(
  previous: readonly Record<string, unknown>[] | undefined,
  current: readonly Record<string, unknown>[] | undefined,
): CollectionDiff {
  const previousIndex = new Map<string, Record<string, unknown>>();
  for (const record of previous ?? []) {
    if (record && typeof (record as SnapshotRecord).id === "string") {
      previousIndex.set((record as SnapshotRecord).id, record);
    }
  }

  const upserted: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const record of current ?? []) {
    if (!record || typeof (record as SnapshotRecord).id !== "string") {
      continue;
    }

    const id = (record as SnapshotRecord).id;
    seen.add(id);
    const previousRecord = previousIndex.get(id);
    if (!previousRecord || JSON.stringify(previousRecord) !== JSON.stringify(record)) {
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
}

export interface WalWatcher {
  /**
   * Force a reconciliation outside the normal mtime-driven path. Useful for
   * tests and for kicking the watcher after a manual external change.
   */
  reconcile(): void;
  close(): void;
}

export function startWalWatcher(options: WalWatcherOptions): WalWatcher {
  const debounceMs = options.debounceMs ?? 150;
  const walFile = `${options.databaseFile}-wal`;
  const watchDir = dirname(options.databaseFile);
  const dbBaseName = basename(options.databaseFile);

  let lastSnapshot = buildBoardSnapshot(new TrackerDomain(options.db)) as Record<string, unknown> & {
    epics: Record<string, unknown>[];
    tasks: Record<string, unknown>[];
    subtasks: Record<string, unknown>[];
    dependencies: Record<string, unknown>[];
  };

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function reconcile(): void {
    if (closed) {
      return;
    }

    const fresh = buildBoardSnapshot(new TrackerDomain(options.db)) as Record<string, unknown> & {
      epics: Record<string, unknown>[];
      tasks: Record<string, unknown>[];
      subtasks: Record<string, unknown>[];
      dependencies: Record<string, unknown>[];
    };

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
      try {
        reconcile();
      } catch {
        // Reconciliation must never crash the server. Errors here usually mean
        // the database is mid-write; the next mtime tick will retry.
      }
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
