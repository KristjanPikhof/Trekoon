/**
 * Verifies that applyDelete clears sync_conflicts for all entities in the
 * deleted subtree (task → its subtasks, subtask, epic) inside the same
 * transaction. After a cascade delete, the resolve flow must NOT encounter
 * row_not_found errors because the stale conflicts simply are not there.
 *
 * Guards against the regression where a sync_conflict row pointed at an
 * entity that was silently deleted by a cascade, causing list/show/resolve
 * calls to fail.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { listSyncConflicts, syncPull } from "../../src/sync/service";

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-delete-cascade-"));
  tempDirs.push(workspace);
  mkdirSync(join(workspace, ".trekoon"), { recursive: true });
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
  mock.restore();
});

type Db = ReturnType<typeof openTrekoonDatabase>["db"];

// ---------------------------------------------------------------------------
// Mock git context
// ---------------------------------------------------------------------------

function mockGitContext(workspace: string, branchName: string): void {
  mock.module("../../src/sync/git-context", () => ({
    resolveGitContext: () => ({
      worktreePath: workspace,
      branchName,
      headSha: null,
      persistedAt: Date.now(),
    }),
    persistGitContext: () => undefined,
  }));
  setConflictScope(workspace, branchName);
}

// ---------------------------------------------------------------------------
// Entity insertion helpers
// ---------------------------------------------------------------------------

function insertEpic(db: Db, id: string, title: string): void {
  const ts = Date.now();
  db.query(
    `INSERT OR IGNORE INTO epics (id, title, description, status, created_at, updated_at, version)
     VALUES (?, ?, '', 'todo', ?, ?, 1);`,
  ).run(id, title, ts, ts);
}

function insertTask(db: Db, id: string, epicId: string, title: string): void {
  const ts = Date.now();
  db.query(
    `INSERT OR IGNORE INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version)
     VALUES (?, ?, ?, '', 'todo', ?, ?, 1);`,
  ).run(id, epicId, title, ts, ts);
}

function insertSubtask(db: Db, id: string, taskId: string, title: string): void {
  const ts = Date.now();
  db.query(
    `INSERT OR IGNORE INTO subtasks (id, task_id, title, description, status, created_at, updated_at, version)
     VALUES (?, ?, ?, '', 'todo', ?, ?, 1);`,
  ).run(id, taskId, title, ts, ts);
}

// ---------------------------------------------------------------------------
// Event insertion helpers
// ---------------------------------------------------------------------------

function insertEvent(
  db: Db,
  opts: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly operation: string;
    readonly branch: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: number;
  },
): string {
  const id = randomUUID();
  db.query(
    `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1);`,
  ).run(id, opts.entityKind, opts.entityId, opts.operation, JSON.stringify({ fields: opts.payload }), opts.branch, opts.createdAt, opts.createdAt);
  return id;
}

// ---------------------------------------------------------------------------
// Conflict insertion helper (simulates a pre-existing conflict)
// ---------------------------------------------------------------------------

/**
 * Default conflict scope used by `insertConflict` to mirror the worktree
 * + branch the active test mocks via `mockGitContext`. Each test sets this
 * at setup time so seeded conflict rows match the cleanup scope under which
 * the cascade-delete pull runs.
 */
let defaultConflictScope: { workspace: string; branch: string } = { workspace: "", branch: "" };

function setConflictScope(workspace: string, branch: string): void {
  defaultConflictScope = { workspace, branch };
}

function insertConflict(
  db: Db,
  opts: {
    readonly eventId: string;
    readonly entityKind: string;
    readonly entityId: string;
    readonly fieldName: string;
    readonly oursValue: string;
    readonly theirsValue: string;
    readonly worktreePath?: string;
    readonly currentBranch?: string;
  },
): string {
  const id = randomUUID();
  const ts = Date.now();
  db.query(
    `INSERT INTO sync_conflicts (
       id, event_id, entity_kind, entity_id, field_name,
       ours_value, theirs_value, resolution,
       created_at, updated_at, version,
       worktree_path, current_branch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, 1, ?, ?);`,
  ).run(
    id,
    opts.eventId,
    opts.entityKind,
    opts.entityId,
    opts.fieldName,
    opts.oursValue,
    opts.theirsValue,
    ts,
    ts,
    opts.worktreePath ?? defaultConflictScope.workspace,
    opts.currentBranch ?? defaultConflictScope.branch,
  );
  return id;
}

function countConflicts(db: Db): number {
  return (db.query("SELECT COUNT(*) AS c FROM sync_conflicts;").get() as { c: number }).c;
}

function conflictExists(db: Db, conflictId: string): boolean {
  const row = db.query("SELECT id FROM sync_conflicts WHERE id = ? LIMIT 1;").get(conflictId);
  return row !== null;
}

// ---------------------------------------------------------------------------
// Task-delete cascade clears sync_conflicts for task + subtasks
// ---------------------------------------------------------------------------

describe("applyDelete clears sync_conflicts on task cascade delete", (): void => {
  test("conflicts on a deleted task's subtasks are removed; unrelated conflicts remain", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();
    const subtask1Id = randomUUID();
    const subtask2Id = randomUUID();
    const unrelatedEpicId = randomUUID();

    // Insert the entity rows
    insertEpic(db, epicId, "Epic A");
    insertTask(db, taskId, epicId, "Task 1");
    insertSubtask(db, subtask1Id, taskId, "Subtask 1a");
    insertSubtask(db, subtask2Id, taskId, "Subtask 1b");
    insertEpic(db, unrelatedEpicId, "Unrelated Epic");

    // Insert some events that the "source event id" can reference
    const fakeSrcEvent1 = randomUUID();
    const fakeSrcEvent2 = randomUUID();
    const fakeSrcEventUnrelated = randomUUID();

    // Pre-existing conflicts: one for each subtask, one for the task itself,
    // and one on an unrelated entity that must NOT be removed.
    const conflictSubtask1 = insertConflict(db, {
      eventId: fakeSrcEvent1,
      entityKind: "subtask",
      entityId: subtask1Id,
      fieldName: "title",
      oursValue: '"ours-title"',
      theirsValue: '"theirs-title"',
    });

    const conflictSubtask2 = insertConflict(db, {
      eventId: fakeSrcEvent2,
      entityKind: "subtask",
      entityId: subtask2Id,
      fieldName: "title",
      oursValue: '"ours-title2"',
      theirsValue: '"theirs-title2"',
    });

    const conflictUnrelated = insertConflict(db, {
      eventId: fakeSrcEventUnrelated,
      entityKind: "epic",
      entityId: unrelatedEpicId,
      fieldName: "title",
      oursValue: '"our-epic"',
      theirsValue: '"their-epic"',
    });

    // Verify baseline: 3 conflicts pre-delete
    expect(countConflicts(db)).toBe(3);

    // Insert a task.deleted event on main branch so syncPull picks it up
    const ts = Date.now() + 1000;
    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      operation: "task.deleted",
      branch: MAIN,
      payload: {},
      createdAt: ts,
    });

    storage.close();

    // Pull from main while on feature/x — applies the task.deleted event
    const result = syncPull(workspace, MAIN);
    expect(result.appliedEvents).toBeGreaterThanOrEqual(1);

    // Re-open to inspect state
    const storage2 = openTrekoonDatabase(workspace);
    const db2 = storage2.db;

    // Task and its subtasks must be gone from entity tables
    const taskRow = db2.query("SELECT id FROM tasks WHERE id = ? LIMIT 1;").get(taskId);
    expect(taskRow).toBeNull();
    const subtask1Row = db2.query("SELECT id FROM subtasks WHERE id = ? LIMIT 1;").get(subtask1Id);
    expect(subtask1Row).toBeNull();
    const subtask2Row = db2.query("SELECT id FROM subtasks WHERE id = ? LIMIT 1;").get(subtask2Id);
    expect(subtask2Row).toBeNull();

    // Conflicts on the deleted subtree must be gone
    expect(conflictExists(db2, conflictSubtask1)).toBe(false);
    expect(conflictExists(db2, conflictSubtask2)).toBe(false);

    // Conflict on the unrelated epic must remain
    expect(conflictExists(db2, conflictUnrelated)).toBe(true);

    storage2.close();
  });

  test("conflict on the task itself is removed when the task is deleted", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();

    insertEpic(db, epicId, "Epic B");
    insertTask(db, taskId, epicId, "Task only");

    const fakeSrcEvent = randomUUID();
    const conflictTask = insertConflict(db, {
      eventId: fakeSrcEvent,
      entityKind: "task",
      entityId: taskId,
      fieldName: "title",
      oursValue: '"ours-task"',
      theirsValue: '"theirs-task"',
    });

    expect(countConflicts(db)).toBe(1);

    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      operation: "task.deleted",
      branch: MAIN,
      payload: {},
      createdAt: Date.now() + 1000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    const storage2 = openTrekoonDatabase(workspace);
    expect(conflictExists(storage2.db, conflictTask)).toBe(false);
    expect(countConflicts(storage2.db)).toBe(0);
    storage2.close();
  });

  test("task cascade cleanup chunks thousands of subtask conflicts", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();
    const subtaskIds = Array.from({ length: 5_000 }, (): string => randomUUID());
    const fakeEventId = randomUUID();

    const seedRows = db.transaction((): void => {
      insertEpic(db, epicId, "Epic with many subtasks");
      insertTask(db, taskId, epicId, "Task with many subtasks");
      for (const subtaskId of subtaskIds) {
        insertSubtask(db, subtaskId, taskId, "Subtask");
        insertConflict(db, {
          eventId: fakeEventId,
          entityKind: "subtask",
          entityId: subtaskId,
          fieldName: "title",
          oursValue: '"ours"',
          theirsValue: '"theirs"',
        });
      }
    });
    seedRows();

    expect(countConflicts(db)).toBe(5_000);

    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      operation: "task.deleted",
      branch: MAIN,
      payload: {},
      createdAt: Date.now() + 1000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    const reopened = openTrekoonDatabase(workspace);
    try {
      expect(countConflicts(reopened.db)).toBe(0);
      expect(reopened.db.query("SELECT COUNT(*) AS c FROM subtasks WHERE task_id = ?;").get(taskId)).toEqual({ c: 0 });
    } finally {
      reopened.close();
    }
  }, 15_000);
});

// ---------------------------------------------------------------------------
// Subtask-delete cascade clears sync_conflicts for that subtask only
// ---------------------------------------------------------------------------

describe("applyDelete clears sync_conflicts on subtask delete", (): void => {
  test("conflict on a deleted subtask is removed; sibling subtask conflict remains", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();
    const subtask1Id = randomUUID();
    const subtask2Id = randomUUID();

    insertEpic(db, epicId, "Epic C");
    insertTask(db, taskId, epicId, "Task C1");
    insertSubtask(db, subtask1Id, taskId, "Sub C1a");
    insertSubtask(db, subtask2Id, taskId, "Sub C1b");

    const fakeSrcEvent1 = randomUUID();
    const fakeSrcEvent2 = randomUUID();

    const conflictDeleted = insertConflict(db, {
      eventId: fakeSrcEvent1,
      entityKind: "subtask",
      entityId: subtask1Id,
      fieldName: "title",
      oursValue: '"ours-sub1"',
      theirsValue: '"theirs-sub1"',
    });

    const conflictSibling = insertConflict(db, {
      eventId: fakeSrcEvent2,
      entityKind: "subtask",
      entityId: subtask2Id,
      fieldName: "title",
      oursValue: '"ours-sub2"',
      theirsValue: '"theirs-sub2"',
    });

    expect(countConflicts(db)).toBe(2);

    // Delete only subtask1 via main branch event
    insertEvent(db, {
      entityKind: "subtask",
      entityId: subtask1Id,
      operation: "subtask.deleted",
      branch: MAIN,
      payload: { task_id: taskId },
      createdAt: Date.now() + 1000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    const storage2 = openTrekoonDatabase(workspace);
    const db2 = storage2.db;

    // subtask1 is gone
    expect(db2.query("SELECT id FROM subtasks WHERE id = ? LIMIT 1;").get(subtask1Id)).toBeNull();
    // subtask2 still exists
    expect(db2.query("SELECT id FROM subtasks WHERE id = ? LIMIT 1;").get(subtask2Id)).not.toBeNull();

    // Conflict for deleted subtask is gone
    expect(conflictExists(db2, conflictDeleted)).toBe(false);
    // Sibling conflict remains
    expect(conflictExists(db2, conflictSibling)).toBe(true);

    storage2.close();
  });
});

// ---------------------------------------------------------------------------
// Epic-delete cascade clears sync_conflicts for the epic entity
// ---------------------------------------------------------------------------

describe("applyDelete clears sync_conflicts on epic delete", (): void => {
  test("conflict on a deleted epic is removed; unrelated epic conflict remains", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const otherEpicId = randomUUID();

    insertEpic(db, epicId, "Epic D");
    insertEpic(db, otherEpicId, "Epic E (unrelated)");

    const fakeSrcEventD = randomUUID();
    const fakeSrcEventE = randomUUID();

    const conflictDeletedEpic = insertConflict(db, {
      eventId: fakeSrcEventD,
      entityKind: "epic",
      entityId: epicId,
      fieldName: "title",
      oursValue: '"ours-epic-d"',
      theirsValue: '"theirs-epic-d"',
    });

    const conflictOtherEpic = insertConflict(db, {
      eventId: fakeSrcEventE,
      entityKind: "epic",
      entityId: otherEpicId,
      fieldName: "title",
      oursValue: '"ours-epic-e"',
      theirsValue: '"theirs-epic-e"',
    });

    expect(countConflicts(db)).toBe(2);

    insertEvent(db, {
      entityKind: "epic",
      entityId: epicId,
      operation: "epic.deleted",
      branch: MAIN,
      payload: {},
      createdAt: Date.now() + 1000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    const storage2 = openTrekoonDatabase(workspace);
    const db2 = storage2.db;

    expect(db2.query("SELECT id FROM epics WHERE id = ? LIMIT 1;").get(epicId)).toBeNull();
    expect(conflictExists(db2, conflictDeletedEpic)).toBe(false);
    expect(conflictExists(db2, conflictOtherEpic)).toBe(true);

    storage2.close();
  });
});

// ---------------------------------------------------------------------------
// Cascaded epic-delete: source_event_id stamping suppresses N+1 task conflicts
// ---------------------------------------------------------------------------

describe("cascaded epic.deleted: peer with edited tasks sees ONE conflict, not N+1", (): void => {
  test("task.deleted events stamped with source_event_id are withheld behind the epic __delete__ conflict", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskAId = randomUUID();
    const taskBId = randomUUID();
    const taskCId = randomUUID();

    insertEpic(db, epicId, "Epic A");
    insertTask(db, taskAId, epicId, "Task A");
    insertTask(db, taskBId, epicId, "Task B");
    insertTask(db, taskCId, epicId, "Task C");

    // Peer worktree (feature/x) has local edits on the epic AND each of the
    // three tasks. Without the source_event_id fix, each cascaded task.deleted
    // event would generate its own __delete__ conflict on top of the epic-
    // level conflict (4 total). The fix stamps source_event_id on cascaded
    // task.deleted rows so they get withheld behind the epic conflict.
    const baseTs = Date.now();
    insertEvent(db, {
      entityKind: "epic",
      entityId: epicId,
      operation: "epic.updated",
      branch: FEATURE,
      payload: { title: "Epic A (peer edit)" },
      createdAt: baseTs,
    });
    for (const tid of [taskAId, taskBId, taskCId]) {
      insertEvent(db, {
        entityKind: "task",
        entityId: tid,
        operation: "task.updated",
        branch: FEATURE,
        payload: { title: "Task (peer edit)" },
        createdAt: baseTs,
      });
    }

    // Main-side delete cascade. The epic.deleted event id is referenced by
    // every task.deleted via source_event_id, mirroring what
    // MutationService.deleteEpic emits.
    const epicDeleteEventId = randomUUID();
    db.query(
      `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
       VALUES (?, 'epic', ?, 'epic.deleted', ?, ?, NULL, ?, ?, 1);`,
    ).run(
      epicDeleteEventId,
      epicId,
      JSON.stringify({ fields: {} }),
      MAIN,
      baseTs + 1000,
      baseTs + 1000,
    );

    for (const tid of [taskAId, taskBId, taskCId]) {
      insertEvent(db, {
        entityKind: "task",
        entityId: tid,
        operation: "task.deleted",
        branch: MAIN,
        payload: { source_event_id: epicDeleteEventId },
        createdAt: baseTs + 1001,
      });
    }

    storage.close();

    syncPull(workspace, MAIN);

    const storage2 = openTrekoonDatabase(workspace);
    const db2 = storage2.db;

    // Exactly one __delete__ conflict — on the epic. The cascaded task.deleted
    // events were withheld by shouldWithholdDeleteCascadeEvent because their
    // source_event_id matches the pending epic-level __delete__ conflict.
    const deleteConflicts = db2
      .query(
        `SELECT entity_kind, entity_id FROM sync_conflicts
         WHERE field_name = '__delete__' AND resolution = 'pending';`,
      )
      .all() as Array<{ entity_kind: string; entity_id: string }>;

    expect(deleteConflicts.length).toBe(1);
    expect(deleteConflicts[0]?.entity_kind).toBe("epic");
    expect(deleteConflicts[0]?.entity_id).toBe(epicId);

    storage2.close();
  });
});

// ---------------------------------------------------------------------------
// Resolve flow: list/show/resolve after delete must not hit row_not_found
// ---------------------------------------------------------------------------

describe("resolve flow is clean after subtree delete", (): void => {
  test("listSyncConflicts returns no conflicts for deleted subtree, only unrelated ones", (): void => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();
    const subtaskId = randomUUID();
    const unrelatedEpicId = randomUUID();

    insertEpic(db, epicId, "Epic F");
    insertTask(db, taskId, epicId, "Task F1");
    insertSubtask(db, subtaskId, taskId, "Sub F1a");
    insertEpic(db, unrelatedEpicId, "Epic G (unrelated)");

    const conflictOnSubtask = insertConflict(db, {
      eventId: randomUUID(),
      entityKind: "subtask",
      entityId: subtaskId,
      fieldName: "title",
      oursValue: '"ours-sub"',
      theirsValue: '"theirs-sub"',
    });

    const conflictOnUnrelated = insertConflict(db, {
      eventId: randomUUID(),
      entityKind: "epic",
      entityId: unrelatedEpicId,
      fieldName: "title",
      oursValue: '"ours-epic"',
      theirsValue: '"theirs-epic"',
    });

    // Pull a task.deleted event to cascade-delete the task + subtask
    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      operation: "task.deleted",
      branch: MAIN,
      payload: {},
      createdAt: Date.now() + 1000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    // List pending conflicts — must not contain the deleted subtask's conflict
    const pending = listSyncConflicts(workspace, "pending");
    const pendingIds = pending.map((c) => c.id);

    expect(pendingIds).not.toContain(conflictOnSubtask);
    expect(pendingIds).toContain(conflictOnUnrelated);
    expect(pendingIds.length).toBe(1);
  });
});
