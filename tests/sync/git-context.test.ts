/**
 * Regression tests for the git-context cache.
 *
 * Bug history: the cache invalidated only on `<worktree>/.git/HEAD` mtime
 * (normal repo) or the `.git` file stat (linked worktree). Both miss:
 *   (a) same-branch commit advance — `<gitdir>/HEAD` does not change when a
 *       new commit is added on the current branch; the loose ref file
 *       `<gitdir>/refs/heads/<branch>` does.
 *   (b) linked-worktree checkout — the `.git` file in a linked worktree is
 *       a static pointer, so its stat never changes; the worktree's HEAD
 *       and branch ref live in `<main-gitdir>/worktrees/<name>/{HEAD,...}`.
 *
 * The fix resolves the real gitdir per cwd and stats both `<gitdir>/HEAD`
 * AND the resolved branch ref tip (loose or packed) to build the cache key.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

// Other tests in tests/sync use `mock.module("../../src/sync/git-context", ...)`
// to stub git resolution. Bun's `mock.restore()` does not reliably undo
// `mock.module` overrides across test files, so we import the source module
// via a query-string suffix to bypass the module-specifier cache and force a
// fresh evaluation of the real file.
const realModule = (await import("../../src/sync/git-context.ts?real")) as typeof import("../../src/sync/git-context");
const { clearGitContextCache, resolveGitContext } = realModule;

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const dir: string | undefined = tempDirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  }
  clearGitContextCache();
});

function git(cwd: string, ...args: readonly string[]): string {
  const command = Bun.spawnSync({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  if (command.exitCode !== 0) {
    const err = new TextDecoder().decode(command.stderr);
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${err}`);
  }
  return new TextDecoder().decode(command.stdout).trim();
}

function initRepo(cwd: string): void {
  git(cwd, "init", "-q", "-b", "main");
  git(cwd, "config", "user.email", "test@example.com");
  git(cwd, "config", "user.name", "Test");
  git(cwd, "config", "commit.gpgsign", "false");
  // Empty initial commit so HEAD resolves to a SHA from the start.
  git(cwd, "commit", "--allow-empty", "-m", "init", "-q");
}

function makeCommit(cwd: string, marker: string): string {
  // Create a unique file so each commit produces a distinct SHA.
  Bun.write(join(cwd, `${marker}.txt`), `${marker}\n`);
  git(cwd, "add", "-A");
  git(cwd, "commit", "-m", marker, "-q");
  return git(cwd, "rev-parse", "HEAD");
}

describe("resolveGitContext cache", () => {
  test("invalidates on same-branch commit advance", () => {
    const repo = createTempDir("trekoon-gctx-advance-");
    initRepo(repo);

    const before = resolveGitContext(repo);
    expect(before.branchName).toBe("main");
    expect(typeof before.headSha).toBe("string");
    expect(before.headSha?.length).toBe(40);

    const newSha = makeCommit(repo, "second");

    const after = resolveGitContext(repo);
    expect(after.branchName).toBe("main");
    expect(after.headSha).toBe(newSha);
    expect(after.headSha).not.toBe(before.headSha);
  });

  test("invalidates on branch checkout in primary worktree", () => {
    const repo = createTempDir("trekoon-gctx-checkout-");
    initRepo(repo);
    makeCommit(repo, "main-only");

    const beforeShaMain = git(repo, "rev-parse", "HEAD");
    const before = resolveGitContext(repo);
    expect(before.branchName).toBe("main");
    expect(before.headSha).toBe(beforeShaMain);

    git(repo, "checkout", "-q", "-b", "feature/x");
    makeCommit(repo, "feature-only");
    const featureSha = git(repo, "rev-parse", "HEAD");

    const after = resolveGitContext(repo);
    expect(after.branchName).toBe("feature/x");
    expect(after.headSha).toBe(featureSha);
  });

  test("invalidates on linked-worktree checkout", () => {
    const repo = createTempDir("trekoon-gctx-linked-");
    initRepo(repo);
    makeCommit(repo, "primary-1");
    git(repo, "branch", "feature/wt", "HEAD");

    // Add a linked worktree on the feature branch in a directory that lives
    // OUTSIDE the primary repo (so resolveStoragePaths sees it as a distinct
    // worktree root, not a nested path under the primary).
    const linkedParent = createTempDir("trekoon-gctx-linked-wt-");
    const linked = join(linkedParent, "wt");
    git(repo, "worktree", "add", "-q", linked, "feature/wt");

    // Initial resolve in the linked worktree.
    const beforeLinked = resolveGitContext(linked);
    expect(beforeLinked.branchName).toBe("feature/wt");
    const beforeLinkedSha = beforeLinked.headSha;
    expect(typeof beforeLinkedSha).toBe("string");

    // Switch to a different branch INSIDE the linked worktree (this updates
    // <main-gitdir>/worktrees/<name>/HEAD, but the `.git` pointer file in
    // `linked` itself does not change — the legacy implementation would
    // return the cached SHA/branch).
    git(linked, "checkout", "-q", "-b", "feature/wt-2");
    makeCommit(linked, "wt-only");
    const linkedAfterSha = git(linked, "rev-parse", "HEAD");

    const afterLinked = resolveGitContext(linked);
    expect(afterLinked.branchName).toBe("feature/wt-2");
    expect(afterLinked.headSha).toBe(linkedAfterSha);
  });

  test("commit advance in linked worktree invalidates cache", () => {
    const repo = createTempDir("trekoon-gctx-linked-advance-");
    initRepo(repo);
    makeCommit(repo, "primary-1");
    git(repo, "branch", "feature/advance", "HEAD");

    const linkedParent = createTempDir("trekoon-gctx-linked-advance-wt-");
    const linked = join(linkedParent, "wt");
    git(repo, "worktree", "add", "-q", linked, "feature/advance");

    const before = resolveGitContext(linked);
    expect(before.branchName).toBe("feature/advance");
    const beforeSha = before.headSha;

    const advanced = makeCommit(linked, "advance-1");

    const after = resolveGitContext(linked);
    expect(after.headSha).toBe(advanced);
    expect(after.headSha).not.toBe(beforeSha);
  });
});
