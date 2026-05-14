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
import { buildBoardSnapshot, buildBoardSnapshotDelta, type BoardSnapshot } from "./snapshot";

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

/**
 * Test-only call counter for {@link derivedRecordFingerprint}. Tests assert the
 * leaf short-circuit path never enters this function. Production callers ignore
 * the counter entirely.
 */
let derivedFingerprintCalls = 0;

/** @internal — exposed for tests to verify the leaf no-stringify invariant. */
export function __resetDerivedFingerprintCallCount(): void {
  derivedFingerprintCalls = 0;
}

/** @internal — exposed for tests to verify the leaf no-stringify invariant. */
export function __getDerivedFingerprintCallCount(): number {
  return derivedFingerprintCalls;
}

function derivedRecordFingerprint(value: unknown): string {
  derivedFingerprintCalls += 1;
  if (!value || typeof value !== "object") {
    return JSON.stringify(value);
  }

  const record = value as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";

  if (kind === "task") {
    return JSON.stringify({
      blockedBy: record.blockedBy,
      blocks: record.blocks,
      dependencyIds: record.dependencyIds,
      dependentIds: record.dependentIds,
      subtasks: record.subtasks,
      searchText: record.searchText,
    });
  }

  if (kind === "subtask") {
    return JSON.stringify({
      blockedBy: record.blockedBy,
      blocks: record.blocks,
      dependencyIds: record.dependencyIds,
      dependentIds: record.dependentIds,
      searchText: record.searchText,
    });
  }

  if ("taskIds" in record || "counts" in record) {
    return JSON.stringify({
      taskIds: record.taskIds,
      counts: record.counts,
      searchText: record.searchText,
    });
  }

  return JSON.stringify(record);
}

function recordMatchesPublishedDelta(
  record: unknown,
  publishedRecord: unknown,
  options: { readonly isLeaf: boolean },
): boolean {
  const recordKey = recordChangeKey(record);
  const publishedKey = recordChangeKey(publishedRecord);
  if (!changeKeyEqual(recordKey, publishedKey)) {
    return false;
  }

  // Leaf entities (subtask, dependency) have no derived-field fan-in beyond
  // dependency rows themselves, and dependency rows always ship as their own
  // collection delta. A matching (version, updatedAt) tuple is therefore
  // sufficient to confirm the leaf record has not diverged from what the
  // route handler already published — no JSON.stringify needed.
  if (options.isLeaf) {
    return true;
  }

  return derivedRecordFingerprint(record) === derivedRecordFingerprint(publishedRecord);
}

function recordChanged(
  previousRecord: unknown,
  currentRecord: unknown,
  options: { readonly isLeaf: boolean },
): boolean {
  if (!changeKeyEqual(recordChangeKey(previousRecord), recordChangeKey(currentRecord))) {
    return true;
  }

  // Leaf entities (subtask, dependency) carry only fields that are mutated
  // through their own row writes — and those writes bump (version, updatedAt)
  // in lockstep. Matching tuples therefore mean the leaf row is genuinely
  // unchanged; we can short-circuit without paying the JSON.stringify cost.
  //
  // Subtask derived fields (blockedBy/blocks/dependencyIds/dependentIds) are
  // recomputed by the client from the dependency-row collection (see
  // src/board/assets/state/utils.js), so any dep change reaches subscribers
  // via the dependencies delta even when the subtask short-circuits here.
  if (options.isLeaf) {
    return false;
  }

  // Parent entities (epic, task) carry derived fields (task counts, taskIds,
  // subtasks list, searchText, blocks/blockedBy) that can shift without the
  // parent row's version moving. Keep the fingerprint comparison so child
  // writes still surface through the parent record.
  return derivedRecordFingerprint(previousRecord) !== derivedRecordFingerprint(currentRecord);
}

function diffById(
  previous: readonly unknown[] | undefined,
  current: readonly unknown[] | undefined,
  options: { readonly isLeaf: boolean },
): CollectionDiff {
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
    if (recordChanged(previousRecord, record, options)) {
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
  options: { readonly isLeaf: boolean },
): CollectionDiff {
  return {
    upserted: diff.upserted.filter((record) => {
      const id = recordId(record);
      if (id === null) {
        return true;
      }

      const publishedRecord = publishedRecords.get(id);
      return publishedRecord === undefined || !recordMatchesPublishedDelta(record, publishedRecord, options);
    }),
    deletedIds: diff.deletedIds.filter((id) => !publishedDeletedIds.has(id)),
  };
}

function hasDiffChanges(...diffs: readonly CollectionDiff[]): boolean {
  return diffs.some((diff) => diff.upserted.length > 0 || diff.deletedIds.length > 0);
}

// -- Event-cursor reconciliation -------------------------------------------
//
// Reads canonical mutation events appended by `appendEventWithGitContext`
// (src/sync/event-writes.ts) and translates them into the minimal set of
// entity IDs whose snapshot rows must be re-read. This lets the watcher avoid
// a full board read on every WAL tick — the dominant cost on large boards.
//
// The full-snapshot diff path is kept as a fallback for cases where the event
// stream is not safely consumable (cursor pruned, parse failure, first-tick
// warm-up, or any unexpected event shape).

interface EventRow {
  readonly id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly operation: string;
  readonly payload: string;
  readonly created_at: number;
}

interface EventCursor {
  readonly createdAt: number;
  readonly id: string;
}

interface EventCursorDelta {
  readonly epicIds: string[];
  readonly taskIds: string[];
  readonly subtaskIds: string[];
  readonly dependencyIds: string[];
  readonly deletedEpicIds: string[];
  readonly deletedTaskIds: string[];
  readonly deletedSubtaskIds: string[];
  readonly deletedDependencyIds: string[];
}

type EventCursorReconcileResult =
  | { readonly kind: "ok"; readonly newCursor: EventCursor; readonly delta: EventCursorDelta }
  | { readonly kind: "fallback"; readonly reason: string };

/** Read the most recent event row to seed the cursor at watcher start. */
function readLatestEventCursor(db: Database): EventCursor | null {
  const row = db
    .query(
      "SELECT id, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT 1;",
    )
    .get() as { id: string; created_at: number } | null;
  if (!row) {
    return null;
  }
  return { createdAt: row.created_at, id: row.id };
}

/**
 * Determine whether a non-null cursor predates the retained-events window —
 * i.e. the event the cursor points at is missing from the live `events` table
 * AND there are older retained events on any branch. When that happens the
 * watcher cannot derive the diff from events alone and must fall back.
 *
 * We avoid the more expensive per-branch retention check that `sync/service.ts`
 * does for sync cursors: the watcher consumes events across all branches, so a
 * single "is this cursor.id still present in events?" check is enough — if the
 * row is gone, the safe move is fallback.
 */
function isCursorStale(db: Database, cursor: EventCursor): boolean {
  const row = db
    .query("SELECT 1 AS hit FROM events WHERE id = ? LIMIT 1;")
    .get(cursor.id) as { hit: number } | null;
  return row === null;
}

/**
 * Read events after `cursor` ordered by (created_at, id). When `cursor` is
 * null the caller must already be on the fallback path; this helper is not
 * invoked.
 */
function readEventsSinceCursor(db: Database, cursor: EventCursor): EventRow[] {
  return db
    .query(
      `SELECT id, entity_kind, entity_id, operation, payload, created_at
       FROM events
       WHERE (created_at > ?) OR (created_at = ? AND id > ?)
       ORDER BY created_at ASC, id ASC;`,
    )
    .all(cursor.createdAt, cursor.createdAt, cursor.id) as EventRow[];
}

/**
 * Translate a list of event rows into per-kind upsert/delete ID sets that
 * can be fed to {@link buildBoardSnapshotDelta}. Returns `null` if any event
 * payload fails to parse or the entity_kind/operation pair is unknown — the
 * caller treats `null` as a signal to fall back to the full-snapshot path.
 *
 * Parent-ascendant fan-in: when a task event fires, the parent epic must also
 * be included so derived fields (taskIds, counts, searchText) reach the
 * client. When a subtask event fires, the parent task and grandparent epic
 * must also be included. We pull payloads (`epic_id`, `task_id`) first and
 * fall back to a domain lookup for deletions or older events without those
 * fields.
 *
 * Dependency events fan in both endpoints' parents so blocked-by/blocks
 * derived arrays on the endpoints' epic/task records stay in sync.
 */
function eventsToCursorDelta(events: readonly EventRow[], domain: TrackerDomain): EventCursorDelta | null {
  const epicIds = new Set<string>();
  const taskIds = new Set<string>();
  const subtaskIds = new Set<string>();
  const dependencyIds = new Set<string>();
  const deletedEpicIds = new Set<string>();
  const deletedTaskIds = new Set<string>();
  const deletedSubtaskIds = new Set<string>();
  const deletedDependencyIds = new Set<string>();

  const includeTaskAndEpicForTaskId = (taskId: string, payloadEpicId: unknown): void => {
    taskIds.add(taskId);
    if (typeof payloadEpicId === "string" && payloadEpicId.length > 0) {
      epicIds.add(payloadEpicId);
      return;
    }
    const task = domain.getTask(taskId);
    if (task) {
      epicIds.add(task.epicId);
    }
  };

  const includeSubtaskWithAscendants = (subtaskId: string, payloadTaskId: unknown): void => {
    subtaskIds.add(subtaskId);
    let resolvedTaskId: string | null = null;
    if (typeof payloadTaskId === "string" && payloadTaskId.length > 0) {
      resolvedTaskId = payloadTaskId;
    } else {
      resolvedTaskId = domain.getSubtask(subtaskId)?.taskId ?? null;
    }
    if (resolvedTaskId !== null) {
      includeTaskAndEpicForTaskId(resolvedTaskId, undefined);
    }
  };

  const includeDependencyEndpointParents = (sourceId: unknown, sourceKind: unknown, targetId: unknown, targetKind: unknown): void => {
    const endpoints: Array<{ id: string; kind: string }> = [];
    if (typeof sourceId === "string" && sourceId.length > 0) {
      endpoints.push({ id: sourceId, kind: typeof sourceKind === "string" ? sourceKind : "" });
    }
    if (typeof targetId === "string" && targetId.length > 0) {
      endpoints.push({ id: targetId, kind: typeof targetKind === "string" ? targetKind : "" });
    }
    for (const endpoint of endpoints) {
      if (endpoint.kind === "subtask") {
        includeSubtaskWithAscendants(endpoint.id, undefined);
      } else {
        includeTaskAndEpicForTaskId(endpoint.id, undefined);
      }
    }
  };

  for (const event of events) {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(event.payload);
    } catch {
      return null;
    }

    const fields = (parsedPayload as { fields?: Record<string, unknown> })?.fields ?? {};

    switch (event.entity_kind) {
      case "epic": {
        if (event.operation === "epic.created" || event.operation === "epic.updated") {
          epicIds.add(event.entity_id);
        } else if (event.operation === "epic.deleted") {
          deletedEpicIds.add(event.entity_id);
        } else {
          return null;
        }
        break;
      }
      case "task": {
        if (event.operation === "task.created" || event.operation === "task.updated") {
          includeTaskAndEpicForTaskId(event.entity_id, fields.epic_id);
        } else if (event.operation === "task.deleted") {
          // Non-cascade task deletes carry `epic_id` in fields so the watcher
          // can fan-in the parent epic (taskIds / counts / searchText all
          // change). Cascade deletes omit `epic_id` because the matching
          // `epic.deleted` event already surfaces the epic-level change —
          // including the parent there would emit an upsert for a doomed
          // epic alongside its deletedEpicIds entry.
          if (typeof fields.epic_id === "string" && fields.epic_id.length > 0) {
            epicIds.add(fields.epic_id);
          }
          deletedTaskIds.add(event.entity_id);
        } else {
          return null;
        }
        break;
      }
      case "subtask": {
        if (event.operation === "subtask.created" || event.operation === "subtask.updated") {
          includeSubtaskWithAscendants(event.entity_id, fields.task_id);
        } else if (event.operation === "subtask.deleted") {
          deletedSubtaskIds.add(event.entity_id);
          // Parent task's subtasks list / searchText changed too: re-emit it.
          const parentTaskId = typeof fields.task_id === "string" && fields.task_id.length > 0
            ? fields.task_id
            : domain.getSubtask(event.entity_id)?.taskId ?? null;
          if (parentTaskId !== null) {
            includeTaskAndEpicForTaskId(parentTaskId, undefined);
          }
        } else {
          return null;
        }
        break;
      }
      case "dependency": {
        // Dependency entity_id is the composite "sourceKind:sourceId->dependsOnKind:dependsOnId".
        // The actual dependency row id lives in payload.fields.dependency_id (see
        // mutation-service.#dependencyEventFields). Without that field we cannot
        // safely surface the dependency delta — fall back.
        const dependencyId = fields.dependency_id;
        if (typeof dependencyId !== "string" || dependencyId.length === 0) {
          return null;
        }
        if (event.operation === "dependency.added") {
          dependencyIds.add(dependencyId);
        } else if (event.operation === "dependency.removed") {
          deletedDependencyIds.add(dependencyId);
        } else {
          return null;
        }
        includeDependencyEndpointParents(fields.source_id, fields.source_kind, fields.depends_on_id, fields.depends_on_kind);
        break;
      }
      default:
        return null;
    }
  }

  return {
    epicIds: [...epicIds],
    taskIds: [...taskIds],
    subtaskIds: [...subtaskIds],
    dependencyIds: [...dependencyIds],
    deletedEpicIds: [...deletedEpicIds],
    deletedTaskIds: [...deletedTaskIds],
    deletedSubtaskIds: [...deletedSubtaskIds],
    deletedDependencyIds: [...deletedDependencyIds],
  };
}

function tryEventCursorReconcile(
  db: Database,
  domain: TrackerDomain,
  cursor: EventCursor | null,
): EventCursorReconcileResult {
  if (cursor === null) {
    return { kind: "fallback", reason: "warm-up" };
  }

  if (isCursorStale(db, cursor)) {
    return { kind: "fallback", reason: "cursor-stale" };
  }

  const events = readEventsSinceCursor(db, cursor);
  if (events.length === 0) {
    return {
      kind: "ok",
      newCursor: cursor,
      delta: {
        epicIds: [],
        taskIds: [],
        subtaskIds: [],
        dependencyIds: [],
        deletedEpicIds: [],
        deletedTaskIds: [],
        deletedSubtaskIds: [],
        deletedDependencyIds: [],
      },
    };
  }

  const delta = eventsToCursorDelta(events, domain);
  if (delta === null) {
    return { kind: "fallback", reason: "event-parse-or-shape" };
  }

  const lastEvent = events[events.length - 1]!;
  return {
    kind: "ok",
    newCursor: { createdAt: lastEvent.created_at, id: lastEvent.id },
    delta,
  };
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
  /**
   * When `true`, the watcher always runs the legacy full-snapshot diff path
   * even when a usable event cursor is available. Used by tests that verify
   * the fallback contract is bit-identical to the optimized path.
   */
  readonly forceFullSnapshotReconcile?: boolean;
  /**
   * Optional reconcile observer for tests. Reports which path each tick used,
   * along with the reason for any fallback. Production code ignores this.
   */
  readonly onReconcile?: (info: {
    readonly path: "event-cursor" | "full-snapshot";
    readonly reason?: string;
  }) => void;
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
  let lastEventCursor: EventCursor | null = readLatestEventCursor(options.db);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let failures = 0;
  let lastSuppressedInProcessWriteAt = 0;
  let lastReconcileAt = 0;
  // The event-cursor hot path no longer rebuilds `lastSnapshot` on every
  // successful tick — that full board read was the dominant CPU cost on
  // large boards (see snapshot.ts buildBoardSnapshot — iterates every epic,
  // task, subtask, dependency). Setting this flag tells the fallback path
  // that the baseline may be older than what subscribers have already
  // received via cursor deltas. The fallback diff against a stale baseline
  // can over-publish, but the fallback path is itself a recovery operation
  // triggered only when the cursor path bails (warm-up, cursor pruned,
  // unknown event shape) — already a heavier path.
  let lastSnapshotStale = false;

  function runFullSnapshotReconcile(shouldSuppressInProcessTick: boolean, inProcessWriteAt: number): void {
    const fresh = buildSnapshot(domain);
    const epicsDiff = diffById(lastSnapshot.epics, fresh.epics, { isLeaf: false });
    const tasksDiff = diffById(lastSnapshot.tasks, fresh.tasks, { isLeaf: false });
    const subtasksDiff = diffById(lastSnapshot.subtasks, fresh.subtasks, { isLeaf: true });
    const dependenciesDiff = diffById(lastSnapshot.dependencies, fresh.dependencies, { isLeaf: true });

    const shouldSuppressDiff = shouldSuppressInProcessTick
      ? {
          epics: suppressAlreadyPublishedDiff(
            epicsDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "epics"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedEpicIds"),
            { isLeaf: false },
          ),
          tasks: suppressAlreadyPublishedDiff(
            tasksDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "tasks"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedTaskIds"),
            { isLeaf: false },
          ),
          subtasks: suppressAlreadyPublishedDiff(
            subtasksDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "subtasks"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedSubtaskIds"),
            { isLeaf: true },
          ),
          dependencies: suppressAlreadyPublishedDiff(
            dependenciesDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "dependencies"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedDependencyIds"),
            { isLeaf: true },
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
    // The fallback just rebuilt the snapshot from the live domain, so the
    // baseline is no longer stale. Future event-cursor ticks may set the
    // flag again as they advance without rebuilding lastSnapshot.
    lastSnapshotStale = false;
    // Reseat the cursor at the latest event so the next tick can attempt the
    // optimized path again. Without this, every subsequent tick would also
    // see "cursor stale" on a freshly-recovered watcher.
    lastEventCursor = readLatestEventCursor(options.db);

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
  }

  function runEventCursorReconcile(
    cursorResult: Extract<EventCursorReconcileResult, { kind: "ok" }>,
    shouldSuppressInProcessTick: boolean,
    inProcessWriteAt: number,
  ): void {
    const { newCursor, delta } = cursorResult;
    const noChanges =
      delta.epicIds.length === 0 &&
      delta.taskIds.length === 0 &&
      delta.subtaskIds.length === 0 &&
      delta.dependencyIds.length === 0 &&
      delta.deletedEpicIds.length === 0 &&
      delta.deletedTaskIds.length === 0 &&
      delta.deletedSubtaskIds.length === 0 &&
      delta.deletedDependencyIds.length === 0;

    // The event-cursor hot path no longer rebuilds `lastSnapshot` here. The
    // full board read was the dominant CPU cost on large boards; instead we
    // mark the baseline stale so the next fallback tick (cursor pruned /
    // parse failure / etc.) knows to rebuild before diffing.
    //
    // Both `lastEventCursor` and the staleness flag advance ONLY after the
    // publish call below returns successfully (or when there is nothing to
    // publish). If `publishSnapshotDelta` throws, leaving these at their
    // prior values ensures the next tick re-runs the same cursor delta —
    // subscribers never miss a row because of a transient listener error.

    if (noChanges) {
      // No events to process means the cursor itself did not move (see
      // tryEventCursorReconcile). Nothing to advance, nothing to mark stale.
      lastEventCursor = newCursor;
      if (shouldSuppressInProcessTick) {
        lastSuppressedInProcessWriteAt = inProcessWriteAt;
      }
      return;
    }

    const snapshotDelta = buildBoardSnapshotDelta(domain, {
      epicIds: delta.epicIds,
      taskIds: delta.taskIds,
      subtaskIds: delta.subtaskIds,
      dependencyIds: delta.dependencyIds,
      deletedEpicIds: delta.deletedEpicIds,
      deletedTaskIds: delta.deletedTaskIds,
      deletedSubtaskIds: delta.deletedSubtaskIds,
      deletedDependencyIds: delta.deletedDependencyIds,
    });

    // Pack the targeted-read result into the same CollectionDiff shape the
    // suppression helper expects, then run the standard in-process duplicate
    // filter against the route handler's last published delta.
    const epicsDiff: CollectionDiff = {
      upserted: Array.isArray(snapshotDelta.epics) ? (snapshotDelta.epics as unknown[]) : [],
      deletedIds: [...delta.deletedEpicIds],
    };
    const tasksDiff: CollectionDiff = {
      upserted: Array.isArray(snapshotDelta.tasks) ? (snapshotDelta.tasks as unknown[]) : [],
      deletedIds: [...delta.deletedTaskIds],
    };
    const subtasksDiff: CollectionDiff = {
      upserted: Array.isArray(snapshotDelta.subtasks) ? (snapshotDelta.subtasks as unknown[]) : [],
      deletedIds: [...delta.deletedSubtaskIds],
    };
    const dependenciesDiff: CollectionDiff = {
      upserted: Array.isArray(snapshotDelta.dependencies) ? (snapshotDelta.dependencies as unknown[]) : [],
      deletedIds: [...delta.deletedDependencyIds],
    };

    const suppressed = shouldSuppressInProcessTick
      ? {
          epics: suppressAlreadyPublishedDiff(
            epicsDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "epics"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedEpicIds"),
            { isLeaf: false },
          ),
          tasks: suppressAlreadyPublishedDiff(
            tasksDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "tasks"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedTaskIds"),
            { isLeaf: false },
          ),
          subtasks: suppressAlreadyPublishedDiff(
            subtasksDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "subtasks"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedSubtaskIds"),
            { isLeaf: true },
          ),
          dependencies: suppressAlreadyPublishedDiff(
            dependenciesDiff,
            recordsByIdFromDelta(options.eventBus.lastInProcessSnapshotDelta, "dependencies"),
            deletedIdsFromDelta(options.eventBus.lastInProcessSnapshotDelta, "deletedDependencyIds"),
            { isLeaf: true },
          ),
        }
      : null;

    const publishEpicsDiff = suppressed?.epics ?? epicsDiff;
    const publishTasksDiff = suppressed?.tasks ?? tasksDiff;
    const publishSubtasksDiff = suppressed?.subtasks ?? subtasksDiff;
    const publishDependenciesDiff = suppressed?.dependencies ?? dependenciesDiff;

    if (!hasDiffChanges(publishEpicsDiff, publishTasksDiff, publishSubtasksDiff, publishDependenciesDiff)) {
      // Nothing to publish (suppression filtered the in-process duplicate, or
      // the targeted snapshot read returned no rows for the touched IDs).
      // Advance cursor since the canonical events have been accounted for;
      // replaying them would not produce a different result. Mark the
      // baseline stale because the underlying domain has moved even though
      // no delta needed to ship.
      lastEventCursor = newCursor;
      lastSnapshotStale = true;
      if (shouldSuppressInProcessTick) {
        lastSuppressedInProcessWriteAt = inProcessWriteAt;
      }
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

    // Publish succeeded — only now is it safe to advance cursor and mark the
    // baseline stale. If the call above threw, the outer reconcile() catch
    // handles it and leaves these unchanged so the next tick replays the
    // same delta.
    lastEventCursor = newCursor;
    lastSnapshotStale = true;
    if (shouldSuppressInProcessTick) {
      lastSuppressedInProcessWriteAt = inProcessWriteAt;
    }
  }

  function reconcile(): void {
    if (closed) {
      return;
    }
    lastReconcileAt = Date.now();
    const inProcessWriteAt = options.eventBus.lastInProcessWriteAt;
    const shouldSuppressInProcessTick =
      inProcessWriteAt > lastSuppressedInProcessWriteAt &&
      Date.now() - inProcessWriteAt <= IN_PROCESS_WAL_SUPPRESS_MS;

    try {
      if (!options.forceFullSnapshotReconcile) {
        const cursorResult = tryEventCursorReconcile(options.db, domain, lastEventCursor);
        if (cursorResult.kind === "ok") {
          options.onReconcile?.({ path: "event-cursor" });
          runEventCursorReconcile(cursorResult, shouldSuppressInProcessTick, inProcessWriteAt);
          return;
        }
        options.onReconcile?.({ path: "full-snapshot", reason: cursorResult.reason });
      } else {
        options.onReconcile?.({ path: "full-snapshot", reason: "forced" });
      }
      runFullSnapshotReconcile(shouldSuppressInProcessTick, inProcessWriteAt);
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
    // Additionally, treat rapid sub-ms writes — where mtime is unchanged but
    // enough wall-clock time has elapsed since the last reconcile — as worth
    // reconciling. This prevents missed updates when two writes land in the
    // same filesystem mtime tick.
    const mtimeChanged = currentMtime !== lastWalMtime;
    const staleEnough = Date.now() - lastReconcileAt > debounceMs;
    if (mtimeChanged || staleEnough) {
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
