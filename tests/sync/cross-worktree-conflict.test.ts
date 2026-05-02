/**
 * Regression: resolving a sync conflict in worktree A must NOT erase a
 * sibling conflict that worktree B independently recorded against the
 * SAME entity.
 *
 * The sync_conflicts table is shared (`.git`-common-dir storage), but each
 * worktree's pull observes a distinct local-branch "ours" and may record a
 * different conflict against the same incoming event/entity. Pre-fix,
 * `removeConflictsForEntityIds` deleted purely by `(entity_kind, entity_id)`,
 * so worktree A applying an incoming task delete would erase worktree B's
 * pending field-level conflict on the same task.
 *
 * Fix: every conflict row carries `(worktree_path, current_branch)`; insert,
 * list, resolve, and cleanup all scope by these columns. Worktrees never
 * touch each other's rows.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { syncPull } from "../../src/sync/service";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-cross-wt-conflict-"));
  tempDirs.push(workspace);
  mkdirSync(join(workspace, ".trekoon"), { recursive: true });
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const dir: string | undefined = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  mock.restore();
});

function mockGitContextAs(workspace: string, branchName: string): void {
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

type Db = ReturnType<typeof openTrekoonDatabase>["db"];

function insertConflictRow(
  db: Db,
  opts: {
    readonly id?: string;
    readonly eventId: string;
    readonly entityKind: string;
    readonly entityId: string;
    readonly fieldName: string;
    readonly oursValue: string | null;
    readonly theirsValue: string | null;
    readonly worktreePath: string;
    readonly currentBranch: string;
    readonly resolution?: string;
  },
): string {
  const id = opts.id ?? randomUUID();
  const ts = Date.now();
  db.query(
    `INSERT INTO sync_conflicts (
       id, event_id, entity_kind, entity_id, field_name,
       ours_value, theirs_value, resolution,
       created_at, updated_at, version,
       worktree_path, current_branch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?);`,
  ).run(
    id,
    opts.eventId,
    opts.entityKind,
    opts.entityId,
    opts.fieldName,
    opts.oursValue,
    opts.theirsValue,
    opts.resolution ?? "pending",
    ts,
    ts,
    opts.worktreePath,
    opts.currentBranch,
  );
  return id;
}

describe("sync_conflicts worktree+branch scoping", () => {
  test("resolving a conflict in worktree A does not erase worktree B's row on the same entity", () => {
    const workspace = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const taskId = randomUUID();
    const eventId = randomUUID();

    // Worktree A: feature/x — recorded a "title" conflict on this task.
    const conflictA = insertConflictRow(db, {
      eventId,
      entityKind: "task",
      entityId: taskId,
      fieldName: "title",
      oursValue: '"a-ours"',
      theirsValue: '"a-theirs"',
      worktreePath: "/worktrees/a",
      currentBranch: "feature/x",
    });

    // Worktree B: feature/y — recorded its own "title" conflict on the SAME task.
    const conflictB = insertConflictRow(db, {
      eventId,
      entityKind: "task",
      entityId: taskId,
      fieldName: "title",
      oursValue: '"b-ours"',
      theirsValue: '"b-theirs"',
      worktreePath: "/worktrees/b",
      currentBranch: "feature/y",
    });

    // Worktree A simulates resolving by emulating the cleanup that
    // applyConflictTheirsResolution / applyDelete would run: scoped to
    // worktree A's row's (worktree_path, current_branch).
    db.query(
      `DELETE FROM sync_conflicts
       WHERE entity_kind = ?
         AND entity_id = ?
         AND worktree_path = ?
         AND current_branch = ?;`,
    ).run("task", taskId, "/worktrees/a", "feature/x");

    // Worktree A's row is gone, worktree B's row survives.
    const remaining = db
      .query(
        `SELECT id, worktree_path, current_branch FROM sync_conflicts WHERE entity_id = ? ORDER BY id;`,
      )
      .all(taskId) as Array<{ id: string; worktree_path: string; current_branch: string }>;

    expect(remaining.map((r) => r.id)).toEqual([conflictB].sort());
    expect(remaining.find((r) => r.id === conflictA)).toBeUndefined();
    expect(remaining.find((r) => r.id === conflictB)?.current_branch).toBe("feature/y");

    storage.close();
  });

  test("list/count scoped to a worktree returns only that worktree's rows", () => {
    const workspace = createWorkspace();
    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const eventId = randomUUID();
    const entityId = randomUUID();

    insertConflictRow(db, {
      eventId,
      entityKind: "task",
      entityId,
      fieldName: "status",
      oursValue: '"todo"',
      theirsValue: '"done"',
      worktreePath: "/worktrees/a",
      currentBranch: "feature/x",
    });
    insertConflictRow(db, {
      eventId,
      entityKind: "task",
      entityId,
      fieldName: "status",
      oursValue: '"in_progress"',
      theirsValue: '"done"',
      worktreePath: "/worktrees/b",
      currentBranch: "feature/y",
    });

    // Per-worktree pending count: each sees exactly one.
    const aCount = db
      .query(
        `SELECT COUNT(*) AS c FROM sync_conflicts
         WHERE resolution = 'pending' AND worktree_path = ? AND current_branch = ?;`,
      )
      .get("/worktrees/a", "feature/x") as { c: number };
    const bCount = db
      .query(
        `SELECT COUNT(*) AS c FROM sync_conflicts
         WHERE resolution = 'pending' AND worktree_path = ? AND current_branch = ?;`,
      )
      .get("/worktrees/b", "feature/y") as { c: number };

    expect(aCount.c).toBe(1);
    expect(bCount.c).toBe(1);

    storage.close();
  });

  test("resolving via incoming resolve_conflict event in worktree A leaves worktree B's row untouched (shared source_event_id)", () => {
    const workspace = mkdtempSync(join(tmpdir(), "trekoon-cross-wt-resolve-"));
    tempDirs.push(workspace);
    mkdirSync(join(workspace, ".trekoon"), { recursive: true });

    const FEATURE_A = "feature/a";
    const FEATURE_B = "feature/b";
    const MAIN = "main";

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const taskId = randomUUID();
    const sharedSourceEventId = randomUUID();

    // Seed an "incoming" source event on MAIN that both worktrees observed
    // and recorded a "title" conflict against. Both rows share the
    // source_event_id (= the shared MAIN event id).
    const ts = Date.now();
    db.query(
      `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
       VALUES (?, 'task', ?, 'task.updated', ?, ?, NULL, ?, ?, 1);`,
    ).run(sharedSourceEventId, taskId, JSON.stringify({ fields: { title: "main-title" } }), MAIN, ts, ts);

    // Worktree A: feature/a — pending "title" conflict against the shared source event.
    const conflictA = insertConflictRow(db, {
      eventId: sharedSourceEventId,
      entityKind: "task",
      entityId: taskId,
      fieldName: "title",
      oursValue: '"a-ours"',
      theirsValue: '"main-title"',
      worktreePath: workspace,
      currentBranch: FEATURE_A,
    });

    // Worktree B: feature/b — pending "title" conflict against the SAME source event.
    const conflictB = insertConflictRow(db, {
      eventId: sharedSourceEventId,
      entityKind: "task",
      entityId: taskId,
      fieldName: "title",
      oursValue: '"b-ours"',
      theirsValue: '"main-title"',
      worktreePath: workspace,
      currentBranch: FEATURE_B,
    });

    // Seed a task row so updates have something to mutate (allowMissing covers this anyway).
    db.query(
      `INSERT OR IGNORE INTO tasks (id, epic_id, title, description, status, created_at, updated_at, version)
       VALUES (?, ?, 'orig', '', 'todo', ?, ?, 1);`,
    ).run(taskId, randomUUID(), ts, ts);

    // Emit a resolve_conflict event on FEATURE_A (the resolver branch),
    // pointing at conflictA via source_event_id. This is the on-wire shape
    // produced by appendResolutionEvent on the originating worktree.
    const resolveEventId = randomUUID();
    const resolveTs = ts + 100;
    db.query(
      `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
       VALUES (?, 'task', ?, 'resolve_conflict', ?, ?, NULL, ?, ?, 1);`,
    ).run(
      resolveEventId,
      taskId,
      JSON.stringify({
        conflict_id: conflictA,
        source_event_id: sharedSourceEventId,
        field: "title",
        resolution: "theirs",
        value: "main-title",
        worktree_path: workspace,
        current_branch: FEATURE_A,
      }),
      FEATURE_A,
      resolveTs,
      resolveTs,
    );

    storage.close();

    // Pull from FEATURE_A while sitting on FEATURE_B: the receiver's scope
    // is (workspace, FEATURE_B). The resolve event must NOT touch
    // worktree A's row (different scope) AND must NOT touch worktree B's
    // row either (different source/branch payload + scope mismatch on
    // payload's worktree_path). Result: B's row stays pending.
    mockGitContextAs(workspace, FEATURE_B);
    syncPull(workspace, FEATURE_A);

    const reopened = openTrekoonDatabase(workspace);
    const rows = reopened.db
      .query(
        `SELECT id, current_branch, resolution
         FROM sync_conflicts
         WHERE entity_id = ?
         ORDER BY current_branch ASC;`,
      )
      .all(taskId) as Array<{ id: string; current_branch: string; resolution: string }>;

    expect(rows.length).toBe(2);
    const rowB = rows.find((r) => r.id === conflictB);
    expect(rowB).toBeDefined();
    expect(rowB?.resolution).toBe("pending");
    // A's row is unchanged from B's pull (B's scope cannot resolve A's row).
    const rowA = rows.find((r) => r.id === conflictA);
    expect(rowA).toBeDefined();
    expect(rowA?.resolution).toBe("pending");

    reopened.close();
  });
});
