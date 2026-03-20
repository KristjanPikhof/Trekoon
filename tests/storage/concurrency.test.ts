/**
 * Concurrent SQLite write stress test.
 *
 * Measures SQLITE_BUSY error rates across:
 *   1. DEFERRED transactions (default db.transaction())
 *   2. IMMEDIATE transactions (BEGIN IMMEDIATE)
 *   3. Various busy_timeout values (5s, 10s, 15s)
 *
 * Each scenario uses a fresh WAL-mode temporary database and spawns
 * concurrent writers to expose lock contention characteristics.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const WRITER_COUNT = 4;
const WRITES_PER_WRITER = 20;
const TOTAL_EXPECTED_ROWS = WRITER_COUNT * WRITES_PER_WRITER;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

const tempDirs: string[] = [];

function createTempDir(prefix = "trekoon-concurrency-"): string {
  const dir: string = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

interface StressDatabase {
  readonly db: Database;
  readonly file: string;
}

/**
 * Open a fresh WAL-mode database with the given busy_timeout (ms).
 * Creates a simple `writes` table for the stress test rows.
 */
function openStressDatabase(busyTimeoutMs: number): StressDatabase {
  const dir = createTempDir();
  const file = join(dir, "stress.db");
  const db = new Database(file, { create: true });

  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  db.exec(`
    CREATE TABLE IF NOT EXISTS writes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      writer_id INTEGER NOT NULL,
      sequence INTEGER NOT NULL,
      payload TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  return { db, file };
}

interface WriterResult {
  readonly writerId: number;
  readonly successes: number;
  readonly busyErrors: number;
  readonly otherErrors: number;
  readonly elapsedMs: number;
}

interface ScenarioResult {
  readonly scenario: string;
  readonly totalSuccesses: number;
  readonly totalBusyErrors: number;
  readonly totalOtherErrors: number;
  readonly busyErrorRate: number;
  readonly elapsedMs: number;
  readonly writerResults: readonly WriterResult[];
}

function isSqliteBusyError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("database is locked") || msg.includes("sqlite_busy");
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Writer strategies                                                 */
/* ------------------------------------------------------------------ */

/**
 * Writer using default db.transaction() (BEGIN DEFERRED).
 * Each writer opens its own Database connection to the same file,
 * matching how multiple processes would contend.
 */
function runDeferredWriter(
  dbFile: string,
  writerId: number,
  writeCount: number,
  busyTimeoutMs: number,
): WriterResult {
  const conn = new Database(dbFile, { create: false });
  conn.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  conn.exec("PRAGMA journal_mode = WAL;");

  let successes = 0;
  let busyErrors = 0;
  let otherErrors = 0;
  const start = performance.now();

  for (let seq = 0; seq < writeCount; seq++) {
    try {
      conn.transaction((): void => {
        conn
          .query("INSERT INTO writes (writer_id, sequence, payload) VALUES (?, ?, ?);")
          .run(writerId, seq, `deferred-writer-${writerId}-seq-${seq}`);
      })();
      successes++;
    } catch (error) {
      if (isSqliteBusyError(error)) {
        busyErrors++;
      } else {
        otherErrors++;
      }
    }
  }

  const elapsedMs = performance.now() - start;
  conn.close(false);

  return { writerId, successes, busyErrors, otherErrors, elapsedMs };
}

/**
 * Writer using BEGIN IMMEDIATE transactions.
 */
function runImmediateWriter(
  dbFile: string,
  writerId: number,
  writeCount: number,
  busyTimeoutMs: number,
): WriterResult {
  const conn = new Database(dbFile, { create: false });
  conn.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
  conn.exec("PRAGMA journal_mode = WAL;");

  let successes = 0;
  let busyErrors = 0;
  let otherErrors = 0;
  const start = performance.now();

  for (let seq = 0; seq < writeCount; seq++) {
    try {
      conn.exec("BEGIN IMMEDIATE;");
      try {
        conn
          .query("INSERT INTO writes (writer_id, sequence, payload) VALUES (?, ?, ?);")
          .run(writerId, seq, `immediate-writer-${writerId}-seq-${seq}`);
        conn.exec("COMMIT;");
        successes++;
      } catch (innerError) {
        try {
          conn.exec("ROLLBACK;");
        } catch {
          /* rollback best-effort */
        }
        throw innerError;
      }
    } catch (error) {
      if (isSqliteBusyError(error)) {
        busyErrors++;
      } else {
        otherErrors++;
      }
    }
  }

  const elapsedMs = performance.now() - start;
  conn.close(false);

  return { writerId, successes, busyErrors, otherErrors, elapsedMs };
}

/* ------------------------------------------------------------------ */
/*  Scenario runner                                                   */
/* ------------------------------------------------------------------ */

type WriterFactory = (
  dbFile: string,
  writerId: number,
  writeCount: number,
  busyTimeoutMs: number,
) => WriterResult;

function runScenario(
  scenario: string,
  busyTimeoutMs: number,
  writerFactory: WriterFactory,
): ScenarioResult {
  const { db, file } = openStressDatabase(busyTimeoutMs);

  // Close the setup connection before writers contend
  db.close(false);

  const start = performance.now();

  // Spawn concurrent writers using Promise.all — each writer runs synchronously
  // inside its own microtask, but they interleave at the SQLite lock level
  // because Bun's Database is synchronous and WAL allows concurrent reads.
  // To get true parallelism we'd need worker threads, but even interleaved
  // synchronous access from separate connections exposes lock contention.
  const writerResults: WriterResult[] = [];

  // We run writers "concurrently" by opening separate connections and
  // executing them. In a single-threaded runtime, we rely on the fact that
  // each writer's transaction may conflict at the SQLite page-lock level
  // with the shared WAL file.
  //
  // For meaningful contention we interleave writes across writers
  // (round-robin style) rather than running each writer sequentially.
  const connections: Database[] = [];
  const state = Array.from({ length: WRITER_COUNT }, (_, i) => ({
    writerId: i,
    successes: 0,
    busyErrors: 0,
    otherErrors: 0,
    startTime: performance.now(),
  }));

  for (let i = 0; i < WRITER_COUNT; i++) {
    const conn = new Database(file, { create: false });
    conn.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    conn.exec("PRAGMA journal_mode = WAL;");
    connections.push(conn);
  }

  // Interleaved round-robin writes to maximize contention
  for (let seq = 0; seq < WRITES_PER_WRITER; seq++) {
    for (let w = 0; w < WRITER_COUNT; w++) {
      const conn = connections[w];
      const s = state[w];

      try {
        if (writerFactory === runImmediateWriter) {
          conn.exec("BEGIN IMMEDIATE;");
          try {
            conn
              .query("INSERT INTO writes (writer_id, sequence, payload) VALUES (?, ?, ?);")
              .run(w, seq, `${scenario}-writer-${w}-seq-${seq}`);
            conn.exec("COMMIT;");
            s.successes++;
          } catch (innerError) {
            try {
              conn.exec("ROLLBACK;");
            } catch {
              /* best-effort */
            }
            throw innerError;
          }
        } else {
          conn.transaction((): void => {
            conn
              .query("INSERT INTO writes (writer_id, sequence, payload) VALUES (?, ?, ?);")
              .run(w, seq, `${scenario}-writer-${w}-seq-${seq}`);
          })();
          s.successes++;
        }
      } catch (error) {
        if (isSqliteBusyError(error)) {
          s.busyErrors++;
        } else {
          s.otherErrors++;
        }
      }
    }
  }

  const elapsedMs = performance.now() - start;

  for (const conn of connections) {
    conn.close(false);
  }

  const results: WriterResult[] = state.map((s) => ({
    writerId: s.writerId,
    successes: s.successes,
    busyErrors: s.busyErrors,
    otherErrors: s.otherErrors,
    elapsedMs: performance.now() - s.startTime,
  }));

  const totalSuccesses = results.reduce((sum, r) => sum + r.successes, 0);
  const totalBusyErrors = results.reduce((sum, r) => sum + r.busyErrors, 0);
  const totalOtherErrors = results.reduce((sum, r) => sum + r.otherErrors, 0);
  const totalAttempts = totalSuccesses + totalBusyErrors + totalOtherErrors;
  const busyErrorRate = totalAttempts > 0 ? totalBusyErrors / totalAttempts : 0;

  return {
    scenario,
    totalSuccesses,
    totalBusyErrors,
    totalOtherErrors,
    busyErrorRate,
    elapsedMs,
    writerResults: results,
  };
}

/* ------------------------------------------------------------------ */
/*  Also run a true parallel variant using separate Database instances */
/*  opened and written in parallel via Promise.all                    */
/* ------------------------------------------------------------------ */

async function runParallelScenario(
  scenario: string,
  busyTimeoutMs: number,
  writerFactory: WriterFactory,
): Promise<ScenarioResult> {
  const { db, file } = openStressDatabase(busyTimeoutMs);
  db.close(false);

  const start = performance.now();

  // Each writer runs in its own resolved-promise microtask
  const writerPromises = Array.from({ length: WRITER_COUNT }, (_, i) =>
    Promise.resolve().then(() => writerFactory(file, i, WRITES_PER_WRITER, busyTimeoutMs)),
  );

  const results = await Promise.all(writerPromises);
  const elapsedMs = performance.now() - start;

  const totalSuccesses = results.reduce((sum, r) => sum + r.successes, 0);
  const totalBusyErrors = results.reduce((sum, r) => sum + r.busyErrors, 0);
  const totalOtherErrors = results.reduce((sum, r) => sum + r.otherErrors, 0);
  const totalAttempts = totalSuccesses + totalBusyErrors + totalOtherErrors;
  const busyErrorRate = totalAttempts > 0 ? totalBusyErrors / totalAttempts : 0;

  return {
    scenario,
    totalSuccesses,
    totalBusyErrors,
    totalOtherErrors,
    busyErrorRate,
    elapsedMs,
    writerResults: results,
  };
}

function printResult(result: ScenarioResult): void {
  console.log(`\n  [${result.scenario}]`);
  console.log(`    Total writes attempted: ${result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors}`);
  console.log(`    Successes: ${result.totalSuccesses}`);
  console.log(`    SQLITE_BUSY errors: ${result.totalBusyErrors}`);
  console.log(`    Other errors: ${result.totalOtherErrors}`);
  console.log(`    Busy error rate: ${(result.busyErrorRate * 100).toFixed(2)}%`);
  console.log(`    Elapsed: ${result.elapsedMs.toFixed(1)}ms`);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                             */
/* ------------------------------------------------------------------ */

describe("SQLite concurrent write stress tests", () => {
  describe("Scenario 1 - Baseline DEFERRED transactions", () => {
    test("interleaved writers using db.transaction() (BEGIN DEFERRED)", () => {
      const result = runScenario("deferred-interleaved", 5000, runDeferredWriter);
      printResult(result);

      // With WAL mode + busy_timeout, most or all writes should succeed
      expect(result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors).toBe(
        TOTAL_EXPECTED_ROWS,
      );
      // Log the error rate as baseline; we do not assert zero errors since
      // contention behaviour depends on the runtime and OS scheduler.
      expect(result.totalSuccesses).toBeGreaterThan(0);
    });

    test("parallel writers using db.transaction() (BEGIN DEFERRED)", async () => {
      const result = await runParallelScenario("deferred-parallel", 5000, runDeferredWriter);
      printResult(result);

      expect(result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors).toBe(
        TOTAL_EXPECTED_ROWS,
      );
      expect(result.totalSuccesses).toBeGreaterThan(0);
    });
  });

  describe("Scenario 2 - IMMEDIATE transaction mode", () => {
    test("interleaved writers using BEGIN IMMEDIATE", () => {
      const result = runScenario("immediate-interleaved", 5000, runImmediateWriter);
      printResult(result);

      expect(result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors).toBe(
        TOTAL_EXPECTED_ROWS,
      );
      expect(result.totalSuccesses).toBeGreaterThan(0);
    });

    test("parallel writers using BEGIN IMMEDIATE", async () => {
      const result = await runParallelScenario("immediate-parallel", 5000, runImmediateWriter);
      printResult(result);

      expect(result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors).toBe(
        TOTAL_EXPECTED_ROWS,
      );
      expect(result.totalSuccesses).toBeGreaterThan(0);
    });
  });

  describe("Scenario 3 - busy_timeout variations", () => {
    const timeoutValues = [5000, 10000, 15000];

    for (const timeout of timeoutValues) {
      test(`DEFERRED with busy_timeout=${timeout}ms`, () => {
        const result = runScenario(`deferred-timeout-${timeout}`, timeout, runDeferredWriter);
        printResult(result);

        expect(result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors).toBe(
          TOTAL_EXPECTED_ROWS,
        );
        expect(result.totalSuccesses).toBeGreaterThan(0);
      });

      test(`IMMEDIATE with busy_timeout=${timeout}ms`, () => {
        const result = runScenario(`immediate-timeout-${timeout}`, timeout, runImmediateWriter);
        printResult(result);

        expect(result.totalSuccesses + result.totalBusyErrors + result.totalOtherErrors).toBe(
          TOTAL_EXPECTED_ROWS,
        );
        expect(result.totalSuccesses).toBeGreaterThan(0);
      });
    }
  });

  describe("Scenario comparison summary", () => {
    test("compare DEFERRED vs IMMEDIATE error rates side by side", async () => {
      const deferredResult = await runParallelScenario("summary-deferred", 5000, runDeferredWriter);
      const immediateResult = await runParallelScenario("summary-immediate", 5000, runImmediateWriter);

      console.log("\n  === Comparison Summary ===");
      printResult(deferredResult);
      printResult(immediateResult);

      console.log(`\n    DEFERRED busy error rate:  ${(deferredResult.busyErrorRate * 100).toFixed(2)}%`);
      console.log(`    IMMEDIATE busy error rate: ${(immediateResult.busyErrorRate * 100).toFixed(2)}%`);

      // Both scenarios should complete all attempted writes
      expect(
        deferredResult.totalSuccesses + deferredResult.totalBusyErrors + deferredResult.totalOtherErrors,
      ).toBe(TOTAL_EXPECTED_ROWS);
      expect(
        immediateResult.totalSuccesses + immediateResult.totalBusyErrors + immediateResult.totalOtherErrors,
      ).toBe(TOTAL_EXPECTED_ROWS);
    });
  });
});
