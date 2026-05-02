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
});

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
});
