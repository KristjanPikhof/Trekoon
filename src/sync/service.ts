import { randomUUID } from "node:crypto";

import { type Database } from "bun:sqlite";

import { openTrekoonDatabase } from "../storage/database";
import { openBranchDatabaseSnapshot } from "./branch-db";
import { persistGitContext, resolveGitContext } from "./git-context";
import { type PullSummary, type ResolveSummary, type SyncResolution, type SyncStatusSummary } from "./types";

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
}

interface EventPayload {
  readonly fields?: Record<string, unknown>;
}

function parsePayload(rawPayload: string): EventPayload {
  try {
    const parsed: unknown = JSON.parse(rawPayload);

    if (typeof parsed === "object" && parsed !== null) {
      return parsed as EventPayload;
    }
  } catch {
    // Fall back to empty payload.
  }

  return {};
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

function parseCursorToken(token: string): { createdAt: number; id: string | null } {
  const [createdAtRaw, idRaw] = token.split(":");
  const createdAt: number = Number.parseInt(createdAtRaw ?? "0", 10);

  return {
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    id: idRaw && idRaw.length > 0 ? idRaw : null,
  };
}

function cursorTokenFromEvent(event: StoredEvent): string {
  return `${event.created_at}:${event.id}`;
}

function loadCursor(db: Database, sourceBranch: string): CursorRow | null {
  return db
    .query(
      `
      SELECT source_branch, cursor_token, last_event_at
      FROM sync_cursors
      WHERE source_branch = ?
      LIMIT 1;
      `,
    )
    .get(sourceBranch) as CursorRow | null;
}

function saveCursor(db: Database, sourceBranch: string, cursorToken: string, lastEventAt: number | null): void {
  const now: number = Date.now();

  db.query(
    `
    INSERT INTO sync_cursors (
      id,
      source_branch,
      cursor_token,
      last_event_at,
      created_at,
      updated_at,
      version
    ) VALUES (
      @sourceBranch,
      @sourceBranch,
      @cursorToken,
      @lastEventAt,
      @now,
      @now,
      1
    )
    ON CONFLICT(id) DO UPDATE SET
      cursor_token = excluded.cursor_token,
      last_event_at = excluded.last_event_at,
      updated_at = excluded.updated_at,
      version = sync_cursors.version + 1;
    `,
  ).run({
    sourceBranch,
    cursorToken,
    lastEventAt,
    now,
  });
}

function queryNewEvents(remoteDb: Database, cursorToken: string): StoredEvent[] {
  const cursor = parseCursorToken(cursorToken);

  return remoteDb
    .query(
      `
      SELECT id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version
      FROM events
      WHERE created_at > @createdAt
         OR (created_at = @createdAt AND id > @id)
      ORDER BY created_at ASC, id ASC;
      `,
    )
    .all({
      createdAt: cursor.createdAt,
      id: cursor.id ?? "",
    }) as StoredEvent[];
}

function countPendingConflicts(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
    .get() as { count: number } | null;

  return row?.count ?? 0;
}

function countBehind(remoteDb: Database, cursorToken: string): number {
  const cursor = parseCursorToken(cursorToken);
  const row = remoteDb
    .query(
      `
      SELECT COUNT(*) AS count
      FROM events
      WHERE created_at > @createdAt
         OR (created_at = @createdAt AND id > @id);
      `,
    )
    .get({
      createdAt: cursor.createdAt,
      id: cursor.id ?? "",
    }) as { count: number } | null;

  return row?.count ?? 0;
}

function listRemoteEventIds(remoteDb: Database): Set<string> {
  const rows = remoteDb.query("SELECT id FROM events;").all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

function countAhead(localDb: Database, currentBranch: string | null, remoteEventIds: Set<string>): number {
  const rows = localDb
    .query("SELECT id, git_branch FROM events WHERE git_branch = ?;")
    .all(currentBranch) as Array<{ id: string; git_branch: string | null }>;

  return rows.filter((row) => !remoteEventIds.has(row.id)).length;
}

function readFieldValue(payload: EventPayload, field: string): unknown {
  const fields = payload.fields;
  if (!fields) {
    return undefined;
  }

  return fields[field];
}

function serializeValue(value: unknown): string | null {
  if (typeof value === "undefined") {
    return null;
  }

  return JSON.stringify(value);
}

function entityFieldConflict(
  localDb: Database,
  sourceBranch: string,
  event: StoredEvent,
  fieldName: string,
  incomingValue: unknown,
): { oursValue: string | null; theirsValue: string | null } | null {
  const rows = localDb
    .query(
      `
      SELECT payload, git_branch
      FROM events
      WHERE entity_kind = ? AND entity_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 50;
      `,
    )
    .all(event.entity_kind, event.entity_id) as Array<{ payload: string; git_branch: string | null }>;

  for (const row of rows) {
    if (row.git_branch === sourceBranch) {
      continue;
    }

    const payload = parsePayload(row.payload);
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

  return null;
}

function createConflict(
  db: Database,
  event: StoredEvent,
  fieldName: string,
  oursValue: string | null,
  theirsValue: string | null,
): void {
  const now: number = Date.now();
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1);
    `,
  ).run(randomUUID(), event.id, event.entity_kind, event.entity_id, fieldName, oursValue, theirsValue, now, now);
}

function applyEntityFields(db: Database, event: StoredEvent, fields: Record<string, unknown>): boolean {
  const tableName = tableForEntityKind(event.entity_kind);
  if (!tableName) {
    return false;
  }

  const now: number = Date.now();

  if (tableName === "epics") {
    db.query(
      `
      INSERT INTO epics (id, title, description, status, created_at, updated_at, version)
      VALUES (@id, @title, @description, @status, @now, @now, 1)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        updated_at = excluded.updated_at,
        version = epics.version + 1;
      `,
    ).run({
      id: event.entity_id,
      title: typeof fields.title === "string" ? fields.title : "Untitled epic",
      description: typeof fields.description === "string" ? fields.description : "",
      status: typeof fields.status === "string" ? fields.status : "open",
      now,
    });

    return true;
  }

  if (tableName === "tasks") {
    db.query(
      `
      INSERT INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version)
      VALUES (@id, @epicId, @title, @description, @status, @now, @now, 1)
      ON CONFLICT(id) DO UPDATE SET
        epic_id = excluded.epic_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        updated_at = excluded.updated_at,
        version = tasks.version + 1;
      `,
    ).run({
      id: event.entity_id,
      epicId: typeof fields.epic_id === "string" ? fields.epic_id : "missing-epic",
      title: typeof fields.title === "string" ? fields.title : "Untitled task",
      description: typeof fields.description === "string" ? fields.description : "",
      status: typeof fields.status === "string" ? fields.status : "open",
      now,
    });

    return true;
  }

  if (tableName === "subtasks") {
    db.query(
      `
      INSERT INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version)
      VALUES (@id, @taskId, @title, @description, @status, @now, @now, 1)
      ON CONFLICT(id) DO UPDATE SET
        task_id = excluded.task_id,
        title = excluded.title,
        description = excluded.description,
        status = excluded.status,
        updated_at = excluded.updated_at,
        version = subtasks.version + 1;
      `,
    ).run({
      id: event.entity_id,
      taskId: typeof fields.task_id === "string" ? fields.task_id : "missing-task",
      title: typeof fields.title === "string" ? fields.title : "Untitled subtask",
      description: typeof fields.description === "string" ? fields.description : "",
      status: typeof fields.status === "string" ? fields.status : "open",
      now,
    });

    return true;
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
    )
    VALUES (@id, @sourceId, @sourceKind, @dependsOnId, @dependsOnKind, @now, @now, 1)
    ON CONFLICT(id) DO UPDATE SET
      source_id = excluded.source_id,
      source_kind = excluded.source_kind,
      depends_on_id = excluded.depends_on_id,
      depends_on_kind = excluded.depends_on_kind,
      updated_at = excluded.updated_at,
      version = dependencies.version + 1;
    `,
  ).run({
    id: event.entity_id,
    sourceId: typeof fields.source_id === "string" ? fields.source_id : "",
    sourceKind: typeof fields.source_kind === "string" ? fields.source_kind : "task",
    dependsOnId: typeof fields.depends_on_id === "string" ? fields.depends_on_id : "",
    dependsOnKind: typeof fields.depends_on_kind === "string" ? fields.depends_on_kind : "task",
    now,
  });

  return true;
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

    const cursor = loadCursor(storage.db, sourceBranch);
    const cursorToken: string = cursor?.cursor_token ?? "0:";
    const remote = openBranchDatabaseSnapshot(sourceBranch, cwd);

    try {
      return {
        sourceBranch,
        ahead: countAhead(storage.db, git.branchName, listRemoteEventIds(remote.db)),
        behind: countBehind(remote.db, cursorToken),
        pendingConflicts: countPendingConflicts(storage.db),
        git,
      };
    } finally {
      remote.close();
    }
  } finally {
    storage.close();
  }
}

export function syncPull(cwd: string, sourceBranch: string): PullSummary {
  const storage = openTrekoonDatabase(cwd);
  const git = resolveGitContext(cwd);
  persistGitContext(storage.db, git);

  const remote = openBranchDatabaseSnapshot(sourceBranch, cwd);

  try {
    const cursor = loadCursor(storage.db, sourceBranch);
    const cursorToken = cursor?.cursor_token ?? "0:";
    const incomingEvents: StoredEvent[] = queryNewEvents(remote.db, cursorToken);

    let appliedEvents = 0;
    let createdConflicts = 0;
    let lastToken: string | null = null;
    let lastEventAt: number | null = cursor?.last_event_at ?? null;

    storage.db.transaction((): void => {
      for (const incoming of incomingEvents) {
        const payload = parsePayload(incoming.payload);
        const incomingFields: Record<string, unknown> = payload.fields ?? {};
        const fieldsToApply: Record<string, unknown> = {};
        let hasAppliedField = false;

        for (const [fieldName, value] of Object.entries(incomingFields)) {
          const conflict = entityFieldConflict(storage.db, sourceBranch, incoming, fieldName, value);

          if (conflict) {
            createConflict(storage.db, incoming, fieldName, conflict.oursValue, conflict.theirsValue);
            createdConflicts += 1;
            continue;
          }

          fieldsToApply[fieldName] = value;
          hasAppliedField = true;
        }

        if (hasAppliedField && applyEntityFields(storage.db, incoming, fieldsToApply)) {
          appliedEvents += 1;
        }

        storeEvent(storage.db, incoming);
        lastToken = cursorTokenFromEvent(incoming);
        lastEventAt = incoming.created_at;
      }

      if (lastToken) {
        saveCursor(storage.db, sourceBranch, lastToken, lastEventAt);
      }
    })();

    return {
      sourceBranch,
      scannedEvents: incomingEvents.length,
      appliedEvents,
      createdConflicts,
      cursorToken: lastToken,
    };
  } finally {
    remote.close();
    storage.close();
  }
}

function parseConflictValue(value: string | null): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function updateSingleField(db: Database, entityKind: string, entityId: string, fieldName: string, value: unknown): void {
  const tableName = tableForEntityKind(entityKind);
  if (!tableName) {
    return;
  }

  const allowedFields: Record<string, readonly string[]> = {
    epics: ["title", "description", "status"],
    tasks: ["epic_id", "title", "description", "status"],
    subtasks: ["task_id", "title", "description", "status"],
    dependencies: ["source_id", "source_kind", "depends_on_id", "depends_on_kind"],
  };

  const validFields: readonly string[] = allowedFields[tableName];
  if (!validFields.includes(fieldName)) {
    return;
  }

  const now: number = Date.now();
  db.query(`UPDATE ${tableName} SET ${fieldName} = ?, updated_at = ?, version = version + 1 WHERE id = ?;`).run(
    typeof value === "string" ? value : JSON.stringify(value),
    now,
    entityId,
  );
}

function appendResolutionEvent(
  db: Database,
  gitBranch: string | null,
  gitHead: string | null,
  conflict: ConflictRow,
  resolution: SyncResolution,
): void {
  const now: number = Date.now();
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

export function syncResolve(cwd: string, conflictId: string, resolution: SyncResolution): ResolveSummary {
  const storage = openTrekoonDatabase(cwd);
  const git = resolveGitContext(cwd);

  try {
    persistGitContext(storage.db, git);

    const conflict = storage.db
      .query(
        `
        SELECT id, event_id, entity_kind, entity_id, field_name, ours_value, theirs_value, resolution
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

    storage.db.transaction((): void => {
      if (resolution === "theirs") {
        updateSingleField(
          storage.db,
          conflict.entity_kind,
          conflict.entity_id,
          conflict.field_name,
          parseConflictValue(conflict.theirs_value),
        );
      }

      const now: number = Date.now();
      storage.db
        .query("UPDATE sync_conflicts SET resolution = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
        .run(resolution, now, conflict.id);

      appendResolutionEvent(storage.db, git.branchName, git.headSha, conflict, resolution);
    })();

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
