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

function isCursorStale(db: Database, cursorToken: string, sourceBranch: string): boolean {
  if (cursorToken === "0:") {
    return false;
  }

  const [createdAtRaw, idRaw] = cursorToken.split(":");
  const createdAt: number = Number.parseInt(createdAtRaw ?? "0", 10);
  const id: string = idRaw ?? "";

  if (!Number.isFinite(createdAt) || createdAt === 0) {
    return false;
  }

  // Check if the event referenced by the cursor still exists.
  // If the cursor references a specific event id, check for it.
  // Otherwise, check if any event at or after the cursor timestamp exists
  // on the source branch.
  if (id.length > 0) {
    const row = db
      .query("SELECT id FROM events WHERE id = ? LIMIT 1;")
      .get(id) as { id: string } | null;
    if (row) {
      return false;
    }
  }

  // The referenced event is gone. Check if there are any events on the
  // source branch at or after the cursor timestamp — if not, the cursor
  // may simply be at the end of the stream.
  const newerRow = db
    .query(
      `SELECT id FROM events
       WHERE git_branch = ? AND created_at >= ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1;`,
    )
    .get(sourceBranch, createdAt) as { id: string } | null;

  // If there are newer events but our referenced event is gone,
  // events between the cursor and the oldest remaining event were pruned.
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

function entityFieldConflict(
  localDb: Database,
  sourceBranch: string,
  event: StoredEvent,
  fieldName: string,
  incomingValue: unknown,
): { oursValue: string | null; theirsValue: string | null } | null {
  const currentValue = currentEntityFieldValue(localDb, event.entity_kind, event.entity_id, fieldName);
  if (serializeValue(currentValue) === serializeValue(incomingValue)) {
    return null;
  }

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
        AND (git_branch IS NULL OR git_branch != ?)
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
        sourceBranch,
        beforeCreatedAt,
        beforeCreatedAt,
        beforeId,
        CONFLICT_HISTORY_SCAN_BATCH_SIZE,
      ) as LocalEntityEventRow[];

    const incomingDependencyIdentity = dependencyEventIdentity(event);

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
      const theirsValue = serializeValue(incomingValue);

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
  resolution: string = "pending",
): void {
  const now: number = Date.now();
  const existing = db
    .query(
      `
      SELECT id, resolution, ours_value, theirs_value
      FROM sync_conflicts
      WHERE event_id = ? AND entity_kind = ? AND entity_id = ? AND field_name = ?
      ORDER BY CASE WHEN resolution = 'pending' THEN 0 ELSE 1 END, created_at ASC, id ASC
      LIMIT 1;
      `,
    )
    .get(event.id, event.entity_kind, event.entity_id, fieldName) as
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
      version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1);
    `,
  ).run(randomUUID(), event.id, event.entity_kind, event.entity_id, fieldName, oursValue, theirsValue, resolution, now, now);
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

function removeTaskSubtree(db: Database, taskId: string): void {
  const subtasks = db
    .query("SELECT id FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC;")
    .all(taskId) as Array<{ id: string }>;

  for (const subtask of subtasks) {
    removeDependenciesTouchingNode(db, subtask.id);
  }

  db.query("DELETE FROM subtasks WHERE task_id = ?;").run(taskId);
  removeDependenciesTouchingNode(db, taskId);
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

function applyConflictTheirsResolution(db: Database, conflict: ConflictRow): void {
  if (conflict.field_name === "__delete__") {
    if (conflict.entity_kind === "task") {
      removeTaskSubtree(db, conflict.entity_id);
    } else if (conflict.entity_kind === "subtask") {
      removeDependenciesTouchingNode(db, conflict.entity_id);
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

function hasLocalEntityEdits(db: Database, entityKind: string, entityId: string, sourceBranch: string): boolean {
  const row = db
    .query(
      `SELECT 1 FROM events WHERE entity_kind = ? AND entity_id = ? AND (git_branch IS NULL OR git_branch != ?) LIMIT 1;`,
    )
    .get(entityKind, entityId, sourceBranch);
  return row !== null;
}

function hasLocalDependencyEditsTouchingNodes(db: Database, nodeIds: readonly string[], sourceBranch: string): boolean {
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
          AND (git_branch IS NULL OR git_branch != ?)
          AND (
            json_extract(payload, '$.fields.source_id') IN (${placeholders})
            OR json_extract(payload, '$.fields.depends_on_id') IN (${placeholders})
          )
        LIMIT 1;
        `,
      )
      .get(sourceBranch, ...chunk, ...chunk);

    if (row !== null) {
      return true;
    }
  }

  return false;
}

function hasLocalDependencyEditsForIdentity(
  db: Database,
  sourceBranch: string,
  identity: DependencyEventIdentity,
): boolean {
  const row = db
    .query(
      `
      SELECT 1
      FROM events
      WHERE entity_kind = 'dependency'
        AND (git_branch IS NULL OR git_branch != ?)
        AND json_extract(payload, '$.fields.source_id') = ?
        AND json_extract(payload, '$.fields.source_kind') = ?
        AND json_extract(payload, '$.fields.depends_on_id') = ?
        AND json_extract(payload, '$.fields.depends_on_kind') = ?
      LIMIT 1;
      `,
    )
    .get(sourceBranch, identity.sourceId, identity.sourceKind, identity.dependsOnId, identity.dependsOnKind);

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
  sourceBranch: string,
  identity: DependencyEventIdentity,
): string | null {
  const row = db
    .query(
      `
      SELECT operation
      FROM events
      WHERE entity_kind = 'dependency'
        AND (git_branch IS NULL OR git_branch != ?)
        AND json_extract(payload, '$.fields.source_id') = ?
        AND json_extract(payload, '$.fields.source_kind') = ?
        AND json_extract(payload, '$.fields.depends_on_id') = ?
        AND json_extract(payload, '$.fields.depends_on_kind') = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
      `,
    )
    .get(sourceBranch, identity.sourceId, identity.sourceKind, identity.dependsOnId, identity.dependsOnKind) as
    | { operation: string }
    | null;

  return row?.operation ?? null;
}

function hasLocalDependencyDeleteConflict(db: Database, event: StoredEvent, sourceBranch: string): boolean {
  const identity = dependencyEventIdentity(event);
  if (identity === null) {
    return false;
  }

  const latestOperation = latestLocalDependencyOperationForIdentity(db, sourceBranch, identity);
  if (latestOperation === ENTITY_OPERATIONS.dependency.removed && !dependencyRowExistsForIdentity(db, identity)) {
    return false;
  }

  return hasLocalDependencyEditsForIdentity(db, sourceBranch, identity);
}

function hasLocalDeleteCascadeEdits(db: Database, event: StoredEvent, sourceBranch: string): boolean {
  if (hasLocalEntityEdits(db, event.entity_kind, event.entity_id, sourceBranch)) {
    return true;
  }

  if (event.entity_kind === "subtask") {
    return hasLocalDependencyEditsTouchingNodes(db, [event.entity_id], sourceBranch);
  }

  if (event.entity_kind !== "task") {
    return false;
  }

  const subtaskRows = db
    .query("SELECT id FROM subtasks WHERE task_id = ? ORDER BY created_at ASC, id ASC;")
    .all(event.entity_id) as Array<{ id: string }>;
  const subtaskIds = subtaskRows.map((row) => row.id);

  for (const subtaskId of subtaskIds) {
    if (hasLocalEntityEdits(db, "subtask", subtaskId, sourceBranch)) {
      return true;
    }
  }

  return hasLocalDependencyEditsTouchingNodes(db, [event.entity_id, ...subtaskIds], sourceBranch);
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

function applyDelete(db: Database, event: StoredEvent, fields: Record<string, unknown>): boolean {
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
    removeTaskSubtree(db, event.entity_id);
  } else if (event.entity_kind === "subtask") {
    removeDependenciesTouchingNode(db, event.entity_id);
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

function applyEntityFields(db: Database, event: StoredEvent, fields: Record<string, unknown>): boolean {
  if (event.operation.endsWith(".deleted") || event.operation === "dependency.removed") {
    return applyDelete(db, event, fields);
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
            (incoming.operation.endsWith(".deleted") && hasLocalDeleteCascadeEdits(storage.db, incoming, sourceBranch)) ||
            (incoming.operation === "dependency.removed" && hasLocalDependencyDeleteConflict(storage.db, incoming, sourceBranch));
          if (isDeleteWithLocalEdits) {
            createConflict(storage.db, incoming, "__delete__", null, "Entity deleted on source branch");
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
              continue;
            }

            const conflict = entityFieldConflict(storage.db, sourceBranch, incoming, fieldName, value);

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
