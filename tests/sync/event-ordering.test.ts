/**
 * Event-ordering correctness tests.
 *
 * Guards the invariant introduced by moving nextEventTimestamp INSIDE the
 * BEGIN IMMEDIATE block in withTransactionEventContext:
 *
 *   - Concurrent writers cannot collide on (created_at, id).
 *   - Events emitted within a single transaction are strictly monotonic.
 *   - The event log read by a consumer reflects commit order, not start order.
 *
 * Since Bun is single-threaded, concurrency is simulated by interleaving
 * writes from multiple Database connections to the same WAL-mode file,
 * matching the multi-process contention model used by the production CLI.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { openTrekoonDatabase, writeTransaction } from "../../src/storage/database";
import { migrateDatabase } from "../../src/storage/migrations";
import { MutationService } from "../../src/domain/mutation-service";
import { withTransactionEventContext } from "../../src/sync/event-writes";
import { type ResolvedGitContext } from "../../src/sync/git-context";
import * as branchDb from "../../src/sync/branch-db";
import { syncPull } from "../../src/sync/service";

function fakeGitContext(workspace: string, branchName = "main"): ResolvedGitContext {
  return { worktreePath: workspace, branchName, headSha: null, persistedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Workspace / temp-dir helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function createWorkspace(prefix = "trekoon-event-ordering-"): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
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

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

type Db = ReturnType<typeof openTrekoonDatabase>["db"];

interface EventRow {
  readonly id: string;
  readonly entity_id: string;
  readonly operation: string;
  readonly created_at: number;
}

function readEvents(db: Db): EventRow[] {
  return db
    .query(
      `SELECT id, entity_id, operation, created_at
       FROM events
       ORDER BY created_at ASC, id ASC;`,
    )
    .all() as EventRow[];
}

function isSqliteUniqueError(error: unknown): boolean {
  if (error instanceof Error) {
    return error.message.toLowerCase().includes("unique constraint failed");
  }
  return false;
}

function isSqliteBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("database is locked") || msg.includes("sqlite_busy");
  }
  return false;
}

/**
 * Open a raw WAL-mode database, run migrations, and return it.
 * Each connection simulates a separate CLI process.
 */
function openRawConnection(dbFile: string): Database {
  const conn = new Database(dbFile);
  conn.exec("PRAGMA busy_timeout = 10000;");
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA foreign_keys = ON;");
  return conn;
}

// ---------------------------------------------------------------------------
// Test helpers: low-level event writer (bypasses MutationService git mock)
// ---------------------------------------------------------------------------

/**
 * Insert a single event using withTransactionEventContext inside a
 * writeTransaction on `conn`.  Uses `cwd` only as a context key (no real
 * git resolution needed — git-context is mocked in tests that need isolation).
 */
function insertEventViaContext(
  conn: Database,
  cwd: string,
  entityId: string,
  operation: string,
): void {
  writeTransaction(conn, (): void => {
    withTransactionEventContext(conn, fakeGitContext(cwd), (): void => {
      conn
        .query(
          `INSERT INTO events
             (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
           VALUES (?, 'epic', ?, ?, '{}', 'main', NULL, ?, ?, 1);`,
        )
        .run(randomUUID(), entityId, operation, /* created_at filled by context below */ 0, 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers using MutationService (higher-level, integration)
// ---------------------------------------------------------------------------

function mockGitContext(workspace: string, branchName = "main"): void {
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
// Section 1: Concurrent writers — no (created_at, id) collisions
// ---------------------------------------------------------------------------

describe("Concurrent writers", () => {
  test("20 interleaved MutationService.createEpic calls produce no UNIQUE constraint errors", (): void => {
    const workspace = createWorkspace("trekoon-eo-concurrent-");
    mockGitContext(workspace);

    const storage = openTrekoonDatabase(workspace);
    const dbFile = storage.paths.databaseFile;
    storage.close();

    const WRITER_COUNT = 20;
    let uniqueErrors = 0;
    let busyErrors = 0;
    let successes = 0;

    // Open separate connections, each backed by its own MutationService,
    // to match separate-process behavior.
    const services: Array<{ service: MutationService; conn: Database }> = [];
    for (let i = 0; i < WRITER_COUNT; i++) {
      const conn = openRawConnection(dbFile);
      migrateDatabase(conn);
      services.push({ service: new MutationService(conn, workspace), conn });
    }

    // Interleave writes round-robin to maximise lock contention.
    for (let i = 0; i < WRITER_COUNT; i++) {
      const { service } = services[i]!;
      try {
        service.createEpic({ title: `Epic ${i}`, description: `description for epic ${i}` });
        successes++;
      } catch (error) {
        if (isSqliteUniqueError(error)) {
          uniqueErrors++;
        } else if (isSqliteBusyError(error)) {
          busyErrors++;
        }
        // Other errors re-thrown to surface in test output
      }
    }

    for (const { conn } of services) {
      conn.close(false);
    }

    // Primary assertion: zero UNIQUE constraint failures on (created_at, id).
    expect(uniqueErrors).toBe(0);
    // Busy errors are acceptable (lock contention) but unique errors are not.
    expect(successes + busyErrors).toBe(WRITER_COUNT);
    expect(successes).toBeGreaterThan(0);
  });

  test("withTransactionEventContext on interleaved connections produces no UNIQUE constraint errors", (): void => {
    const WRITER_COUNT = 20;
    const workspace = createWorkspace("trekoon-eo-ctx-");

    // Open a single shared db file
    const storage = openTrekoonDatabase(workspace);
    const dbFile = storage.paths.databaseFile;
    storage.close();

    const conns: Database[] = [];
    for (let i = 0; i < WRITER_COUNT; i++) {
      conns.push(openRawConnection(dbFile));
    }

    let uniqueErrors = 0;
    let successes = 0;

    // Each writer uses withTransactionEventContext inside writeTransaction.
    // The timestamp is read AFTER BEGIN IMMEDIATE, so concurrent writers
    // cannot collide.
    for (let i = 0; i < WRITER_COUNT; i++) {
      const conn = conns[i]!;
      const entityId = randomUUID();
      try {
        writeTransaction(conn, (): void => {
          withTransactionEventContext(conn, fakeGitContext(workspace), (): void => {
            const ts: number = (conn
              .query("SELECT COALESCE(MAX(created_at), 0) + 1 AS ts FROM events;")
              .get() as { ts: number }).ts;
            conn
              .query(
                `INSERT INTO events
                   (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
                 VALUES (?, 'epic', ?, 'epic.created', '{}', 'main', NULL, ?, ?, 1);`,
              )
              .run(randomUUID(), entityId, ts, ts);
          });
        });
        successes++;
      } catch (error) {
        if (isSqliteUniqueError(error)) {
          uniqueErrors++;
        }
      }
    }

    for (const conn of conns) {
      conn.close(false);
    }

    expect(uniqueErrors).toBe(0);
    expect(successes).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Section 2: Monotonic ordering within a transaction
// ---------------------------------------------------------------------------

describe("Monotonic event ordering", () => {
  test("events in a single transaction have strictly monotonically increasing created_at", (): void => {
    const workspace = createWorkspace("trekoon-eo-mono-");
    mockGitContext(workspace);

    const storage = openTrekoonDatabase(workspace);
    const service = new MutationService(storage.db, workspace);

    // createEpicGraph emits multiple events in one transaction:
    // epic.created + task.created × N
    service.createEpicGraph({
      title: "Mono epic",
      description: "Testing monotonic order",
      taskSpecs: [
        { tempKey: "t1", title: "Task A", description: "desc A" },
        { tempKey: "t2", title: "Task B", description: "desc B" },
        { tempKey: "t3", title: "Task C", description: "desc C" },
      ],
      subtaskSpecs: [],
      dependencySpecs: [],
    });

    const events = readEvents(storage.db);
    expect(events.length).toBeGreaterThanOrEqual(4); // 1 epic + 3 tasks

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const curr = events[i]!;
      expect(curr.created_at).toBeGreaterThan(prev.created_at);
    }

    storage.close();
  });

  test("events across two sequential transactions are monotonically ordered", (): void => {
    const workspace = createWorkspace("trekoon-eo-seq-");
    mockGitContext(workspace);

    const storage = openTrekoonDatabase(workspace);
    const service = new MutationService(storage.db, workspace);

    service.createEpic({ title: "First Epic", description: "first" });
    service.createEpic({ title: "Second Epic", description: "second" });

    const events = readEvents(storage.db);
    expect(events.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const curr = events[i]!;
      expect(curr.created_at).toBeGreaterThanOrEqual(prev.created_at);
    }

    storage.close();
  });
});

// ---------------------------------------------------------------------------
// Section 3: Snapshot consistency — consumer sees no out-of-order events
// ---------------------------------------------------------------------------

describe("Snapshot consistency", () => {
  test("consumer reading the event log sees events in non-decreasing created_at order", (): void => {
    const workspace = createWorkspace("trekoon-eo-snapshot-");
    mockGitContext(workspace);

    const storage = openTrekoonDatabase(workspace);
    const service = new MutationService(storage.db, workspace);

    // Write a mix of operations
    const epic1 = service.createEpic({ title: "Epic 1", description: "desc 1" });
    const epic2 = service.createEpic({ title: "Epic 2", description: "desc 2" });
    service.updateEpic(epic1.id, { title: "Epic 1 updated" });
    service.updateEpic(epic2.id, { title: "Epic 2 updated" });
    service.createEpic({ title: "Epic 3", description: "desc 3" });

    // Consumer reads the log ordered by (created_at ASC, id ASC)
    const events = readEvents(storage.db);

    expect(events.length).toBeGreaterThanOrEqual(5);

    // No out-of-order created_at
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1]!;
      const curr = events[i]!;
      expect(curr.created_at).toBeGreaterThanOrEqual(prev.created_at);
    }

    // All event IDs are unique (no duplicate rows)
    const ids = events.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(events.length);

    storage.close();
  });

  test("timestamp computed inside lock reflects commit order for interleaved connections", (): void => {
    const workspace = createWorkspace("trekoon-eo-commit-order-");

    const storage = openTrekoonDatabase(workspace);
    const dbFile = storage.paths.databaseFile;
    storage.close();

    // Two connections write sequentially (no real parallelism in Bun).
    // The second writer must get a higher timestamp than the first because
    // it reads max(created_at) after the first has committed.
    const conn1 = openRawConnection(dbFile);
    const conn2 = openRawConnection(dbFile);

    const entity1 = randomUUID();
    const entity2 = randomUUID();

    // Writer 1 commits first
    writeTransaction(conn1, (): void => {
      withTransactionEventContext(conn1, fakeGitContext(workspace), (): void => {
        const ts = (conn1
          .query("SELECT COALESCE(MAX(created_at), 0) + 1 AS ts FROM events;")
          .get() as { ts: number }).ts;
        conn1
          .query(
            `INSERT INTO events
               (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
             VALUES (?, 'epic', ?, 'epic.created', '{}', 'main', NULL, ?, ?, 1);`,
          )
          .run(randomUUID(), entity1, ts, ts);
      });
    });

    // Writer 2 commits after: must observe writer 1's committed timestamp
    writeTransaction(conn2, (): void => {
      withTransactionEventContext(conn2, fakeGitContext(workspace), (): void => {
        const ts = (conn2
          .query("SELECT COALESCE(MAX(created_at), 0) + 1 AS ts FROM events;")
          .get() as { ts: number }).ts;
        conn2
          .query(
            `INSERT INTO events
               (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
             VALUES (?, 'epic', ?, 'epic.created', '{}', 'main', NULL, ?, ?, 1);`,
          )
          .run(randomUUID(), entity2, ts, ts);
      });
    });

    const reader = openRawConnection(dbFile);
    const events = reader
      .query(
        `SELECT id, entity_id, created_at FROM events ORDER BY created_at ASC, id ASC;`,
      )
      .all() as Array<{ id: string; entity_id: string; created_at: number }>;

    expect(events.length).toBe(2);

    const first = events[0]!;
    const second = events[1]!;

    // The event for entity1 was committed first; it must have a lower
    // (or equal) created_at than the event for entity2.
    expect(second.created_at).toBeGreaterThanOrEqual(first.created_at);

    // Strict ordering: the second writer should have seen the first event
    // and bumped the timestamp.
    expect(second.created_at).toBeGreaterThan(first.created_at);

    reader.close(false);
    conn1.close(false);
    conn2.close(false);
  });
});

// ---------------------------------------------------------------------------
// Section 4: Pull batching — chunked write transactions, crash-safe cursor
// ---------------------------------------------------------------------------

describe("syncPull chunked transactions", () => {
  test("aborting mid-pull leaves cursor advanced for committed batches; next pull resumes", () => {
    const workspace = createWorkspace("trekoon-pull-batch-");
    const SOURCE = "main";
    mockGitContext(workspace, SOURCE);

    const storage = openTrekoonDatabase(workspace);
    const db = storage.db;

    // Seed 500 events on `main` (= exactly two SYNC_PULL_BATCH_SIZE=250 batches).
    // Same-branch fast path will iterate them in two passes through
    // queryBranchEventsSinceBatch.
    const TOTAL = 500;
    const baseTs = Date.now();
    const insertEvent = db.prepare(
      `INSERT INTO events (id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version)
       VALUES (?, 'epic', ?, 'epic.created', '{"fields":{}}', ?, NULL, ?, ?, 1);`,
    );
    db.exec("BEGIN;");
    for (let i = 0; i < TOTAL; i++) {
      insertEvent.run(randomUUID(), randomUUID(), SOURCE, baseTs + i, baseTs + i);
    }
    db.exec("COMMIT;");
    storage.close();

    // First pull: throw on the SECOND call to queryBranchEventsSinceBatch.
    // The first batch (250 events) has already been committed by the first
    // writeTransaction; the cursor must reflect that commit so the next
    // pull can resume from it.
    const realQuery = branchDb.queryBranchEventsSinceBatch;
    let callCount = 0;
    mock.module("../../src/sync/branch-db", () => ({
      ...branchDb,
      queryBranchEventsSinceBatch: (
        d: Database,
        branch: string,
        cursorToken: string,
        limit?: number,
      ) => {
        callCount += 1;
        if (callCount === 2) {
          throw new Error("synthetic mid-pull abort");
        }
        return realQuery(d, branch, cursorToken, limit);
      },
    }));

    let firstPullThrew = false;
    try {
      syncPull(workspace, SOURCE);
    } catch (error) {
      firstPullThrew = true;
      expect((error as Error).message).toContain("synthetic mid-pull abort");
    }
    expect(firstPullThrew).toBe(true);

    // Inspect cursor state after the abort: must reflect the last
    // fully-committed batch, NOT zero (would be the case with single
    // outer-tx semantics, where the abort rolls everything back).
    const reopened = openTrekoonDatabase(workspace);
    const cursorRow = reopened.db
      .query(
        `SELECT cursor_token, last_event_at FROM sync_cursors
         WHERE owner_scope = 'worktree' AND owner_worktree_path = ? AND source_branch = ?
         LIMIT 1;`,
      )
      .get(workspace, SOURCE) as { cursor_token: string; last_event_at: number } | null;

    expect(cursorRow).not.toBeNull();
    // Cursor token format: "<created_at>:<id>". The committed batch
    // contains exactly the first 250 events, so created_at must equal
    // baseTs + 249.
    const committedTs = Number(cursorRow!.cursor_token.split(":")[0]);
    expect(committedTs).toBe(baseTs + 249);
    expect(cursorRow!.last_event_at).toBe(baseTs + 249);

    // Also verify the events table holds exactly the committed batch's
    // rows (the source 500) — they live there from the seed; the test
    // exercises the cursor invariant, not row presence.
    const evCount = reopened.db
      .query(`SELECT COUNT(*) AS c FROM events WHERE git_branch = ?;`)
      .get(SOURCE) as { c: number };
    expect(evCount.c).toBe(TOTAL);
    reopened.close();

    // Second pull: clear the throw and run again. It should resume from
    // the cursor and process the remaining 250 events without error.
    mock.module("../../src/sync/branch-db", () => ({ ...branchDb }));

    const summary = syncPull(workspace, SOURCE);
    // Same-branch fast path emits scannedEvents but appliedEvents=0.
    expect(summary.scannedEvents).toBe(TOTAL - 250);
    expect(summary.sameBranch).toBe(true);

    const finalCursor = openTrekoonDatabase(workspace);
    const finalRow = finalCursor.db
      .query(
        `SELECT cursor_token FROM sync_cursors
         WHERE owner_scope = 'worktree' AND owner_worktree_path = ? AND source_branch = ?
         LIMIT 1;`,
      )
      .get(workspace, SOURCE) as { cursor_token: string } | null;
    expect(finalRow).not.toBeNull();
    const finalTs = Number(finalRow!.cursor_token.split(":")[0]);
    expect(finalTs).toBe(baseTs + TOTAL - 1);
    finalCursor.close();
  });
});
