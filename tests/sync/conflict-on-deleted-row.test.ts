/**
 * Regression: conflict short-circuit must NOT mask conflicts when the local
 * entity row was deleted on the current branch.
 *
 * Bug: `entityFieldConflict` short-circuited via
 *   `serializeValue(currentEntityFieldValue(...)) === theirsValue`.
 * For a locally-deleted row `currentEntityFieldValue` returns `undefined`,
 * which `serializeValue` maps to `null`. An incoming non-delete event with a
 * `null` field would then falsely match and skip the history walk, hiding
 * the real local-delete vs. incoming-update conflict.
 *
 * Acceptance: incoming non-delete event with a null field, on a row that was
 * deleted locally, falls through to the history walk so the conflict is
 * recorded.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { listSyncConflicts, syncPull } from "../../src/sync/service";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-conflict-deleted-row-"));
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

function mockGitContext(workspace: string, branchName: string): void {
  mock.module("../../src/sync/git-context", () => ({
    resolveGitContext: () => ({
      worktreePath: workspace,
      branchName,
      headSha: null,
      persistedAt: Date.now(),
    }),
    persistGitContext: () => undefined,
    clearGitContextCache: () => undefined,
    gitContextCacheSize: () => 0,
  }));
}

function insertEvent(
  db: Db,
  opts: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly branch: string;
    readonly operation: string;
    readonly fields: Record<string, unknown>;
    readonly createdAt: number;
  },
): string {
  const id = randomUUID();
  const payload = JSON.stringify({ fields: opts.fields });
  db.query(
    `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1);`,
  ).run(id, opts.entityKind, opts.entityId, opts.operation, payload, opts.branch, opts.createdAt, opts.createdAt);
  return id;
}

describe("entityFieldConflict — locally-deleted row", () => {
  test("incoming non-delete with null field on locally-deleted task creates conflict", () => {
    const workspace = createWorkspace();
    const FEATURE = "feature/x";
    const MAIN = "main";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();

    // Seed shared epic on both branches so the task has a parent.
    db.query(
      `INSERT INTO epics (id, title, description, status, created_at, updated_at, version)
       VALUES (?, 'epic', '', 'todo', 1000, 1000, 1);`,
    ).run(epicId);

    // Local feature-branch history: task was created with owner='alice',
    // then locally deleted. Live row is gone (currentEntityFieldValue returns undefined).
    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      branch: FEATURE,
      operation: "task.created",
      fields: { epic_id: epicId, title: "task", description: "", status: "todo", owner: "alice" },
      createdAt: 2000,
    });
    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      branch: FEATURE,
      operation: "task.deleted",
      fields: {},
      createdAt: 3000,
    });

    // Source-branch event on main: same task updated to owner=null (a real
    // null field value). Without the fix, serializeValue(undefined) = "null"
    // === serializeValue(null) = "null" → short-circuit → no conflict.
    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      branch: MAIN,
      operation: "task.updated",
      fields: { owner: null },
      createdAt: 4000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    const conflicts = listSyncConflicts(workspace, "pending");
    const ownerConflicts = conflicts.filter((c) => c.entity_id === taskId && c.field_name === "owner");
    expect(ownerConflicts.length).toBeGreaterThanOrEqual(1);
    expect(ownerConflicts[0]?.theirs_value).toBe("null");
    // Ours = "alice" (most recent local field touch on owner).
    expect(ownerConflicts[0]?.ours_value).toBe(JSON.stringify("alice"));
  });

  test("incoming non-null field on locally-deleted row still creates conflict", () => {
    // Sanity check: deleted local row + incoming non-null field also produces
    // a conflict (would have been caught by the legacy walk anyway, but the
    // new short-circuit guard must not regress this path).
    const workspace = createWorkspace();
    const FEATURE = "feature/x";
    const MAIN = "main";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const epicId = randomUUID();
    const taskId = randomUUID();

    db.query(
      `INSERT INTO epics (id, title, description, status, created_at, updated_at, version)
       VALUES (?, 'epic', '', 'todo', 1000, 1000, 1);`,
    ).run(epicId);

    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      branch: FEATURE,
      operation: "task.created",
      fields: { epic_id: epicId, title: "task-original", description: "", status: "todo", owner: "alice" },
      createdAt: 2000,
    });
    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      branch: FEATURE,
      operation: "task.deleted",
      fields: {},
      createdAt: 3000,
    });

    insertEvent(db, {
      entityKind: "task",
      entityId: taskId,
      branch: MAIN,
      operation: "task.updated",
      fields: { title: "task-renamed-on-main" },
      createdAt: 4000,
    });

    storage.close();

    syncPull(workspace, MAIN);

    const conflicts = listSyncConflicts(workspace, "pending");
    const titleConflicts = conflicts.filter((c) => c.entity_id === taskId && c.field_name === "title");
    expect(titleConflicts.length).toBeGreaterThanOrEqual(1);
    expect(titleConflicts[0]?.theirs_value).toBe(JSON.stringify("task-renamed-on-main"));
    expect(titleConflicts[0]?.ours_value).toBe(JSON.stringify("task-original"));
  });
});
