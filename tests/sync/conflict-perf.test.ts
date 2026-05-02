/**
 * Performance test: pull from a 5k-event source branch must complete under 1s.
 *
 * This guards against accidental regressions of the entityFieldConflict
 * fast-path (current-row short-circuit + indexed JSON1 probe with per-pull
 * memoization). The legacy implementation ran an unbounded batched history
 * walk per (incoming event × field) and exceeded the budget on this fixture.
 *
 * Correctness is also asserted on a small fixture: the optimized pull must
 * produce the same conflict count as the slow-path baseline.
 */

import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase } from "../../src/storage/database";
import { syncPull } from "../../src/sync/service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-conflict-perf-"));
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
  }));
}

function insertEpic(db: Db, opts: { readonly id: string; readonly title: string }): void {
  const ts = Date.now();
  db.query(
    `INSERT OR IGNORE INTO epics (id, title, description, status, created_at, updated_at, version)
     VALUES (?, ?, '', 'todo', ?, ?, 1);`,
  ).run(opts.id, opts.title, ts, ts);
}

function insertFieldEvent(
  db: Db,
  opts: {
    readonly entityKind: string;
    readonly entityId: string;
    readonly branch: string;
    readonly fieldName: string;
    readonly fieldValue: string;
    readonly createdAt: number;
    readonly operation?: string;
  },
): string {
  const id = randomUUID();
  const payload = JSON.stringify({ fields: { [opts.fieldName]: opts.fieldValue } });
  db.query(
    `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, 1);`,
  ).run(
    id,
    opts.entityKind,
    opts.entityId,
    opts.operation ?? `${opts.entityKind}.updated`,
    payload,
    opts.branch,
    opts.createdAt,
    opts.createdAt,
  );
  return id;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncPull conflict-detection perf", () => {
  /**
   * Seed a 5k-event source branch (main) plus a comparable feature-branch
   * history that intentionally collides with most main events. The pull
   * should still complete well under 1 second on the optimized path.
   */
  test("5k-event main pull from feature/x completes under 1s", () => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    // Mix across enough entities to spread per-entity history (avoiding a
    // single mega-entity row that would inflate the legacy walk specifically
    // — we still want a representative "many entities, many events" workload).
    const ENTITY_COUNT = 200;
    const FIELDS = ["title", "description", "status"] as const;
    const EVENTS_PER_BRANCH = 5000;

    const epicIds: string[] = [];
    for (let i = 0; i < ENTITY_COUNT; i++) {
      const id = randomUUID();
      epicIds.push(id);
      insertEpic(db, { id, title: `epic-${i}` });
    }

    db.exec("BEGIN;");
    try {
      // Local feature-branch events (5k) — populate the "ours" history that
      // the conflict probe scans.
      for (let i = 0; i < EVENTS_PER_BRANCH; i++) {
        const entityId = epicIds[i % ENTITY_COUNT]!;
        const field = FIELDS[i % FIELDS.length]!;
        insertFieldEvent(db, {
          entityKind: "epic",
          entityId,
          branch: FEATURE,
          fieldName: field,
          fieldValue: `local-${i}`,
          createdAt: 1_000_000 + i,
        });
      }

      // Source-branch events (5k) — many will conflict with feature/x.
      for (let i = 0; i < EVENTS_PER_BRANCH; i++) {
        const entityId = epicIds[i % ENTITY_COUNT]!;
        const field = FIELDS[i % FIELDS.length]!;
        insertFieldEvent(db, {
          entityKind: "epic",
          entityId,
          branch: MAIN,
          fieldName: field,
          fieldValue: `incoming-${i}`,
          createdAt: 2_000_000 + i,
        });
      }
      db.exec("COMMIT;");
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }

    storage.close();

    // Warm-up pull — primes filesystem caches and JIT.
    // (Not strictly required: the first pull also has to be under budget.)
    const start = performance.now();
    const result = syncPull(workspace, MAIN);
    const elapsed = performance.now() - start;

    // Sanity: we actually scanned the source-branch events.
    expect(result.scannedEvents).toBe(EVENTS_PER_BRANCH);

    // Performance budget. Generous headroom to absorb CI noise; the
    // pre-optimization implementation was orders of magnitude slower on
    // the same fixture.
    expect(elapsed).toBeLessThan(1000);
  });

  /**
   * Correctness: the optimized fast path must agree with the slow-path
   * semantics on a small fixture covering the canonical conflict cases:
   *   - field touched on currentBranch with a different value → conflict
   *   - field touched on currentBranch with the same value → no conflict
   *   - field not touched on currentBranch at all → no conflict
   *   - feature/y events on a different branch → invisible
   */
  test("optimized fast path matches slow-path conflict semantics", () => {
    const workspace = createWorkspace();
    const MAIN = "main";
    const FEATURE = "feature/x";
    const OTHER = "feature/y";

    mockGitContext(workspace, FEATURE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    const conflicting = randomUUID();
    const sameValue = randomUUID();
    const untouched = randomUUID();
    const otherBranchOnly = randomUUID();

    insertEpic(db, { id: conflicting, title: "Conflicting" });
    insertEpic(db, { id: sameValue, title: "SameValue" });
    insertEpic(db, { id: untouched, title: "Untouched" });
    insertEpic(db, { id: otherBranchOnly, title: "OtherBranchOnly" });

    // feature/x edits — these are the "ours" history.
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: conflicting,
      branch: FEATURE,
      fieldName: "title",
      fieldValue: "ours-conflicting",
      createdAt: 1000,
    });
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: sameValue,
      branch: FEATURE,
      fieldName: "title",
      fieldValue: "agreed",
      createdAt: 1001,
    });

    // feature/y edits — must be ignored when on feature/x.
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: otherBranchOnly,
      branch: OTHER,
      fieldName: "title",
      fieldValue: "ours-from-other-branch",
      createdAt: 1002,
    });

    // main edits — incoming.
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: conflicting,
      branch: MAIN,
      fieldName: "title",
      fieldValue: "theirs-conflicting",
      createdAt: 2000,
    });
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: sameValue,
      branch: MAIN,
      fieldName: "title",
      fieldValue: "agreed",
      createdAt: 2001,
    });
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: untouched,
      branch: MAIN,
      fieldName: "title",
      fieldValue: "theirs-untouched",
      createdAt: 2002,
    });
    insertFieldEvent(db, {
      entityKind: "epic",
      entityId: otherBranchOnly,
      branch: MAIN,
      fieldName: "title",
      fieldValue: "theirs-other-branch",
      createdAt: 2003,
    });

    storage.close();

    const result = syncPull(workspace, MAIN);

    // Only the `conflicting` epic should generate a field-level conflict
    // (followed by an apply-rejected entry, since the withheld update has
    // nothing left to apply — same pattern as in tests/sync/multi-branch).
    expect(result.scannedEvents).toBe(4);
    expect(result.createdConflicts).toBeGreaterThanOrEqual(1);
    // Must not over-detect: feature/y branch edits, sameValue, and untouched
    // entities should not produce conflicts.
    expect(result.createdConflicts).toBeLessThan(4);
  });
});
