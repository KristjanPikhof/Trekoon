/**
 * Startup performance test: 5 sequential session calls must complete in under
 * 500ms total, and the git context cache must absorb the repeated git
 * subprocess calls after the first invocation.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { runSession } from "../../src/commands/session";
import { clearGitContextCache, resolveGitContext } from "../../src/sync/git-context";
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
  // Ensure each test starts with cold caches for correct isolation.
  clearGitContextCache();
  clearStoragePathCache();
});

afterEach((): void => {
  // Restore caches and clean up workspaces.
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
  test("resolveGitContext is memoized: git subprocess runs exactly once per worktree", (): void => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    // Spy on the git subprocess launcher used by git-context.ts.
    const spy = spyOn(Bun, "spawnSync");

    const first = resolveGitContext(cwd);
    const second = resolveGitContext(cwd);
    const third = resolveGitContext(cwd);

    // All three results share the same branch / sha values.
    expect(second.branchName).toBe(first.branchName);
    expect(second.headSha).toBe(first.headSha);
    expect(third.branchName).toBe(first.branchName);
    expect(third.headSha).toBe(first.headSha);

    // The first call invokes git twice (branch --show-current + rev-parse HEAD).
    // Subsequent calls must be cache hits — zero additional git subprocess calls.
    const gitCalls = spy.mock.calls.filter(
      (args) => Array.isArray(args[0]) && args[0][0] === "git",
    );
    expect(gitCalls.length).toBe(2);

    spy.mockRestore();
  });

  test("clearGitContextCache forces a fresh git lookup on next call", (): void => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    const spy = spyOn(Bun, "spawnSync");

    resolveGitContext(cwd); // populates cache — 2 git calls
    clearGitContextCache();
    resolveGitContext(cwd); // cache cleared — 2 more git calls

    const gitCalls = spy.mock.calls.filter(
      (args) => Array.isArray(args[0]) && args[0][0] === "git",
    );
    expect(gitCalls.length).toBe(4);

    spy.mockRestore();
  });
});

describe("session startup performance", (): void => {
  test(`${SESSION_COUNT} sequential session calls complete under ${PERF_BUDGET_MS}ms`, async (): Promise<void> => {
    const cwd = createWorkspace();
    initGitRepository(cwd);

    // Warm-up: one session call outside the measurement window.
    await runSession({ cwd, mode: "json", args: [] });

    const start = performance.now();
    for (let i = 0; i < SESSION_COUNT; i++) {
      const result = await runSession({ cwd, mode: "json", args: [] });
      expect(result.ok).toBeTrue();
    }
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(PERF_BUDGET_MS);
  });
});
