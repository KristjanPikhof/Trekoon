/**
 * Startup performance test: 5 sequential session calls must complete in under
 * 500ms total, and the git context cache must absorb the repeated git
 * subprocess calls after the first invocation.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { runSession } from "../../src/commands/session";
import {
  clearGitContextCache,
  gitContextCacheSize,
  resolveGitContext,
} from "../../src/sync/git-context";
import { clearStoragePathCache } from "../../src/storage/path";

const SESSION_COUNT = 5;
/** Hard budget for 5 sequential in-process session calls (ms). */
const PERF_BUDGET_MS = 500;

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-perf-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "perf-test@trekoon.local"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Trekoon Perf Tests"], { cwd: workspace, stdio: "ignore" });
  writeFileSync(join(workspace, "README.md"), "# perf test repo\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: workspace, stdio: "ignore" });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "init"], { cwd: workspace, stdio: "ignore" });
}

beforeEach((): void => {
  // Start each test with cold caches for correct isolation.
  clearGitContextCache();
  clearStoragePathCache();
});

afterEach((): void => {
  clearGitContextCache();
  clearStoragePathCache();
  while (tempDirs.length > 0) {
    const workspace = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("git context cache", (): void => {
  test("cache starts empty and is populated on first resolveGitContext call", (): void => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    expect(gitContextCacheSize()).toBe(0);
    resolveGitContext(cwd);
    expect(gitContextCacheSize()).toBe(1);
  });

  test("repeated calls with the same cwd do not grow the cache beyond 1 entry", (): void => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    resolveGitContext(cwd);
    resolveGitContext(cwd);
    resolveGitContext(cwd);

    // Cache must contain exactly one entry for this worktree.
    expect(gitContextCacheSize()).toBe(1);
  });

  test("all cached results share the same branch and sha", (): void => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    const first = resolveGitContext(cwd);
    const second = resolveGitContext(cwd);
    const third = resolveGitContext(cwd);

    expect(second.branchName).toBe(first.branchName);
    expect(second.headSha).toBe(first.headSha);
    expect(third.branchName).toBe(first.branchName);
    expect(third.headSha).toBe(first.headSha);
  });

  test("clearGitContextCache resets the cache to empty", (): void => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    resolveGitContext(cwd);
    expect(gitContextCacheSize()).toBe(1);

    clearGitContextCache();
    expect(gitContextCacheSize()).toBe(0);

    // After clearing, the next call must re-populate (cache grows back to 1).
    resolveGitContext(cwd);
    expect(gitContextCacheSize()).toBe(1);
  });
});

describe("session startup performance", (): void => {
  test(`${SESSION_COUNT} sequential session calls complete under ${PERF_BUDGET_MS}ms`, async (): Promise<void> => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    // Warm-up: one session call to pre-populate caches (not measured).
    await runSession({ cwd, mode: "json", args: [] });

    const start = performance.now();
    for (let i = 0; i < SESSION_COUNT; i++) {
      const result = await runSession({ cwd, mode: "json", args: [] });
      expect(result.ok).toBeTrue();
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
  });

  test("git context cache has exactly 1 entry after multiple session calls to the same workspace", async (): Promise<void> => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    for (let i = 0; i < SESSION_COUNT; i++) {
      await runSession({ cwd, mode: "json", args: [] });
    }

    // All session calls target the same worktree — only one cache entry expected.
    expect(gitContextCacheSize()).toBe(1);
  });
});
