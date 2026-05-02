/**
 * Cache-bound regression tests.
 *
 * Covers the LRU bound on `cachedDatabases` (src/storage/database.ts) and on
 * `gitContextCache` / `gitDirCache` (src/sync/git-context.ts), plus the
 * autoMigrate-honoring path on the cached-handle return in daemon mode.
 *
 * The plain `Map` cache pre-fix was unbounded — a long-running daemon
 * serving many distinct cwds would accumulate open SQLite connections and
 * git-context entries without limit.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  cachedDatabasesSize,
  closeCachedDatabases,
  openTrekoonDatabase,
} from "../../src/storage/database";
import {
  clearGitContextCache,
  gitContextCacheSize,
  resolveGitContext,
} from "../../src/sync/git-context";
import { LATEST_MIGRATION_VERSION, readCurrentMigrationVersionReadOnly } from "../../src/storage/migrations";

const CACHE_CAPACITY = 16;
const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-cache-"));
  tempDirs.push(workspace);
  return workspace;
}

function initCommittedGitRepository(workspace: string): void {
  execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "README.md"), "# Trekoon\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: workspace, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=Trekoon Tests", "-c", "user.email=tests@trekoon.local", "commit", "-m", "init"],
    { cwd: workspace, stdio: "ignore" },
  );
}

afterEach((): void => {
  closeCachedDatabases();
  clearGitContextCache();
  delete process.env.TREKOON_DAEMON_INPROCESS;
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("daemon-mode cachedDatabases LRU bound", (): void => {
  test("cache size never exceeds capacity when many distinct cwds are opened", (): void => {
    process.env.TREKOON_DAEMON_INPROCESS = "1";

    const workspaces: string[] = [];
    const totalRequests = CACHE_CAPACITY * 2 + 3;
    for (let index = 0; index < totalRequests; index += 1) {
      const workspace = createWorkspace();
      workspaces.push(workspace);
      const handle = openTrekoonDatabase(workspace);
      // close() is a no-op for cached handles by design.
      handle.close();
      expect(cachedDatabasesSize()).toBeLessThanOrEqual(CACHE_CAPACITY);
    }

    expect(cachedDatabasesSize()).toBe(CACHE_CAPACITY);
  });

  test("LRU semantics: most recently accessed cwd is retained, oldest is evicted", (): void => {
    process.env.TREKOON_DAEMON_INPROCESS = "1";

    // Fill the cache. Mirror the daemon's real per-request lifecycle by
    // calling close() so each entry is releasable for eviction.
    const workspaces: string[] = [];
    for (let index = 0; index < CACHE_CAPACITY; index += 1) {
      const workspace = createWorkspace();
      workspaces.push(workspace);
      openTrekoonDatabase(workspace).close();
    }
    expect(cachedDatabasesSize()).toBe(CACHE_CAPACITY);

    // Touch the first workspace so it becomes most-recently-used.
    const firstWorkspace = workspaces[0];
    if (firstWorkspace === undefined) {
      throw new Error("workspaces array is unexpectedly empty");
    }
    openTrekoonDatabase(firstWorkspace).close();
    expect(cachedDatabasesSize()).toBe(CACHE_CAPACITY);

    // Inserting a new workspace should evict the SECOND workspace (oldest LRU)
    // not the first (which was just touched).
    const newWorkspace = createWorkspace();
    openTrekoonDatabase(newWorkspace).close();
    expect(cachedDatabasesSize()).toBe(CACHE_CAPACITY);

    // Re-opening the touched workspace should still be a cache hit
    // (instance equality is preserved across calls).
    const handleA = openTrekoonDatabase(firstWorkspace);
    const handleB = openTrekoonDatabase(firstWorkspace);
    expect(handleA).toBe(handleB);
    handleA.close();
    handleB.close();
  });

  test("evicted cwd reopens cleanly with a fresh handle", (): void => {
    process.env.TREKOON_DAEMON_INPROCESS = "1";

    const targetWorkspace = createWorkspace();
    const targetHandle = openTrekoonDatabase(targetWorkspace);
    targetHandle.close();

    // Push the target out of the cache by opening (capacity) other workspaces.
    for (let index = 0; index < CACHE_CAPACITY; index += 1) {
      openTrekoonDatabase(createWorkspace()).close();
    }

    // Reopening should give us a fresh handle (different identity), and the
    // database file must still be queryable — i.e. eviction closed cleanly.
    const reopened = openTrekoonDatabase(targetWorkspace);
    expect(reopened).not.toBe(targetHandle);
    const tableCount = reopened.db.query("SELECT COUNT(*) AS n FROM sqlite_master;").get() as { n: number };
    expect(tableCount.n).toBeGreaterThan(0);
    reopened.close();
  });

  test("eviction skips in-use handles and defers until release", (): void => {
    process.env.TREKOON_DAEMON_INPROCESS = "1";

    // Fill the cache to capacity, releasing each entry so they are eligible
    // for eviction.
    const workspaces: string[] = [];
    for (let index = 0; index < CACHE_CAPACITY; index += 1) {
      const workspace = createWorkspace();
      workspaces.push(workspace);
      openTrekoonDatabase(workspace).close();
    }
    expect(cachedDatabasesSize()).toBe(CACHE_CAPACITY);

    // Re-borrow the LRU (oldest) entry without releasing — this represents an
    // in-flight daemon request still using the handle.
    const lruWorkspace = workspaces[0];
    if (lruWorkspace === undefined) {
      throw new Error("workspaces array is unexpectedly empty");
    }
    const lruHandle = openTrekoonDatabase(lruWorkspace);

    // Opening a 17th cwd MUST NOT close the in-use LRU handle. The handle
    // must remain usable for the in-flight request.
    const newWorkspace = createWorkspace();
    const newHandle = openTrekoonDatabase(newWorkspace);

    // The in-use handle is still functional — closing it under the borrower
    // would surface as SQLITE_MISUSE, which would throw here.
    const probe = lruHandle.db.query("SELECT COUNT(*) AS n FROM sqlite_master;").get() as { n: number };
    expect(probe.n).toBeGreaterThan(0);

    // Cache temporarily grew past the cap because every entry was borrowed
    // (15 just-released + 1 still-in-use + 1 new = 17 momentarily). Eviction
    // could not run because the LRU was the only candidate and it was in use.
    expect(cachedDatabasesSize()).toBe(CACHE_CAPACITY + 1);

    // Release the in-use LRU. The next release should re-run eviction and
    // bring the cache back under the cap.
    lruHandle.close();
    newHandle.close();

    // Touch a fresh workspace to drive an eviction pass and confirm the
    // previously-in-use entry is now eligible for normal eviction.
    openTrekoonDatabase(createWorkspace()).close();
    expect(cachedDatabasesSize()).toBeLessThanOrEqual(CACHE_CAPACITY);
  });
});

describe("daemon-mode autoMigrate-honoring on cached handles", (): void => {
  test("opening with autoMigrate:false then default upgrades the cached handle", (): void => {
    process.env.TREKOON_DAEMON_INPROCESS = "1";

    const workspace = createWorkspace();
    initCommittedGitRepository(workspace);

    // First open without autoMigrate to simulate a `migrate-status`-style
    // request that should NOT mutate the schema.
    const firstHandle = openTrekoonDatabase(workspace, { autoMigrate: false });
    const firstVersion = readCurrentMigrationVersionReadOnly(firstHandle.db);
    // It's possible the DB is fresh-created (version 0) with no migrations
    // applied yet — that's the case we want to cover.
    expect(firstVersion).toBeLessThanOrEqual(LATEST_MIGRATION_VERSION);

    // Second open with default options (autoMigrate: true) MUST migrate the
    // cached handle to LATEST_MIGRATION_VERSION rather than silently returning
    // the under-migrated cached connection.
    const secondHandle = openTrekoonDatabase(workspace);
    expect(secondHandle).toBe(firstHandle); // same cached instance
    expect(readCurrentMigrationVersionReadOnly(secondHandle.db)).toBe(LATEST_MIGRATION_VERSION);
  });
});

describe("gitContextCache LRU bound", (): void => {
  test("size never exceeds capacity when many distinct worktrees are resolved", (): void => {
    const before = gitContextCacheSize();
    expect(before).toBe(0);

    const totalWorktrees = CACHE_CAPACITY * 2 + 3;
    for (let index = 0; index < totalWorktrees; index += 1) {
      const workspace = createWorkspace();
      initCommittedGitRepository(workspace);
      resolveGitContext(workspace);
      expect(gitContextCacheSize()).toBeLessThanOrEqual(CACHE_CAPACITY);
    }

    expect(gitContextCacheSize()).toBe(CACHE_CAPACITY);
  });
});
