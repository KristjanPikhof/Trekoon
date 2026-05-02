import { randomUUID } from "node:crypto";

import { type Database } from "bun:sqlite";

import { ENTITY_OPERATIONS } from "../domain/mutation-operations";
import { openTrekoonDatabase, writeTransaction } from "../storage/database";
import { countBranchEventsSince, queryBranchEventsSinceBatch } from "./branch-db";
import { nextEventTimestamp } from "./event-writes";
import { persistGitContext, resolveGitContext } from "./git-context";
import { DomainError } from "../domain/types";
import {
  type PullSummary,
  type ResolveAllOptions,
  type ResolveAllFilters,
  type ResolveAllPreviewSummary,
  type ResolveAllSummary,
  type ResolvePreviewSummary,
  type ResolveSummary,
  type SyncConflictDetail,
  type SyncConflictListItem,
  type SyncConflictMode,
  type SyncResolution,
  type SyncStatusSummary,
} from "./types";

const SYNC_ALLOWED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  epics: ["title", "description", "status"],
  tasks: ["epic_id", "title", "description", "status", "owner"],
  subtasks: ["task_id", "title", "description", "status", "owner"],
  dependencies: ["source_id", "source_kind", "depends_on_id", "depends_on_kind"],
};

const SYNC_EVENT_METADATA_FIELDS = new Set(["dependency_id", "source_event_id"]);

function isSyncNullableStringField(tableName: string, fieldName: string): boolean {
  return (tableName === "tasks" || tableName === "subtasks") && fieldName === "owner";
}

function isSyncFieldValueSupported(tableName: string, fieldName: string, value: unknown): boolean {
  if (typeof value === "string") {
    return true;
  }

  return value === null && isSyncNullableStringField(tableName, fieldName);
}

export function isCursorStale(db: Database, cursorToken: string, sourceBranch: string): boolean {
  if (cursorToken === "0:") {
    return false;
  }

  const [createdAtRaw, idRaw] = cursorToken.split(":");
  const createdAt: number = Number.parseInt(createdAtRaw ?? "0", 10);
  const id: string = idRaw ?? "";

  if (!Number.isFinite(createdAt) || createdAt === 0) {
    return false;
  }

  // Check if the event referenced by the cursor still exists in the live
  // events table. If found, the cursor position is valid.
  if (id.length > 0) {
    const row = db
      .query("SELECT id FROM events WHERE id = ? LIMIT 1;")
      .get(id) as { id: string } | null;
    if (row) {
      return false;
    }
  }

  // Compute the earliest retained created_at on the cursor's source branch
  // across both the live events table and event_archive (pruned events). If
  // the cursor predates that minimum, history before the cursor on this
  // branch has been lost and re-bootstrap is required.
  //
  // Scoping by git_branch is essential: a global MIN would falsely report
  // staleness on branch B simply because branch A has older retained events
  // than the cursor on B.
  const minRow = db
    .query(
      `SELECT MIN(min_ts) AS min_ts FROM (
         SELECT MIN(created_at) AS min_ts FROM events WHERE git_branch = ?
         UNION ALL
         SELECT MIN(created_at) AS min_ts FROM event_archive WHERE git_branch = ?
       );`,
    )
    .get(sourceBranch, sourceBranch) as { min_ts: number | null } | null;

  const minTs: number | null = minRow?.min_ts ?? null;

  // If there are no events at all, the cursor may simply be ahead of an
  // empty log — not stale.
  if (minTs === null) {
    return false;
  }

  // Cursor predates the earliest retained event: the history window has
  // been pruned past the cursor's position.
  if (createdAt < minTs) {
    return true;
  }

  // The referenced event is gone but the cursor timestamp is within the
  // retained window. Check if there are any events on the source branch at
  // or after the cursor timestamp across both tables — if there are, events
  // between the cursor and the oldest remaining event were pruned.
  const newerRow = db
    .query(
      `SELECT id FROM (
         SELECT id, created_at FROM events
         WHERE git_branch = ? AND created_at >= ?
         UNION ALL
         SELECT id, created_at FROM event_archive
         WHERE git_branch = ? AND created_at >= ?
       )
       ORDER BY created_at ASC, id ASC
       LIMIT 1;`,
    )
    .get(sourceBranch, createdAt, sourceBranch, createdAt) as { id: string } | null;

  return newerRow !== null;
}

interface StoredEvent {
  readonly id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly operation: string;
  readonly payload: string;
  readonly git_branch: string | null;
  readonly git_head: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly version: number;
}

interface CursorRow {
  readonly owner_scope: string;
  readonly owner_worktree_path: string;
  readonly source_branch: string;
  readonly cursor_token: string;
  readonly last_event_at: number | null;
}

interface ConflictRow {
  readonly id: string;
  readonly event_id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly field_name: string;
  readonly ours_value: string | null;
  readonly theirs_value: string | null;
  readonly resolution: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly worktree_path: string;
  readonly current_branch: string;
}

/**
 * Worktree+branch scope under which a conflict is recorded. Required so that
 * cleanup, listing, and resolution paths can isolate conflicts that two
 * sibling worktrees independently observed on the same entity. Without this
 * scoping a `removeConflictsForEntityIds` from worktree A's pull would erase
 * worktree B's pending conflicts on the same entity.
 */
interface ConflictScope {
  readonly worktreePath: string;
  readonly currentBranch: string;
}

function scopeFromGitContext(git: { worktreePath: string; branchName: string | null }): ConflictScope {
  return { worktreePath: git.worktreePath, currentBranch: git.branchName ?? "" };
}

interface ResolutionEventPayload {
  readonly conflict_id?: string;
  readonly source_event_id?: string;
  readonly field: string;
  readonly resolution: string;
  readonly value?: string | null;
}

interface ResolutionWriteContext {
  readonly branchName: string | null;
  readonly headSha: string | null;
}

interface ResolveAllQueryFilters {
  readonly entityId?: string;
  readonly fieldName?: string;
}

interface EventPayload {
  readonly fields: Record<string, unknown>;
}

interface DeleteCascadeResolutionRow {
  readonly id: string;
  readonly source_id: string;
  readonly depends_on_id: string;
}

interface ConflictOrderRow {
  readonly id: string;
}

interface LocalEntityEventRow {
  readonly payload: string;
  readonly created_at: number;
  readonly id: string;
}

interface DependencyEventIdentity {
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly dependsOnId: string;
  readonly dependsOnKind: string;
}

const SYNC_PULL_BATCH_SIZE = 250;
const CONFLICT_HISTORY_SCAN_BATCH_SIZE = 250;
const RESOLVE_ALL_CHUNK_SIZE = 200;
const DELETE_CONFLICT_DEPENDENCY_SCAN_CHUNK_SIZE = 400;

interface PayloadValidation {
  readonly ok: boolean;
  readonly fields: Record<string, unknown>;
  readonly reason?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(rawPayload: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawPayload);
    return isObjectRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePayload(rawPayload: string): PayloadValidation {
  try {
    const parsed: unknown = JSON.parse(rawPayload);

    if (!isObjectRecord(parsed)) {
      return {
        ok: false,
        fields: {},
        reason: "payload must be a JSON object",
      };
    }

    if (!("fields" in parsed)) {
      return {
        ok: true,
        fields: {},
      };
    }

    if (!isObjectRecord(parsed.fields)) {
      return {
        ok: false,
        fields: {},
        reason: "payload.fields must be an object",
      };
    }

    return {
      ok: true,
      fields: parsed.fields,
    };
  } catch {
    return {
      ok: false,
      fields: {},
      reason: "payload is not valid JSON",
    };
  }
}

function tableForEntityKind(entityKind: string): "epics" | "tasks" | "subtasks" | "dependencies" | null {
  switch (entityKind) {
    case "epic":
      return "epics";
    case "task":
      return "tasks";
    case "subtask":
      return "subtasks";
    case "dependency":
      return "dependencies";
    default:
      return null;
  }
}

function cursorTokenFromEvent(event: StoredEvent): string {
  return `${event.created_at}:${event.id}`;
}

function cursorIdForWorktree(worktreePath: string, sourceBranch: string): string {
  return `${worktreePath}::${sourceBranch}`;
}

function loadCursor(db: Database, worktreePath: string, sourceBranch: string): CursorRow | null {
  return db
    .query(
      `
      SELECT owner_scope, owner_worktree_path, source_branch, cursor_token, last_event_at
      FROM sync_cursors
      WHERE owner_scope = 'worktree'
        AND owner_worktree_path = ?
        AND source_branch = ?
      LIMIT 1;
      `,
    )
    .get(worktreePath, sourceBranch) as CursorRow | null;
}

function saveCursor(
  db: Database,
  worktreePath: string,
  sourceBranch: string,
  cursorToken: string,
  lastEventAt: number | null,
): void {
  const now: number = Date.now();
  const cursorId = cursorIdForWorktree(worktreePath, sourceBranch);

  db.query(
    `
    INSERT INTO sync_cursors (
      id,
      owner_scope,
      owner_worktree_path,
      source_branch,
      cursor_token,
      last_event_at,
      created_at,
      updated_at,
      version
    ) VALUES (
      @cursorId,
      'worktree',
      @worktreePath,
      @sourceBranch,
      @cursorToken,
      @lastEventAt,
      @now,
      @now,
      1
    )
    ON CONFLICT(id) DO UPDATE SET
      owner_scope = excluded.owner_scope,
      owner_worktree_path = excluded.owner_worktree_path,
      cursor_token = excluded.cursor_token,
      last_event_at = excluded.last_event_at,
      updated_at = excluded.updated_at,
      version = sync_cursors.version + 1;
    `,
  ).run({
    "@cursorId": cursorId,
    "@worktreePath": worktreePath,
    "@sourceBranch": sourceBranch,
    "@cursorToken": cursorToken,
    "@lastEventAt": lastEventAt,
    "@now": now,
  });
}

function countPendingConflicts(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
    .get() as { count: number } | null;

  return row?.count ?? 0;
}

function countAhead(localDb: Database, currentBranch: string | null, sourceBranch: string): number {
  if (!currentBranch || currentBranch === sourceBranch) {
    return 0;
  }

  const row = localDb
    .query(
      `
      SELECT COUNT(*) AS count
      FROM events
      WHERE git_branch = @branch;
      `,
    )
    .get({ "@branch": currentBranch }) as { count: number } | null;

  return row?.count ?? 0;
}

function buildSyncErrorHints(diagnostics: {
  malformedPayloadEvents: number;
  applyRejectedEvents: number;
  conflictEvents: number;
}): string[] {
  const hints: string[] = [];

  if (diagnostics.malformedPayloadEvents > 0) {
    hints.push("Malformed event payloads were quarantined; inspect sync conflicts with field '__payload__'.");
  }

  if (diagnostics.applyRejectedEvents > 0) {
    hints.push("Some events were quarantined as invalid; inspect sync conflicts with field '__apply__'.");
  }

  if (diagnostics.conflictEvents > 0) {
    hints.push("Field-level conflicts detected; run 'trekoon sync conflicts list' and resolve pending entries.");
  }

  return hints;
}

function readFieldValue(payload: EventPayload, field: string): unknown {
  return payload.fields[field];
}

function serializeValue(value: unknown): string | null {
  if (typeof value === "undefined") {
    return null;
  }

  return JSON.stringify(value);
}

function currentEntityFieldValue(db: Database, entityKind: string, entityId: string, fieldName: string): unknown {
  const tableName = tableForEntityKind(entityKind);
  if (!tableName) {
    return undefined;
  }

  const validFields = SYNC_ALLOWED_FIELDS[tableName] ?? [];
  if (!validFields.includes(fieldName)) {
    return undefined;
  }

  const row = db.query(`SELECT ${fieldName} AS value FROM ${tableName} WHERE id = ? LIMIT 1;`).get(entityId) as
    | { value: string | null }
    | null;

  return row?.value;
}

function dependencyEventIdentityFromFields(fields: Record<string, unknown>): DependencyEventIdentity | null {
  const sourceId = validateRequiredStringField(fields, "source_id");
  const sourceKind = validateRequiredStringField(fields, "source_kind");
  const dependsOnId = validateRequiredStringField(fields, "depends_on_id");
  const dependsOnKind = validateRequiredStringField(fields, "depends_on_kind");

  if (!sourceId || !sourceKind || !dependsOnId || !dependsOnKind) {
    return null;
  }

  return {
    sourceId,
    sourceKind,
    dependsOnId,
    dependsOnKind,
  };
}

function dependencyEventIdentity(event: StoredEvent): DependencyEventIdentity | null {
  if (event.entity_kind !== "dependency") {
    return null;
  }

  const payloadValidation = parsePayload(event.payload);
  if (!payloadValidation.ok) {
    return null;
  }

  return dependencyEventIdentityFromFields(payloadValidation.fields);
}

/**
 * Memoized lookup table for "ours" field values keyed by
 * `${entity_kind}|${entity_id}|${field_name}` on the current branch.
 *
 * Entries:
 *   - undefined: not yet probed
 *   - {found:false}: probed, no event on currentBranch touches this field
 *   - {found:true,value}: probed, most recent serialized local value found
 */
type OursLookupResult =
  | { readonly found: false }
  | { readonly found: true; readonly value: string | null };

type OursValueCache = Map<string, OursLookupResult>;

function createOursValueCache(): OursValueCache {
  return new Map<string, OursLookupResult>();
}

function oursCacheKey(entityKind: string, entityId: string, fieldName: string): string {
  return `${entityKind}|${entityId}|${fieldName}`;
}

// Safe field-name guard for use in JSON1 path strings. We only inline
// fieldName into a `$.fields.<name>` path; any non-identifier character
// would either break the path syntax or invite injection-like surprises.
const SAFE_FIELD_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isSafeJsonPathField(fieldName: string): boolean {
  return SAFE_FIELD_NAME_PATTERN.test(fieldName);
}

/**
 * Fast O(1)-per-call probe (after first lookup is memoized) for the most
 * recent local-branch event that touched a given (entity, field).
 *
 * Uses the `idx_events_entity_branch_cursor` index plus SQLite JSON1
 * (`json_type`) to find the newest event whose payload has the field key,
 * with a single LIMIT 1 query — replacing the previous unbounded batched
 * history walk.
 *
 * Returns undefined when no event on `currentBranch` for `(entityKind,
 * entityId)` has the field in its payload; otherwise the serialized
 * local value (matching `serializeValue(payload.fields[field])`).
 */
function lookupOursFieldValue(
  localDb: Database,
  cache: OursValueCache,
  currentBranch: string,
  entityKind: string,
  entityId: string,
  fieldName: string,
): string | null | undefined {
  const key = oursCacheKey(entityKind, entityId, fieldName);
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached.found ? cached.value : undefined;
  }

  // json_type returns SQL NULL only when the JSON path does not exist.
  // It returns the string 'null' when the field is explicitly null —
  // we treat that as a real value (matching the legacy walk's behavior
  // where only `typeof undefined` skipped a key).
  const path = `$.fields.${fieldName}`;
  const row = localDb
    .query(
      `
      SELECT json_extract(payload, ?) AS value, json_type(payload, ?) AS jt
      FROM events
      WHERE entity_kind = ?
        AND entity_id = ?
        AND git_branch = ?
        AND json_type(payload, ?) IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
      `,
    )
    .get(path, path, entityKind, entityId, currentBranch, path) as
    | { value: unknown; jt: string | null }
    | null;

  if (row === null || row.jt === null) {
    cache.set(key, { found: false });
    return undefined;
  }

  // Reconstruct serialized local value matching
  // `serializeValue(JSON.parse(payload).fields[field])`.
  // For JSON nulls, json_extract returns SQL NULL; we represent ours as "null".
  // For other types we re-serialize using JSON.stringify on the JSON-extracted value.
  const ours: string | null = row.jt === "null" ? "null" : JSON.stringify(row.value);

  cache.set(key, { found: true, value: ours });
  return ours;
}

function entityFieldConflict(
  localDb: Database,
  currentBranch: string | null,
  sourceBranch: string,
  event: StoredEvent,
  fieldName: string,
  incomingValue: unknown,
  oursCache: OursValueCache,
): { oursValue: string | null; theirsValue: string | null } | null {
  // Detached HEAD has no named branch — no local-branch events can conflict.
  if (currentBranch === null) {
    return null;
  }

  // Current-row short-circuit: live entity already matches the incoming
  // value, so applying the incoming event is a no-op — no conflict possible.
  //
  // Only valid when the local row exists. If the row was deleted locally
  // currentEntityFieldValue returns `undefined`, which serializeValue maps
  // to `null` — that would falsely match an incoming `null` field and mask
  // a real conflict (delete vs. concurrent update). When the row is gone
  // we must fall through to the history walk so the local delete event is
  // discovered and reported as a conflict against the incoming non-delete.
  const currentValue = currentEntityFieldValue(localDb, event.entity_kind, event.entity_id, fieldName);
  const theirsValue = serializeValue(incomingValue);
  if (typeof currentValue !== "undefined" && serializeValue(currentValue) === theirsValue) {
    return null;
  }

  // Dependency events use identity-tuple matching (entity_id can be reused
  // across distinct dependencies). Fall back to the legacy filtered scan;
  // dependency events are bounded by per-entity history depth and not the
  // hot path that the optimization targets. Same fallback applies for
  // payload field names that can't safely be inlined into a JSON1 path
  // (defense in depth — the canonical SYNC_ALLOWED_FIELDS are all simple
  // identifiers, but incoming payloads are not strictly schema-checked).
  const incomingDependencyIdentity = dependencyEventIdentity(event);
  if (incomingDependencyIdentity !== null || !isSafeJsonPathField(fieldName)) {
    return entityFieldConflictHistoryWalk(
      localDb,
      currentBranch,
      event,
      fieldName,
      theirsValue,
      incomingDependencyIdentity,
    );
  }

  // Fast path: indexed + memoized probe for "most recent local event
  // touching this field on this entity".
  const oursValue = lookupOursFieldValue(
    localDb,
    oursCache,
    currentBranch,
    event.entity_kind,
    event.entity_id,
    fieldName,
  );

  if (oursValue === undefined) {
    return null;
  }

  if (oursValue === theirsValue) {
    return null;
  }

  return { oursValue, theirsValue };
}

/**
 * Slow-path conflict detection. Preserves the legacy batched history walk
 * for two cases:
 *   1. Dependency events — identity (source/depends_on tuple) must match
 *      the incoming event because distinct dependencies can share an
 *      entity_id. A static-field probe is not sufficient.
 *   2. Field names that cannot safely be inlined into a JSON1 path — falls
 *      back to JS-side payload parsing instead of a json_type SQL probe.
 */
function entityFieldConflictHistoryWalk(
  localDb: Database,
  currentBranch: string,
  event: StoredEvent,
  fieldName: string,
  theirsValue: string | null,
  incomingDependencyIdentity: DependencyEventIdentity | null,
): { oursValue: string | null; theirsValue: string | null } | null {
  let beforeCreatedAt = Number.MAX_SAFE_INTEGER;
  let beforeId = "\uffff";

  while (true) {
    const rows = localDb
    .query(
      `
      SELECT payload, created_at, id
      FROM events
      WHERE entity_kind = ?
        AND entity_id = ?
        AND git_branch = ?
        AND (
          created_at < ?
          OR (created_at = ? AND id < ?)
        )
      ORDER BY created_at DESC, id DESC
      LIMIT ?;
`,
    )
      .all(
        event.entity_kind,
        event.entity_id,
        currentBranch,
        beforeCreatedAt,
        beforeCreatedAt,
        beforeId,
        CONFLICT_HISTORY_SCAN_BATCH_SIZE,
      ) as LocalEntityEventRow[];

    if (rows.length === 0) {
      return null;
    }

    for (const row of rows) {
      const payloadValidation = parsePayload(row.payload);
      if (!payloadValidation.ok) {
        continue;
      }

      if (incomingDependencyIdentity !== null) {
        const localDependencyIdentity = dependencyEventIdentityFromFields(payloadValidation.fields);
        if (
          localDependencyIdentity === null ||
          localDependencyIdentity.sourceId !== incomingDependencyIdentity.sourceId ||
          localDependencyIdentity.sourceKind !== incomingDependencyIdentity.sourceKind ||
          localDependencyIdentity.dependsOnId !== incomingDependencyIdentity.dependsOnId ||
          localDependencyIdentity.dependsOnKind !== incomingDependencyIdentity.dependsOnKind
        ) {
          continue;
        }
      }

      const payload: EventPayload = { fields: payloadValidation.fields };
      const localValue: unknown = readFieldValue(payload, fieldName);

      if (typeof localValue === "undefined") {
        continue;
      }

      const oursValue = serializeValue(localValue);

      if (oursValue !== theirsValue) {
        return {
          oursValue,
          theirsValue,
        };
      }
    }

    const lastRow = rows.at(-1)!;
    beforeCreatedAt = lastRow.created_at;
    beforeId = lastRow.id;
  }
}

function createConflict(
  db: Database,
  event: StoredEvent,
  fieldName: string,
  oursValue: string | null,
  theirsValue: string | null,
  scope: ConflictScope,
  resolution: string = "pending",
): void {
  const now: number = Date.now();
  const existing = db
    .query(
      `
      SELECT id, resolution, ours_value, theirs_value
      FROM sync_conflicts
      WHERE event_id = ? AND entity_kind = ? AND entity_id = ? AND field_name = ?
        AND worktree_path = ? AND current_branch = ?
      ORDER BY CASE WHEN resolution = 'pending' THEN 0 ELSE 1 END, created_at ASC, id ASC
      LIMIT 1;
      `,
    )
    .get(
      event.id,
      event.entity_kind,
      event.entity_id,
      fieldName,
      scope.worktreePath,
      scope.currentBranch,
    ) as
    | { id: string; resolution: string; ours_value: string | null; theirs_value: string | null }
    | null;

  if (existing) {
    const nextResolution = existing.resolution === "pending" ? resolution : existing.resolution;
    const unchanged =
      existing.ours_value === oursValue &&
      existing.theirs_value === theirsValue &&
      existing.resolution === nextResolution;

    if (unchanged) {
      return;
    }

    db.query(
      `
      UPDATE sync_conflicts
      SET ours_value = ?,
          theirs_value = ?,
          resolution = ?,
          updated_at = ?,
          version = version + 1
      WHERE id = ?;
      `,
    ).run(oursValue, theirsValue, nextResolution, now, existing.id);
    return;
  }

  db.query(
    `
    INSERT INTO sync_conflicts (
      id,
      event_id,
      entity_kind,
      entity_id,
      field_name,
      ours_value,
      theirs_value,
      resolution,
      created_at,
      updated_at,
      version,
      worktree_path,
      current_branch
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?);
    `,
  ).run(
    randomUUID(),
    event.id,
    event.entity_kind,
    event.entity_id,
    fieldName,
    oursValue,
    theirsValue,
    resolution,
    now,
    now,
    scope.worktreePath,
    scope.currentBranch,
  );
}

function findConflictForResolutionEvent(
  db: Database,
  event: StoredEvent,
  payload: ResolutionEventPayload,
): ConflictRow | null {
  if (typeof payload.source_event_id === "string" && payload.source_event_id.length > 0) {
    const bySourceEvent = db
      .query(
        `
        SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at
        FROM sync_conflicts
        WHERE event_id = ?
          AND entity_kind = ?
          AND entity_id = ?
          AND field_name = ?
        ORDER BY CASE WHEN resolution = 'pending' THEN 0 ELSE 1 END, created_at ASC, id ASC
        LIMIT 1;
        `,
      )
      .get(payload.source_event_id, event.entity_kind, event.entity_id, payload.field) as ConflictRow | null;

    if (bySourceEvent) {
      return bySourceEvent;
    }
  }

  if (typeof payload.conflict_id !== "string" || payload.conflict_id.length === 0) {
    return null;
  }

  return db
    .query(
      `
      SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at
      FROM sync_conflicts
      WHERE id = ?
        AND entity_kind = ?
        AND entity_id = ?
        AND field_name = ?
      LIMIT 1;
      `,
    )
    .get(payload.conflict_id, event.entity_kind, event.entity_id, payload.field) as ConflictRow | null;
}

function removeDependenciesTouchingNode(db: Database, nodeId: string): void {
  db.query("DELETE FROM dependencies WHERE source_id = ? OR depends_on_id = ?;").run(nodeId, nodeId);
}

function removeConflictsForEntityIds(
  db: Database,
  entityKind: string,
  entityIds: readonly string[],
  scope: ConflictScope,
  excludeConflictId?: string,
): void {
  if (entityIds.length === 0) {
    return;
  }
  const placeholders = entityIds.map(() => "?").join(", ");
  if (excludeConflictId !== undefined) {
    db.query(
      `DELETE FROM sync_conflicts
       WHERE entity_kind = ?
         AND entity_id IN (${placeholders})
         AND worktree_path = ?
         AND current_branch = ?
         AND id != ?;`,
    ).run(entityKind, ...entityIds, scope.worktreePath, scope.currentBranch, excludeConflictId);
  } else {
    db.query(
      `DELETE FROM sync_conflicts
       WHERE entity_kind = ?
         AND entity_id IN (${placeholders})
         AND worktree_path = ?
         AND current_branch = ?;`,
    ).run(entityKind, ...entityIds, scope.worktreePath, scope.currentBranch);
  }
}

function removeTaskSubtree(db: Database, taskId: string): Array<{ id: string }> {
  const subtasks = db
    .query("SELECT id FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC;")
    .all(taskId) as Array<{ id: string }>;

  for (const subtask of subtasks) {
    removeDependenciesTouchingNode(db, subtask.id);
  }

  db.query("DELETE FROM subtasks WHERE task_id = ?;").run(taskId);
  removeDependenciesTouchingNode(db, taskId);
  return subtasks;
}

function applyPendingDeleteCascadeResolution(db: Database, conflict: ConflictRow): void {
  const rows = db
    .query(
      `
      SELECT e.id, json_extract(e.payload, '$.fields.source_id') AS source_id, json_extract(e.payload, '$.fields.depends_on_id') AS depends_on_id
      FROM events e
      WHERE e.operation = 'dependency.removed'
        AND json_extract(e.payload, '$.fields.source_event_id') = ?
      ORDER BY e.created_at ASC, e.id ASC;
      `,
    )
    .all(conflict.event_id) as DeleteCascadeResolutionRow[];

  for (const row of rows) {
    if (typeof row.source_id !== "string" || typeof row.depends_on_id !== "string") {
      continue;
    }

    db.query("DELETE FROM dependencies WHERE source_id = ? AND depends_on_id = ?;").run(row.source_id, row.depends_on_id);
  }
}

function scopeFromConflictRow(conflict: ConflictRow): ConflictScope {
  return { worktreePath: conflict.worktree_path, currentBranch: conflict.current_branch };
}

function applyConflictTheirsResolution(db: Database, conflict: ConflictRow): void {
  // Cleanup is scoped to the conflict's own worktree+branch so resolving a
  // conflict in this worktree does not erase peer worktrees' pending
  // conflicts on the same entity.
  const scope: ConflictScope = scopeFromConflictRow(conflict);

  if (conflict.field_name === "__delete__") {
    if (conflict.entity_kind === "task") {
      const subtasks = removeTaskSubtree(db, conflict.entity_id);
      const subtaskIds = subtasks.map((s) => s.id);
      removeConflictsForEntityIds(db, "subtask", subtaskIds, scope, conflict.id);
      removeConflictsForEntityIds(db, "task", [conflict.entity_id], scope, conflict.id);
    } else if (conflict.entity_kind === "subtask") {
      removeDependenciesTouchingNode(db, conflict.entity_id);
      removeConflictsForEntityIds(db, "subtask", [conflict.entity_id], scope, conflict.id);
    }
    applyPendingDeleteCascadeResolution(db, conflict);
    deleteSingleEntity(db, conflict.entity_kind, conflict.entity_id, { allowMissing: true });
    return;
  }

  updateSingleField(db, conflict.entity_kind, conflict.entity_id, conflict.field_name, parseConflictValue(conflict.theirs_value), {
    allowMissing: true,
  });
}

function applyIncomingResolutionEvent(db: Database, event: StoredEvent): boolean {
  const parsed = parseJsonObject(event.payload);
  if (!parsed) {
    return false;
  }

  const resolutionPayload = parsed as unknown as ResolutionEventPayload;
  const fieldName = resolutionPayload.field;
  const resolution = resolutionPayload.resolution;

  if (
    typeof fieldName !== "string" ||
    (resolution !== "ours" && resolution !== "theirs")
  ) {
    return false;
  }

  const conflict = findConflictForResolutionEvent(db, event, resolutionPayload);
  if (!conflict) {
    return false;
  }

  if (conflict.resolution === "pending" && resolution === "theirs") {
    applyConflictTheirsResolution(db, conflict);
  }

  const now = nextEventTimestamp(db);
  const updated = db
    .query(
      `
      UPDATE sync_conflicts
      SET resolution = CASE WHEN resolution = 'pending' THEN @resolution ELSE resolution END,
          updated_at = CASE WHEN resolution = 'pending' THEN @now ELSE updated_at END,
          version = CASE WHEN resolution = 'pending' THEN version + 1 ELSE version END
      WHERE id = @conflictId
        AND entity_kind = @entityKind
        AND entity_id = @entityId
        AND field_name = @fieldName;
      `,
    )
      .run({
        "@resolution": resolution,
        "@now": now,
        "@conflictId": conflict.id,
        "@entityKind": event.entity_kind,
        "@entityId": event.entity_id,
        "@fieldName": fieldName,
    });

  return updated.changes > 0;
}

function hasLocalEntityEdits(db: Database, entityKind: string, entityId: string, currentBranch: string): boolean {
  const row = db
    .query(
      `SELECT 1 FROM events WHERE entity_kind = ? AND entity_id = ? AND git_branch = ? LIMIT 1;`,
    )
    .get(entityKind, entityId, currentBranch);
  return row !== null;
}

function hasLocalDependencyEditsTouchingNodes(db: Database, nodeIds: readonly string[], currentBranch: string): boolean {
  if (nodeIds.length === 0) {
    return false;
  }

  for (let offset = 0; offset < nodeIds.length; offset += DELETE_CONFLICT_DEPENDENCY_SCAN_CHUNK_SIZE) {
    const chunk = nodeIds.slice(offset, offset + DELETE_CONFLICT_DEPENDENCY_SCAN_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const row = db
      .query(
        `
        SELECT 1
        FROM events
        WHERE entity_kind = 'dependency'
          AND git_branch = ?
          AND (
            json_extract(payload, '$.fields.source_id') IN (${placeholders})
            OR json_extract(payload, '$.fields.depends_on_id') IN (${placeholders})
          )
        LIMIT 1;
        `,
      )
      .get(currentBranch, ...chunk, ...chunk);

    if (row !== null) {
      return true;
    }
  }

  return false;
}

function hasLocalDependencyEditsForIdentity(
  db: Database,
  currentBranch: string,
  identity: DependencyEventIdentity,
): boolean {
  const row = db
    .query(
      `
      SELECT 1
      FROM events
      WHERE entity_kind = 'dependency'
        AND git_branch = ?
        AND json_extract(payload, '$.fields.source_id') = ?
        AND json_extract(payload, '$.fields.source_kind') = ?
        AND json_extract(payload, '$.fields.depends_on_id') = ?
        AND json_extract(payload, '$.fields.depends_on_kind') = ?
      LIMIT 1;
      `,
    )
    .get(currentBranch, identity.sourceId, identity.sourceKind, identity.dependsOnId, identity.dependsOnKind);

  return row !== null;
}

function dependencyRowExistsForIdentity(db: Database, identity: DependencyEventIdentity): boolean {
  const row = db
    .query(
      `
      SELECT 1
      FROM dependencies
      WHERE source_id = ?
        AND source_kind = ?
        AND depends_on_id = ?
        AND depends_on_kind = ?
      LIMIT 1;
      `,
    )
    .get(identity.sourceId, identity.sourceKind, identity.dependsOnId, identity.dependsOnKind);

  return row !== null;
}

function latestLocalDependencyOperationForIdentity(
  db: Database,
  currentBranch: string,
  identity: DependencyEventIdentity,
): string | null {
  const row = db
    .query(
      `
      SELECT operation
      FROM events
      WHERE entity_kind = 'dependency'
        AND git_branch = ?
        AND json_extract(payload, '$.fields.source_id') = ?
        AND json_extract(payload, '$.fields.source_kind') = ?
        AND json_extract(payload, '$.fields.depends_on_id') = ?
        AND json_extract(payload, '$.fields.depends_on_kind') = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
      `,
    )
    .get(currentBranch, identity.sourceId, identity.sourceKind, identity.dependsOnId, identity.dependsOnKind) as
    | { operation: string }
    | null;

  return row?.operation ?? null;
}

function hasLocalDependencyRemovalForIdentity(
  db: Database,
  currentBranch: string,
  identity: DependencyEventIdentity,
): boolean {
  const row = db
    .query(
      `
      SELECT 1
      FROM events
      WHERE entity_kind = 'dependency'
        AND operation = 'dependency.removed'
        AND git_branch = ?
        AND json_extract(payload, '$.fields.source_id') = ?
        AND json_extract(payload, '$.fields.depends_on_id') = ?
        AND (
          json_extract(payload, '$.fields.source_kind') IS NULL
          OR json_extract(payload, '$.fields.source_kind') = ?
        )
        AND (
          json_extract(payload, '$.fields.depends_on_kind') IS NULL
          OR json_extract(payload, '$.fields.depends_on_kind') = ?
        )
      LIMIT 1;
      `,
    )
    .get(currentBranch, identity.sourceId, identity.dependsOnId, identity.sourceKind, identity.dependsOnKind);

  return row !== null;
}

function hasLocalDependencyDeleteConflict(db: Database, event: StoredEvent, currentBranch: string | null): boolean {
  // Detached HEAD has no named branch — no local-branch events can conflict.
  if (currentBranch === null) {
    return false;
  }

  const identity = dependencyEventIdentity(event);
  if (identity === null) {
    return false;
  }

  if (!dependencyRowExistsForIdentity(db, identity)) {
    return false;
  }

  const latestOperation = latestLocalDependencyOperationForIdentity(db, currentBranch, identity);
  if (latestOperation === ENTITY_OPERATIONS.dependency.removed) {
    return false;
  }

  return hasLocalDependencyEditsForIdentity(db, currentBranch, identity);
}

function hasLocalDeleteCascadeEdits(db: Database, event: StoredEvent, currentBranch: string | null): boolean {
  // Detached HEAD has no named branch — no local-branch events can conflict.
  if (currentBranch === null) {
    return false;
  }

  if (hasLocalEntityEdits(db, event.entity_kind, event.entity_id, currentBranch)) {
    return true;
  }

  if (event.entity_kind === "subtask") {
    return hasLocalDependencyEditsTouchingNodes(db, [event.entity_id], currentBranch);
  }

  if (event.entity_kind !== "task") {
    return false;
  }

  const subtaskRows = db
    .query("SELECT id FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC;")
    .all(event.entity_id) as Array<{ id: string }>;
  const subtaskIds = subtaskRows.map((row) => row.id);

  for (const subtaskId of subtaskIds) {
    if (hasLocalEntityEdits(db, "subtask", subtaskId, currentBranch)) {
      return true;
    }
  }

  return hasLocalDependencyEditsTouchingNodes(db, [event.entity_id, ...subtaskIds], currentBranch);
}

function rowExists(db: Database, tableName: string, id: string): boolean {
  const row = db.query(`SELECT id FROM ${tableName} WHERE id = ? LIMIT 1;`).get(id) as { id: string } | null;
  return row !== null;
}

function dependencyNodeExists(db: Database, nodeKind: string, nodeId: string): boolean {
  if (nodeKind === "task") {
    return rowExists(db, "tasks", nodeId);
  }

  if (nodeKind === "subtask") {
    return rowExists(db, "subtasks", nodeId);
  }

  return false;
}

function validateRequiredStringField(fields: Record<string, unknown>, fieldName: string): string | null {
  const value: unknown = fields[fieldName];
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return value;
}

function applyCreate(db: Database, event: StoredEvent, fields: Record<string, unknown>): boolean {
  const tableName = tableForEntityKind(event.entity_kind);
  if (!tableName) {
    return false;
  }

  const now: number = Date.now();

  if (tableName === "epics") {
    const title = validateRequiredStringField(fields, "title");
    const status = validateRequiredStringField(fields, "status");
    if (!title || !status) {
      return false;
    }

    const description = typeof fields.description === "string" ? fields.description : "";
    db.query(
      `
      INSERT INTO epics (id, title, description, status, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        updated_at = excluded.updated_at,
        version = epics.version + 1;
      `,
    ).run(event.entity_id, title, description, status, now, now);

    return true;
  }

  if (tableName === "tasks") {
    const epicId = validateRequiredStringField(fields, "epic_id");
    const title = validateRequiredStringField(fields, "title");
    const status = validateRequiredStringField(fields, "status");
    if (!epicId || !title || !status || !rowExists(db, "epics", epicId)) {
      return false;
    }

    const description = typeof fields.description === "string" ? fields.description : "";
    const owner = isSyncFieldValueSupported(tableName, "owner", fields.owner) ? (fields.owner as string | null) : null;
    db.query(
      `
      INSERT INTO tasks (id, epic_id, title, description, status, owner, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        epic_id = excluded.epic_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        owner = excluded.owner,
        updated_at = excluded.updated_at,
        version = tasks.version + 1;
      `,
    ).run(event.entity_id, epicId, title, description, status, owner, now, now);

    return true;
  }

  if (tableName === "subtasks") {
    const taskId = validateRequiredStringField(fields, "task_id");
    const title = validateRequiredStringField(fields, "title");
    const status = validateRequiredStringField(fields, "status");
    if (!taskId || !title || !status || !rowExists(db, "tasks", taskId)) {
      return false;
    }

    const description = typeof fields.description === "string" ? fields.description : "";
    const owner = isSyncFieldValueSupported(tableName, "owner", fields.owner) ? (fields.owner as string | null) : null;
    db.query(
      `
      INSERT INTO subtasks (id, task_id, title, description, status, owner, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        owner = excluded.owner,
        updated_at = excluded.updated_at,
        version = subtasks.version + 1;
      `,
    ).run(event.entity_id, taskId, title, description, status, owner, now, now);

    return true;
  }

  const sourceId = validateRequiredStringField(fields, "source_id");
  const sourceKind = validateRequiredStringField(fields, "source_kind");
  const dependsOnId = validateRequiredStringField(fields, "depends_on_id");
  const dependsOnKind = validateRequiredStringField(fields, "depends_on_kind");
  const dependencyId = validateRequiredStringField(fields, "dependency_id") ?? event.entity_id;

  if (!sourceId || !sourceKind || !dependsOnId || !dependsOnKind) {
    return false;
  }

  if (!dependencyNodeExists(db, sourceKind, sourceId) || !dependencyNodeExists(db, dependsOnKind, dependsOnId)) {
    return false;
  }

  db.query(
    `
    INSERT INTO dependencies (
      id,
      source_id,
      source_kind,
      depends_on_id,
      depends_on_kind,
      created_at,
      updated_at,
      version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(source_id, depends_on_id) DO UPDATE SET
      source_kind = excluded.source_kind,
      depends_on_kind = excluded.depends_on_kind,
      updated_at = excluded.updated_at,
      version = dependencies.version + 1;
    `,
  ).run(dependencyId, sourceId, sourceKind, dependsOnId, dependsOnKind, now, now);

  return true;
}

function applyUpdatePatch(db: Database, event: StoredEvent, fields: Record<string, unknown>): boolean {
  const tableName = tableForEntityKind(event.entity_kind);
  if (!tableName) {
    return false;
  }

  if (!rowExists(db, tableName, event.entity_id)) {
    return false;
  }

  const allowed = new Set(SYNC_ALLOWED_FIELDS[tableName] ?? []);
  const entries = Object.entries(fields).filter(([fieldName, value]) =>
    allowed.has(fieldName) && isSyncFieldValueSupported(tableName, fieldName, value)
  );

  if (entries.length === 0) {
    return false;
  }

  if (tableName === "tasks") {
    const epicIdEntry = entries.find(([field]) => field === "epic_id");
    if (epicIdEntry && !rowExists(db, "epics", epicIdEntry[1] as string)) {
      return false;
    }
  }

  if (tableName === "subtasks") {
    const taskIdEntry = entries.find(([field]) => field === "task_id");
    if (taskIdEntry && !rowExists(db, "tasks", taskIdEntry[1] as string)) {
      return false;
    }
  }

  const now = Date.now();
  const setClause = entries.map(([field]) => `${field} = ?`).join(", ");
  const values = entries.map(([, value]) => value as string | null);

  db.query(`UPDATE ${tableName} SET ${setClause}, updated_at = ?, version = version + 1 WHERE id = ?;`).run(
    ...values,
    now,
    event.entity_id,
  );

  return true;
}

function applyDelete(
  db: Database,
  event: StoredEvent,
  fields: Record<string, unknown>,
  scope: ConflictScope,
): boolean {
  const tableName = tableForEntityKind(event.entity_kind);
  if (!tableName) {
    return false;
  }

  if (event.operation === "dependency.removed") {
    const sourceId = validateRequiredStringField(fields, "source_id");
    const dependsOnId = validateRequiredStringField(fields, "depends_on_id");
    if (!sourceId || !dependsOnId) {
      return false;
    }

    db.query("DELETE FROM dependencies WHERE source_id = ? AND depends_on_id = ?;").run(sourceId, dependsOnId);
    return true;
  }

  if (event.entity_kind === "task") {
    const subtasks = removeTaskSubtree(db, event.entity_id);
    const subtaskIds = subtasks.map((s) => s.id);
    removeConflictsForEntityIds(db, "subtask", subtaskIds, scope);
    removeConflictsForEntityIds(db, "task", [event.entity_id], scope);
  } else if (event.entity_kind === "subtask") {
    removeDependenciesTouchingNode(db, event.entity_id);
    removeConflictsForEntityIds(db, "subtask", [event.entity_id], scope);
  } else {
    removeConflictsForEntityIds(db, event.entity_kind, [event.entity_id], scope);
  }

  db.query(`DELETE FROM ${tableName} WHERE id = ?;`).run(event.entity_id);
  return true;
}

function hasPendingDeleteConflict(db: Database, sourceEventId: string): boolean {
  const row = db
    .query(
      `
      SELECT 1
      FROM sync_conflicts
      WHERE event_id = ?
        AND field_name = '__delete__'
        AND resolution = 'pending'
      LIMIT 1;
      `,
    )
    .get(sourceEventId);

  return row !== null;
}

function pendingDeleteConflictSourceEventId(fields: Record<string, unknown>): string | null {
  const sourceEventId = fields.source_event_id;
  return typeof sourceEventId === "string" && sourceEventId.length > 0 ? sourceEventId : null;
}

function shouldWithholdDeleteCascadeEvent(db: Database, event: StoredEvent, fields: Record<string, unknown>): boolean {
  const sourceEventId = pendingDeleteConflictSourceEventId(fields);
  if (!sourceEventId) {
    return false;
  }

  const isDeleteCascadeEvent = event.operation === "dependency.removed" || event.operation === "subtask.deleted";
  if (!isDeleteCascadeEvent) {
    return false;
  }

  return hasPendingDeleteConflict(db, sourceEventId);
}

function applyEntityFields(
  db: Database,
  event: StoredEvent,
  fields: Record<string, unknown>,
  scope: ConflictScope,
): boolean {
  if (event.operation.endsWith(".deleted") || event.operation === "dependency.removed") {
    return applyDelete(db, event, fields, scope);
  }

  if (event.operation.endsWith(".created") || event.operation === "dependency.added") {
    return applyCreate(db, event, fields);
  }

  if (event.operation.endsWith(".updated")) {
    return applyUpdatePatch(db, event, fields);
  }

  // Backward-compatible fallback for old upsert events.
  if (event.operation === "upsert") {
    const tableName = tableForEntityKind(event.entity_kind);
    if (!tableName || !rowExists(db, tableName, event.entity_id)) {
      return applyCreate(db, event, fields);
    }
    return applyUpdatePatch(db, event, fields);
  }

  return false;
}

function applyReplayedCreateWithConflicts(
  db: Database,
  event: StoredEvent,
  fields: Record<string, unknown>,
  withheldConflictCount: number,
): boolean {
  if (withheldConflictCount === 0 || !event.operation.endsWith(".created")) {
    return false;
  }

  const tableName = tableForEntityKind(event.entity_kind);
  if (!tableName || !rowExists(db, tableName, event.entity_id)) {
    return false;
  }

  if (Object.keys(fields).length === 0) {
    return true;
  }

  return applyUpdatePatch(db, event, fields);
}

function storeEvent(db: Database, event: StoredEvent): void {
  db.query(
    `
    INSERT OR IGNORE INTO events (
      id,
      entity_kind,
      entity_id,
      operation,
      payload,
      git_branch,
      git_head,
      created_at,
      updated_at,
      version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);
    `,
  ).run(
    event.id,
    event.entity_kind,
    event.entity_id,
    event.operation,
    event.payload,
    event.git_branch,
    event.git_head,
    event.created_at,
    event.updated_at,
    event.version,
  );
}

export function syncStatus(cwd: string, sourceBranch: string): SyncStatusSummary {
  const storage = openTrekoonDatabase(cwd);
  const git = resolveGitContext(cwd);

  try {
    persistGitContext(storage.db, git);

    const cursor = loadCursor(storage.db, git.worktreePath, sourceBranch);
    const cursorToken: string = cursor?.cursor_token ?? "0:";
    const onSourceBranch: boolean = git.branchName !== null && git.branchName === sourceBranch;

    return {
      sourceBranch,
      ahead: countAhead(storage.db, git.branchName, sourceBranch),
      behind: onSourceBranch ? 0 : countBranchEventsSince(storage.db, sourceBranch, cursorToken),
      pendingConflicts: countPendingConflicts(storage.db),
      sameBranch: onSourceBranch,
      git,
    };
  } finally {
    storage.close();
  }
}

export function syncPull(cwd: string, sourceBranch: string): PullSummary {
  const storage = openTrekoonDatabase(cwd);

  try {
    const git = resolveGitContext(cwd);
    persistGitContext(storage.db, git);
    const cursor = loadCursor(storage.db, git.worktreePath, sourceBranch);
    const cursorToken = cursor?.cursor_token ?? "0:";
    const staleCursor: boolean = cursor !== null && isCursorStale(storage.db, cursorToken, sourceBranch);

    // Same-branch fast path: skip conflict detection when already on sourceBranch.
    // Null branchName (detached HEAD) falls through to the normal path.
    if (git.branchName !== null && git.branchName === sourceBranch) {
      let lastToken: string | null = null;
      let lastEventAt: number | null = cursor?.last_event_at ?? null;
      let scannedEvents = 0;

      writeTransaction(storage.db, (): void => {
        while (true) {
          const incomingEvents = queryBranchEventsSinceBatch(
            storage.db,
            sourceBranch,
            lastToken ?? cursorToken,
            SYNC_PULL_BATCH_SIZE,
          ) as StoredEvent[];

          if (incomingEvents.length === 0) {
            break;
          }

          scannedEvents += incomingEvents.length;

          for (const incoming of incomingEvents) {
            storeEvent(storage.db, incoming);
            lastToken = cursorTokenFromEvent(incoming);
            lastEventAt = incoming.created_at;
          }
        }

        if (lastToken) {
          saveCursor(storage.db, git.worktreePath, sourceBranch, lastToken, lastEventAt);
        }
      });

      return {
        sourceBranch,
        scannedEvents,
        appliedEvents: 0,
        createdConflicts: 0,
        cursorToken: lastToken,
        sameBranch: true,
        diagnostics: {
          malformedPayloadEvents: 0,
          applyRejectedEvents: 0,
          quarantinedEvents: 0,
          conflictEvents: 0,
          staleCursor,
          errorHints: staleCursor
            ? ["Stale cursor detected; some events may have been pruned. Consider a full rebuild."]
            : [],
        },
      };
    }

    let appliedEvents = 0;
    let createdConflicts = 0;
    let malformedPayloadEvents = 0;
    let applyRejectedEvents = 0;
    let quarantinedEvents = 0;
    let conflictEvents = 0;
    let lastToken: string | null = null;
    let lastEventAt: number | null = cursor?.last_event_at ?? null;
    let scannedEvents = 0;

    // Per-pull memoization for "ours" field-value lookups. Reused across
    // every incoming event so repeated probes of the same (entity, field)
    // are O(1) after first hit.
    const oursCache = createOursValueCache();

    // Conflict scope: every conflict / cleanup created by this pull is
    // tagged with the current worktree+branch so peer worktrees observing
    // the same entity own their own row set and cannot erase each other.
    const conflictScope: ConflictScope = scopeFromGitContext(git);

    writeTransaction(storage.db, (): void => {
      while (true) {
        const incomingEvents = queryBranchEventsSinceBatch(
          storage.db,
          sourceBranch,
          lastToken ?? cursorToken,
          SYNC_PULL_BATCH_SIZE,
        ) as StoredEvent[];

        if (incomingEvents.length === 0) {
          break;
        }

        scannedEvents += incomingEvents.length;

        for (const incoming of incomingEvents) {
          if (incoming.operation === "resolve_conflict") {
            if (applyIncomingResolutionEvent(storage.db, incoming)) {
              appliedEvents += 1;
            }
            storeEvent(storage.db, incoming);
            lastToken = cursorTokenFromEvent(incoming);
            lastEventAt = incoming.created_at;
            continue;
          }

          const payloadValidation = parsePayload(incoming.payload);

          if (!payloadValidation.ok) {
            malformedPayloadEvents += 1;
            quarantinedEvents += 1;
            createConflict(
              storage.db,
              incoming,
              "__payload__",
              null,
              payloadValidation.reason ?? "Invalid payload",
              conflictScope,
              "invalid",
            );
            createdConflicts += 1;
            storeEvent(storage.db, incoming);
            lastToken = cursorTokenFromEvent(incoming);
            lastEventAt = incoming.created_at;
            continue;
          }

          const payload: EventPayload = { fields: payloadValidation.fields };

          if (shouldWithholdDeleteCascadeEvent(storage.db, incoming, payload.fields)) {
            storeEvent(storage.db, incoming);
            lastToken = cursorTokenFromEvent(incoming);
            lastEventAt = incoming.created_at;
            continue;
          }

          const isDeleteWithLocalEdits =
            (incoming.operation.endsWith(".deleted") && hasLocalDeleteCascadeEdits(storage.db, incoming, git.branchName)) ||
            (incoming.operation === "dependency.removed" && hasLocalDependencyDeleteConflict(storage.db, incoming, git.branchName));
          if (isDeleteWithLocalEdits) {
            createConflict(storage.db, incoming, "__delete__", null, "Entity deleted on source branch", conflictScope);
            createdConflicts += 1;
            conflictEvents += 1;
            storeEvent(storage.db, incoming);
            lastToken = cursorTokenFromEvent(incoming);
            lastEventAt = incoming.created_at;
            continue;
          }

          const fieldsToApply: Record<string, unknown> = {};
          let withheldConflictCount = 0;

          for (const [fieldName, value] of Object.entries(payload.fields)) {
            if (SYNC_EVENT_METADATA_FIELDS.has(fieldName)) {
              fieldsToApply[fieldName] = value;
              continue;
            }

            const conflict = entityFieldConflict(
              storage.db,
              git.branchName,
              sourceBranch,
              incoming,
              fieldName,
              value,
              oursCache,
            );

            if (conflict) {
              withheldConflictCount += 1;
              conflictEvents += 1;
              createConflict(storage.db, incoming, fieldName, conflict.oursValue, conflict.theirsValue);
              createdConflicts += 1;
              continue;
            }

            fieldsToApply[fieldName] = value;
          }

          if (applyEntityFields(storage.db, incoming, fieldsToApply)) {
            appliedEvents += 1;
          } else if (applyReplayedCreateWithConflicts(storage.db, incoming, fieldsToApply, withheldConflictCount)) {
            appliedEvents += 1;
          } else {
            applyRejectedEvents += 1;
            quarantinedEvents += 1;
            createConflict(
              storage.db,
              incoming,
              "__apply__",
              null,
              `Rejected event ${incoming.operation} for ${incoming.entity_kind}`,
              "invalid",
            );
            createdConflicts += 1;
          }

          storeEvent(storage.db, incoming);
          lastToken = cursorTokenFromEvent(incoming);
          lastEventAt = incoming.created_at;
        }
      }

      if (lastToken) {
        saveCursor(storage.db, git.worktreePath, sourceBranch, lastToken, lastEventAt);
      }
    });

    const errorHints: string[] = buildSyncErrorHints({
      malformedPayloadEvents,
      applyRejectedEvents,
      conflictEvents,
    });
    if (staleCursor) {
      errorHints.push("Stale cursor detected; some events may have been pruned. Consider a full rebuild.");
    }

    return {
      sourceBranch,
      scannedEvents,
      appliedEvents,
      createdConflicts,
      cursorToken: lastToken,
      sameBranch: false,
      diagnostics: {
        malformedPayloadEvents,
        applyRejectedEvents,
        quarantinedEvents,
        conflictEvents,
        staleCursor,
        errorHints,
      },
    };
  } finally {
    storage.close();
  }
}

function parseConflictValue(value: string | null): unknown {
  if (value === null) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function updateSingleField(
  db: Database,
  entityKind: string,
  entityId: string,
  fieldName: string,
  value: unknown,
  options: { allowMissing?: boolean } = {},
): void {
  const tableName = tableForEntityKind(entityKind);
  if (!tableName) {
    throw new DomainError({
      code: "unsupported_entity_kind",
      message: `No table mapping for entity kind: ${entityKind}`,
      details: { entityKind },
    });
  }

  const validFields: readonly string[] = SYNC_ALLOWED_FIELDS[tableName] ?? [];
  if (!validFields.includes(fieldName)) {
    throw new DomainError({
      code: "disallowed_field",
      message: `Field '${fieldName}' is not allowed for table '${tableName}'`,
      details: { tableName, fieldName },
    });
  }

  const now: number = Date.now();
  const normalizedValue = typeof value === "string" || value === null ? value : JSON.stringify(value);
  const result = db
    .query(`UPDATE ${tableName} SET ${fieldName} = ?, updated_at = ?, version = version + 1 WHERE id = ?;`)
    .run(normalizedValue, now, entityId);

  if (result.changes === 0 && !options.allowMissing) {
    throw new DomainError({
      code: "row_not_found",
      message: `No row updated: entity '${entityKind}' with id '${entityId}' not found in table '${tableName}'`,
      details: { tableName, entityKind, entityId },
    });
  }
}

function deleteSingleEntity(
  db: Database,
  entityKind: string,
  entityId: string,
  options: { allowMissing?: boolean } = {},
): void {
  const tableName = tableForEntityKind(entityKind);
  if (!tableName) {
    throw new DomainError({
      code: "unsupported_entity_kind",
      message: `No table mapping for entity kind: ${entityKind}`,
      details: { entityKind },
    });
  }

  const result = db.query(`DELETE FROM ${tableName} WHERE id = ?;`).run(entityId);

  if (result.changes === 0 && !options.allowMissing) {
    throw new DomainError({
      code: "row_not_found",
      message: `No row deleted: entity '${entityKind}' with id '${entityId}' not found in table '${tableName}'`,
      details: { tableName, entityKind, entityId },
    });
  }
}

function normalizeResolveAllFilters(filters: ResolveAllQueryFilters): ResolveAllFilters {
  return {
    entity: filters.entityId ?? null,
    field: filters.fieldName ?? null,
  };
}

function resolveConflictRow(
  db: Database,
  conflict: ConflictRow,
  resolution: SyncResolution,
  git: ResolutionWriteContext,
): void {
  if (resolution === "theirs") {
    applyConflictTheirsResolution(db, conflict);
  }

  const now: number = nextEventTimestamp(db);
  db.query("UPDATE sync_conflicts SET resolution = ?, updated_at = ?, version = version + 1 WHERE id = ?;").run(
    resolution,
    now,
    conflict.id,
  );

  appendResolutionEvent(db, git.branchName, git.headSha, conflict, resolution, now);
}

function appendResolutionEvent(
  db: Database,
  gitBranch: string | null,
  gitHead: string | null,
  conflict: ConflictRow,
  resolution: SyncResolution,
  timestamp?: number,
): void {
  const now: number = timestamp ?? nextEventTimestamp(db);
  const resolvedValue: string | null = resolution === "theirs" ? conflict.theirs_value : conflict.ours_value;

  db.query(
    `
    INSERT INTO events (
      id,
      entity_kind,
      entity_id,
      operation,
      payload,
      git_branch,
      git_head,
      created_at,
      updated_at,
      version
    ) VALUES (?, ?, ?, 'resolve_conflict', ?, ?, ?, ?, ?, 1);
    `,
  ).run(
    randomUUID(),
    conflict.entity_kind,
    conflict.entity_id,
    JSON.stringify({
      conflict_id: conflict.id,
      source_event_id: conflict.event_id,
      field: conflict.field_name,
      resolution,
      value: resolvedValue,
    }),
    gitBranch,
    gitHead,
    now,
    now,
  );
}

export function listSyncConflicts(cwd: string, mode: SyncConflictMode): SyncConflictListItem[] {
  const storage = openTrekoonDatabase(cwd);

  try {
    const whereClause = mode === "pending" ? "WHERE resolution = 'pending'" : "";
    return storage.db
      .query(
        `
        SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at
        FROM sync_conflicts
        ${whereClause}
        ORDER BY created_at ASC;
        `,
      )
      .all() as SyncConflictListItem[];
  } finally {
    storage.close();
  }
}

export function getSyncConflict(cwd: string, conflictId: string): SyncConflictDetail {
  const storage = openTrekoonDatabase(cwd);

  try {
    const conflict = storage.db
      .query(
        `
        SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at
        FROM sync_conflicts
        WHERE id = ?
        LIMIT 1;
        `,
      )
      .get(conflictId) as ConflictRow | null;

    if (!conflict) {
      throw new Error(`Conflict '${conflictId}' not found.`);
    }

    const event = storage.db
      .query(
        `
        SELECT id, operation, payload, git_branch, git_head, created_at
        FROM events
        WHERE id = ?
        LIMIT 1;
        `,
      )
      .get(conflict.event_id) as
      | {
          id: string;
          operation: string;
          payload: string;
          git_branch: string | null;
          git_head: string | null;
          created_at: number;
        }
      | null;

    return {
      id: conflict.id,
      eventId: conflict.event_id,
      entityKind: conflict.entity_kind,
      entityId: conflict.entity_id,
      fieldName: conflict.field_name,
      oursValue: parseConflictValue(conflict.ours_value),
      theirsValue: parseConflictValue(conflict.theirs_value),
      resolution: conflict.resolution,
      createdAt: conflict.created_at,
      updatedAt: conflict.updated_at,
      event,
    };
  } finally {
    storage.close();
  }
}

function lookupPendingConflict(db: Database, conflictId: string): ConflictRow {
  const conflict = db
    .query(
      `
      SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at
      FROM sync_conflicts
      WHERE id = ?
      LIMIT 1;
      `,
    )
    .get(conflictId) as ConflictRow | null;

  if (!conflict) {
    throw new Error(`Conflict '${conflictId}' not found.`);
  }

  if (conflict.resolution !== "pending") {
    throw new Error(`Conflict '${conflictId}' already resolved.`);
  }

  return conflict;
}

export function syncResolve(cwd: string, conflictId: string, resolution: SyncResolution): ResolveSummary {
  const storage = openTrekoonDatabase(cwd);
  const git = resolveGitContext(cwd);

  try {
    persistGitContext(storage.db, git);

    // lookupPendingConflict is inside the writeTransaction so that the
    // "is this still pending?" check and the resolution mutation are
    // atomic.  Without this, two concurrent resolves could both pass
    // the check and double-resolve the same conflict.
    const conflict = writeTransaction(storage.db, (): ConflictRow => {
      const row = lookupPendingConflict(storage.db, conflictId);
      resolveConflictRow(storage.db, row, resolution, git);
      return row;
    });

    return {
      conflictId,
      resolution,
      entityKind: conflict.entity_kind,
      entityId: conflict.entity_id,
      fieldName: conflict.field_name,
    };
  } finally {
    storage.close();
  }
}

// Preview is read-only — no git context persistence needed.
export function syncResolvePreview(cwd: string, conflictId: string, resolution: SyncResolution): ResolvePreviewSummary {
  const storage = openTrekoonDatabase(cwd);

  try {
    const conflict = lookupPendingConflict(storage.db, conflictId);

    const oursValue: unknown = parseConflictValue(conflict.ours_value);
    const theirsValue: unknown = parseConflictValue(conflict.theirs_value);
    const wouldWrite: unknown = resolution === "theirs" ? theirsValue : oursValue;

    return {
      conflictId,
      resolution,
      entityKind: conflict.entity_kind,
      entityId: conflict.entity_id,
      fieldName: conflict.field_name,
      oursValue,
      theirsValue,
      wouldWrite,
      dryRun: true,
    };
  } finally {
    storage.close();
  }
}

function queryPendingConflictIds(
  db: Database,
  filters: ResolveAllQueryFilters,
): readonly string[] {
  const conditions: string[] = ["resolution = 'pending'"];
  const params: string[] = [];

  if (filters.entityId !== undefined) {
    conditions.push("entity_id = ?");
    params.push(filters.entityId);
  }

  if (filters.fieldName !== undefined) {
    conditions.push("field_name = ?");
    params.push(filters.fieldName);
  }

  const sql = `
    SELECT c.id
    FROM sync_conflicts c
    LEFT JOIN events e ON e.id = c.event_id
    WHERE ${conditions.map((condition) => condition.replaceAll("resolution", "c.resolution").replaceAll("entity_id", "c.entity_id").replaceAll("field_name", "c.field_name")).join(" AND ")}
    ORDER BY COALESCE(e.created_at, c.created_at) ASC, COALESCE(e.id, c.event_id) ASC, c.created_at ASC, c.id ASC;
  `;

  return (db.query(sql).all(...params) as ConflictOrderRow[]).map((row) => row.id);
}

function queryPendingConflictsByIds(db: Database, conflictIds: readonly string[]): readonly ConflictRow[] {
  if (conflictIds.length === 0) {
    return [];
  }

  const placeholders = conflictIds.map(() => "?").join(", ");
  const rows = db
    .query(
      `
      SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution, created_at, updated_at
      FROM sync_conflicts
      WHERE resolution = 'pending' AND id IN (${placeholders});
      `,
    )
    .all(...conflictIds) as ConflictRow[];

  const rowById = new Map(rows.map((row) => [row.id, row]));

  return conflictIds.flatMap((conflictId) => {
    const row = rowById.get(conflictId);
    return row ? [row] : [];
  });
}

export function syncResolveAll(
  cwd: string,
  resolution: SyncResolution,
  filters: ResolveAllQueryFilters,
  options: ResolveAllOptions = {},
): ResolveAllSummary {
  const storage = openTrekoonDatabase(cwd);
  const git = resolveGitContext(cwd);
  const normalizedFilters: ResolveAllFilters = normalizeResolveAllFilters(filters);

  try {
    persistGitContext(storage.db, git);

    const resolvedIds: string[] = writeTransaction(storage.db, (): string[] => {
      const expectedConflictIds = options.expectedConflictIds;
      const orderedConflictIds = expectedConflictIds ?? queryPendingConflictIds(storage.db, filters);

      if (orderedConflictIds.length === 0) {
        throw new DomainError({
          code: "no_matching_conflicts",
          message: "No pending conflicts match the given filters.",
          details: { filters: normalizedFilters },
        });
      }

      const ids: string[] = [];

      for (let offset = 0; offset < orderedConflictIds.length; offset += RESOLVE_ALL_CHUNK_SIZE) {
        const chunkIds = orderedConflictIds.slice(offset, offset + RESOLVE_ALL_CHUNK_SIZE);
        const chunkConflicts = queryPendingConflictsByIds(storage.db, chunkIds);

        if (chunkConflicts.length !== chunkIds.length) {
          throw new DomainError({
            code: "conflict_set_changed",
            message: "Pending conflicts changed before batch resolution could be applied.",
            details: {
              filters: normalizedFilters,
              expectedConflictIds: chunkIds,
              availableConflictIds: chunkConflicts.map((conflict) => conflict.id),
            },
          });
        }

        for (const conflict of chunkConflicts) {
          resolveConflictRow(storage.db, conflict, resolution, git);
          ids.push(conflict.id);
        }
      }

      return ids;
    });

    return {
      resolution,
      resolvedCount: resolvedIds.length,
      resolvedIds,
      filters: normalizedFilters,
    };
  } finally {
    storage.close();
  }
}

export function syncResolveAllPreview(
  cwd: string,
  resolution: SyncResolution,
  filters: ResolveAllQueryFilters,
): ResolveAllPreviewSummary {
  const storage = openTrekoonDatabase(cwd);
  const normalizedFilters: ResolveAllFilters = normalizeResolveAllFilters(filters);

  try {
    const conflictIds = queryPendingConflictIds(storage.db, filters);

    if (conflictIds.length === 0) {
      throw new DomainError({
        code: "no_matching_conflicts",
        message: "No pending conflicts match the given filters.",
        details: { filters: normalizedFilters },
      });
    }

    return {
      resolution,
      matchedCount: conflictIds.length,
      matchedIds: conflictIds,
      filters: normalizedFilters,
      dryRun: true,
    };
  } finally {
    storage.close();
  }
}
