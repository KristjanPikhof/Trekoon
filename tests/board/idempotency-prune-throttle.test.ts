import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  MutationService,
  __resetIdempotencyPruneThrottleForTests,
} from "../../src/domain/mutation-service";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "trekoon-prune-throttle-"));
  tempDirs.push(ws);
  return ws;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

beforeEach((): void => {
  __resetIdempotencyPruneThrottleForTests();
});

describe("MutationService#pruneExpiredIdempotencyKeys throttle", (): void => {
  // System Hardening 0.4.2, finding 27: prune was running on every claim.
  // We assert that back-to-back idempotent mutations issue exactly one
  // DELETE FROM board_idempotency_keys, not one per call.
  test("only the first claim within the 60s window issues a DELETE", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "E", description: "d" });
      const task = mutations.createTask({ epicId: epic.id, title: "T", description: "d" });

      // Spy on db.query so we can count prune DELETE statements without
      // touching the real query method's behaviour.
      let pruneCount = 0;
      const originalQuery = storage.db.query.bind(storage.db);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (storage.db as unknown as { query: (sql: string) => unknown }).query = (sql: string): unknown => {
        if (
          typeof sql === "string" &&
          /DELETE\s+FROM\s+board_idempotency_keys/iu.test(sql)
        ) {
          pruneCount += 1;
        }
        return originalQuery(sql);
      };

      const buildClaim = (key: string): {
        scope: "subtask";
        idempotencyKey: string;
        requestFingerprint: string;
        conflictMessage: string;
      } => ({
        scope: "subtask",
        idempotencyKey: key,
        requestFingerprint: `fp-${key}`,
        conflictMessage: "idempotency conflict",
      });

      // First claim: prune fires.
      mutations.createSubtaskAtomicallyWithIdempotency({
        taskId: task.id,
        title: "S1",
        description: "d",
        claim: buildClaim("k-1"),
        buildResponseData: () => ({}),
      });
      expect(pruneCount).toBe(1);

      // Second & third claims within the 60s window: prune is skipped.
      mutations.createSubtaskAtomicallyWithIdempotency({
        taskId: task.id,
        title: "S2",
        description: "d",
        claim: buildClaim("k-2"),
        buildResponseData: () => ({}),
      });
      mutations.createSubtaskAtomicallyWithIdempotency({
        taskId: task.id,
        title: "S3",
        description: "d",
        claim: buildClaim("k-3"),
        buildResponseData: () => ({}),
      });
      expect(pruneCount).toBe(1);

      // Reset throttle (simulating a process that crossed the 60s window)
      // → prune runs again on the next claim.
      __resetIdempotencyPruneThrottleForTests();
      mutations.createSubtaskAtomicallyWithIdempotency({
        taskId: task.id,
        title: "S4",
        description: "d",
        claim: buildClaim("k-4"),
        buildResponseData: () => ({}),
      });
      expect(pruneCount).toBe(2);
    } finally {
      storage.close();
    }
  });

  test("prune throttle is isolated per database file", (): void => {
    const firstCwd = createWorkspace();
    const secondCwd = createWorkspace();
    const firstStorage = openTrekoonDatabase(firstCwd);
    const secondStorage = openTrekoonDatabase(secondCwd);

    try {
      const firstMutations = new MutationService(firstStorage.db, firstCwd);
      const secondMutations = new MutationService(secondStorage.db, secondCwd);
      const firstEpic = firstMutations.createEpic({ title: "E1", description: "d" });
      const firstTask = firstMutations.createTask({ epicId: firstEpic.id, title: "T1", description: "d" });
      const secondEpic = secondMutations.createEpic({ title: "E2", description: "d" });
      const secondTask = secondMutations.createTask({ epicId: secondEpic.id, title: "T2", description: "d" });

      let firstPruneCount = 0;
      let secondPruneCount = 0;
      const firstQuery = firstStorage.db.query.bind(firstStorage.db);
      const secondQuery = secondStorage.db.query.bind(secondStorage.db);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (firstStorage.db as unknown as { query: (sql: string) => unknown }).query = (sql: string): unknown => {
        if (typeof sql === "string" && /DELETE\s+FROM\s+board_idempotency_keys/iu.test(sql)) {
          firstPruneCount += 1;
        }
        return firstQuery(sql);
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (secondStorage.db as unknown as { query: (sql: string) => unknown }).query = (sql: string): unknown => {
        if (typeof sql === "string" && /DELETE\s+FROM\s+board_idempotency_keys/iu.test(sql)) {
          secondPruneCount += 1;
        }
        return secondQuery(sql);
      };

      firstMutations.createSubtaskAtomicallyWithIdempotency({
        taskId: firstTask.id,
        title: "S1",
        description: "d",
        claim: {
          scope: "subtask",
          idempotencyKey: "first-key",
          requestFingerprint: "first-fp",
          conflictMessage: "idempotency conflict",
        },
        buildResponseData: () => ({}),
      });
      secondMutations.createSubtaskAtomicallyWithIdempotency({
        taskId: secondTask.id,
        title: "S2",
        description: "d",
        claim: {
          scope: "subtask",
          idempotencyKey: "second-key",
          requestFingerprint: "second-fp",
          conflictMessage: "idempotency conflict",
        },
        buildResponseData: () => ({}),
      });

      expect(firstPruneCount).toBe(1);
      expect(secondPruneCount).toBe(1);
    } finally {
      firstStorage.close();
      secondStorage.close();
    }
  });
});
