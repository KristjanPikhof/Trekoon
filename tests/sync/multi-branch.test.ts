/**
 * Tests that the "ours" event scan in syncPull is pinned to the current branch,
 * not to "anything that isn't the source branch". A pull from `main` while on
 * `feature/x` must not treat `feature/y` events as local ("ours") edits.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { syncPull } from "../../src/sync/service";

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-multi-branch-"));
  tempDirs.push(workspace);
  // Trekoon stores the DB under <workspace>/.trekoon/
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
  // Reset mock after each test
  mock.restore();
});

type Db = ReturnType<typeof openTrekoonDatabase>["db"];

// ---------------------------------------------------------------------------
// Event insertion helpers
// ---------------------------------------------------------------------------

/**
 * Insert a field-update event for an entity on a specific branch.
 * Uses a minimal valid payload so that entityFieldConflict can parse it.
 */
function insertFieldEvent(
  db: Db,
  opts: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly branch: string;
    readonly fieldName: string;
    readonly fieldValue: string;
    readonly createdAt?: number;
  },
): string {
  const id = randomUUID();
  const payload = JSON.stringify({ fields: { [opts.fieldName]: opts.fieldValue } });
  const ts = opts.createdAt ?? Date.now();
  db.query(
    `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
     VALUES (?, ?, ?, 'epic.updated', ?, ?, NULL, ?, ?, 1);`,
  ).run(id, opts.entityKind, opts.entityId, payload, opts.branch, ts, ts);
  return id;
}

/**
 * Insert an epic row so that applyEntityFields can find the entity to update.
 */
function insertEpic(
  db: Db,
  opts: { readonly id: string; readonly title: string; readonly branch: string },
): void {
  const ts = Date.now();
  db.query(
    `INSERT OR IGNORE INTO epics (id, title, description, status, created_at, updated_at, version)
     VALUES (?, ?, '', 'todo', ?, ?, 1);`,
  ).run(opts.id, opts.title, ts, ts);
}

/**
 * Insert an event on the source branch (simulates what the remote has).
 * Returns the event id.
 */
function insertSourceBranchEvent(
  db: Db,
  opts: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly sourceBranch: string;
    readonly fieldName: string;
    readonly fieldValue: string;
    readonly createdAt?: number;
  },
): string {
  return insertFieldEvent(db, {
    entityKind: opts.entityKind,
    entityId: opts.entityId,
    branch: opts.sourceBranch,
    fieldName: opts.fieldName,
    fieldValue: opts.fieldValue,
    createdAt: opts.createdAt,
  });
}

// ---------------------------------------------------------------------------
// Mock helper: override resolveGitContext to return a given branch
// ---------------------------------------------------------------------------

function mockGitContext(workspace: string, branchName: string): void {
  mock.module("../../src/sync/git-context", () => ({
    resolveGitContext: () => ({
      worktreePath: workspace,
      branchName,
      headSha: null,
      persistedAt: Date.now(),
    }),
    persistGitContext: () => {
      // no-op: we set git_context manually when needed
    },
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ours-branch isolation in syncPull", () => {
  describe("feature/x pulling from main does not see feature/y events as conflicts", () => {
    test("edit on feature/y is not detected as a local conflict when on feature/x", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";
      const FEATURE_Y = "feature/y";

      const epicId = randomUUID();

      // Mock git context: we are on feature/x
      mockGitContext(workspace, FEATURE_X);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;
      storage.close();

      const storage2 = openTrekoonDatabase(workspace);
      const db2 = storage2.db;

      // The entity exists in the DB
      insertEpic(db2, { id: epicId, title: "Alpha", branch: FEATURE_X });

      const t1 = 1000;
      const t2 = 2000;
      const t3 = 3000;

      // feature/y made an edit to `title` (should NOT be treated as ours)
      insertFieldEvent(db2, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_Y,
        fieldName: "title",
        fieldValue: "Title from feature/y",
        createdAt: t1,
      });

      // feature/x also edited `title` (this IS ours)
      insertFieldEvent(db2, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "Title from feature/x",
        createdAt: t2,
      });

      // main (source) edited `title` to a different value — this should conflict with feature/x only
      const sourceEventId = insertSourceBranchEvent(db2, {
        entityKind: "epic",
        entityId: epicId,
        sourceBranch: MAIN,
        fieldName: "title",
        fieldValue: "Title from main",
        createdAt: t3,
      });

      storage2.close();

      // syncPull: on feature/x, pulling from main
      const result = syncPull(workspace, MAIN);

      // Should detect exactly one conflict (feature/x vs main), not two
      // (feature/y vs main should not count as a local conflict)
      expect(result.createdConflicts).toBe(1);
      expect(result.sameBranch).toBe(false);
    });

    test("edit on feature/x is correctly detected as a local conflict when on feature/x", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";

      const epicId = randomUUID();

      mockGitContext(workspace, FEATURE_X);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Beta", branch: FEATURE_X });

      const t1 = 1000;
      const t2 = 2000;

      // feature/x edited `title`
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "Title from feature/x",
        createdAt: t1,
      });

      // main (source) edited `title` to a different value
      insertSourceBranchEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        sourceBranch: MAIN,
        fieldName: "title",
        fieldValue: "Title from main",
        createdAt: t2,
      });

      storage.close();

      const result = syncPull(workspace, MAIN);

      // feature/x edit conflicts with main edit
      expect(result.createdConflicts).toBe(1);
      expect(result.sameBranch).toBe(false);
    });
  });

  describe("feature/y pulling from main does not see feature/x events as conflicts", () => {
    test("edit on feature/x is not detected as a local conflict when on feature/y", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";
      const FEATURE_Y = "feature/y";

      const epicId = randomUUID();

      // Mock git context: we are on feature/y
      mockGitContext(workspace, FEATURE_Y);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Gamma", branch: FEATURE_Y });

      const t1 = 1000;
      const t2 = 2000;
      const t3 = 3000;

      // feature/x made an edit — should NOT be "ours" when on feature/y
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "Title from feature/x",
        createdAt: t1,
      });

      // feature/y made NO edit to title (no local conflict expected)

      // main (source) edited `title`
      insertSourceBranchEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        sourceBranch: MAIN,
        fieldName: "title",
        fieldValue: "Title from main",
        createdAt: t2,
      });

      storage.close();

      const result = syncPull(workspace, MAIN);

      // feature/x edit should NOT be treated as a conflict for feature/y
      expect(result.createdConflicts).toBe(0);
      expect(result.sameBranch).toBe(false);
    });
  });

  describe("same-branch sync (on main pulling main)", () => {
    test("same-branch fast path returns sameBranch=true and zero conflicts", () => {
      const workspace = createWorkspace();
      const MAIN = "main";

      const epicId = randomUUID();

      mockGitContext(workspace, MAIN);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Delta", branch: MAIN });

      // Some events on main
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: MAIN,
        fieldName: "title",
        fieldValue: "Updated on main",
        createdAt: 1000,
      });

      storage.close();

      const result = syncPull(workspace, MAIN);

      // Same-branch fast path: no conflict detection
      expect(result.sameBranch).toBe(true);
      expect(result.createdConflicts).toBe(0);
    });
  });

  describe("three-branch isolation: main, feature/x, feature/y", () => {
    test("only current-branch events are ours; other feature-branch events are invisible to conflict detection", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";
      const FEATURE_Y = "feature/y";

      const epic1Id = randomUUID();
      const epic2Id = randomUUID();

      // We are on feature/x
      mockGitContext(workspace, FEATURE_X);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epic1Id, title: "Epsilon", branch: FEATURE_X });
      insertEpic(db, { id: epic2Id, title: "Zeta", branch: FEATURE_X });

      // epic1: feature/x edited title (conflicts with main below)
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epic1Id,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "epic1 from feature/x",
        createdAt: 1000,
      });

      // epic2: feature/y edited title (should NOT create conflict for feature/x)
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epic2Id,
        branch: FEATURE_Y,
        fieldName: "title",
        fieldValue: "epic2 from feature/y",
        createdAt: 1000,
      });

      // main edited epic1 title — conflicts with feature/x
      insertSourceBranchEvent(db, {
        entityKind: "epic",
        entityId: epic1Id,
        sourceBranch: MAIN,
        fieldName: "title",
        fieldValue: "epic1 from main",
        createdAt: 2000,
      });

      // main edited epic2 title — should NOT conflict with feature/y (we're on feature/x)
      insertSourceBranchEvent(db, {
        entityKind: "epic",
        entityId: epic2Id,
        sourceBranch: MAIN,
        fieldName: "title",
        fieldValue: "epic2 from main",
        createdAt: 2000,
      });

      storage.close();

      const result = syncPull(workspace, MAIN);

      // Only epic1 conflict (feature/x vs main). epic2 has no feature/x edit, so no conflict.
      expect(result.createdConflicts).toBe(1);
      expect(result.sameBranch).toBe(false);
    });
  });
});
