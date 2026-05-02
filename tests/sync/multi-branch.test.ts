/**
 * Tests that the "ours" event scan in syncPull is pinned to the current branch,
 * not to "anything that isn't the source branch". A pull from `main` while on
 * `feature/x` must not treat `feature/y` events as local ("ours") edits.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { syncPull } from "../../src/sync/service";

// ---------------------------------------------------------------------------
// Workspace helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-multi-branch-"));
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
// Event insertion helpers
// ---------------------------------------------------------------------------

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

function insertEpic(db: Db, opts: { readonly id: string; readonly title: string }): void {
  const ts = Date.now();
  db.query(
    `INSERT OR IGNORE INTO epics (id, title, description, status, created_at, updated_at, version)
     VALUES (?, ?, '', 'todo', ?, ?, 1);`,
  ).run(opts.id, opts.title, ts, ts);
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
    persistGitContext: () => undefined,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ours-branch isolation in syncPull", () => {
  /**
   * Key isolation test: when on feature/x, an edit that exists ONLY on
   * feature/y must NOT be treated as a local conflict. With the old
   * `git_branch != sourceBranch` predicate the feature/y edit would have
   * been returned as "ours", producing a spurious conflict. With the fixed
   * `git_branch = currentBranch` predicate it is invisible.
   */
  describe("feature/x pulling from main — feature/y edit is invisible", () => {
    test("no conflict when the only local edit is on feature/y and we are on feature/x", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";
      const FEATURE_Y = "feature/y";

      const epicId = randomUUID();

      mockGitContext(workspace, FEATURE_X);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Alpha" });

      // ONLY feature/y edited title — feature/x has NO local edits
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_Y,
        fieldName: "title",
        fieldValue: "Title from feature/y",
        createdAt: 1000,
      });

      // main also edited title — conflicts with feature/y but NOT with feature/x
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: MAIN,
        fieldName: "title",
        fieldValue: "Title from main",
        createdAt: 2000,
      });

      storage.close();

      // On feature/x, pulling from main
      const result = syncPull(workspace, MAIN);

      // feature/y edit must not appear as a conflict — we are on feature/x
      expect(result.createdConflicts).toBe(0);
      expect(result.sameBranch).toBe(false);
    });

    test("conflict IS detected when the edit is on feature/x and we are on feature/x", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";

      const epicId = randomUUID();

      mockGitContext(workspace, FEATURE_X);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Beta" });

      // feature/x edited title
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "Title from feature/x",
        createdAt: 1000,
      });

      // main also edited title — conflicts with feature/x
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: MAIN,
        fieldName: "title",
        fieldValue: "Title from main",
        createdAt: 2000,
      });

      storage.close();

      const result = syncPull(workspace, MAIN);

      // The field conflict is detected (1), plus the apply-rejected follow-up (1)
      // because the withheld-field update has nothing to apply.
      expect(result.createdConflicts).toBeGreaterThanOrEqual(1);
      expect(result.sameBranch).toBe(false);
    });
  });

  /**
   * Mirror test: on feature/y, feature/x edits are invisible.
   */
  describe("feature/y pulling from main — feature/x edit is invisible", () => {
    test("no conflict when the only local edit is on feature/x and we are on feature/y", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";
      const FEATURE_Y = "feature/y";

      const epicId = randomUUID();

      mockGitContext(workspace, FEATURE_Y);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Gamma" });

      // ONLY feature/x edited title — feature/y has NO local edits
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "Title from feature/x",
        createdAt: 1000,
      });

      // main also edited title
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epicId,
        branch: MAIN,
        fieldName: "title",
        fieldValue: "Title from main",
        createdAt: 2000,
      });

      storage.close();

      // On feature/y, pulling from main
      const result = syncPull(workspace, MAIN);

      // feature/x edit must not appear as a conflict — we are on feature/y
      expect(result.createdConflicts).toBe(0);
      expect(result.sameBranch).toBe(false);
    });
  });

  /**
   * Three-branch setup: main, feature/x, feature/y.
   * On feature/x: only feature/x edits count as ours.
   */
  describe("three-branch isolation", () => {
    test("feature/y edits are invisible when on feature/x; feature/x edits create conflicts", () => {
      const workspace = createWorkspace();
      const MAIN = "main";
      const FEATURE_X = "feature/x";
      const FEATURE_Y = "feature/y";

      const epic1Id = randomUUID(); // feature/x edits this → conflict expected
      const epic2Id = randomUUID(); // only feature/y edits this → NO conflict

      mockGitContext(workspace, FEATURE_X);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epic1Id, title: "Epsilon" });
      insertEpic(db, { id: epic2Id, title: "Zeta" });

      // epic1: feature/x edits title
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epic1Id,
        branch: FEATURE_X,
        fieldName: "title",
        fieldValue: "epic1 from feature/x",
        createdAt: 1000,
      });

      // epic2: only feature/y edits title (invisible when on feature/x)
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epic2Id,
        branch: FEATURE_Y,
        fieldName: "title",
        fieldValue: "epic2 from feature/y",
        createdAt: 1000,
      });

      // main edits both epics
      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epic1Id,
        branch: MAIN,
        fieldName: "title",
        fieldValue: "epic1 from main",
        createdAt: 2000,
      });

      insertFieldEvent(db, {
        entityKind: "epic",
        entityId: epic2Id,
        branch: MAIN,
        fieldName: "title",
        fieldValue: "epic2 from main",
        createdAt: 2000,
      });

      storage.close();

      const result = syncPull(workspace, MAIN);

      // Only epic1 generates conflict(s) (feature/x vs main).
      // epic2 has no feature/x edit, so NO conflict for it.
      // epic1 field conflict + apply-rejected = ≥1 conflicts; epic2 = 0.
      // Total must be >= 1 (for epic1) and epic2 must not add any.
      // The two main events are 2 scanned events:
      expect(result.scannedEvents).toBe(2);
      // epic2 main event is cleanly applied (no conflict)
      expect(result.appliedEvents).toBeGreaterThanOrEqual(1);
      // Conflicts are ONLY from epic1
      expect(result.createdConflicts).toBeGreaterThanOrEqual(1);

      // Verify isolation: if feature/y events were treated as ours,
      // both epics would conflict (2× field + 2× apply-rejected = 4 total).
      // With the fix, only epic1 conflicts.
      expect(result.createdConflicts).toBeLessThan(4);
      expect(result.sameBranch).toBe(false);
    });
  });

  /**
   * Same-branch fast path: on main pulling main → no conflict detection,
   * zero conflicts, sameBranch=true.
   */
  describe("same-branch sync (on main pulling main)", () => {
    test("same-branch fast path returns sameBranch=true and zero conflicts", () => {
      const workspace = createWorkspace();
      const MAIN = "main";

      const epicId = randomUUID();

      mockGitContext(workspace, MAIN);

      const storage = openTrekoonDatabase(workspace);
      const db = storage.db;

      insertEpic(db, { id: epicId, title: "Delta" });

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

      expect(result.sameBranch).toBe(true);
      expect(result.createdConflicts).toBe(0);
    });
  });
});
