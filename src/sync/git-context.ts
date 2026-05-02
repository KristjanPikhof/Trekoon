import { type Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { join } from "node:path";

import { writeTransaction } from "../storage/database";
import { resolveStoragePaths } from "../storage/path";
import { type GitContextSnapshot } from "./types";

export interface ResolvedGitContext extends GitContextSnapshot {
  readonly persistedAt: number;
}

function runGit(args: readonly string[], cwd: string): string | null {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (command.exitCode !== 0) {
    return null;
  }

  const output: string = new TextDecoder().decode(command.stdout).trim();
  return output.length > 0 ? output : null;
}

/** Process-lifetime cache: cwd → resolved branch + headSha (without persistedAt). */
interface GitContextCore {
  readonly worktreePath: string;
  readonly branchName: string | null;
  readonly headSha: string | null;
  readonly headStatKey: string | null;
}

const gitContextCache: Map<string, GitContextCore> = new Map();

function readHeadStatKey(cwd: string): string | null {
  // Try normal repo path first (.git/HEAD updates on every checkout).
  try {
    const stat = statSync(join(cwd, ".git", "HEAD"));
    return `head|${stat.mtimeMs}|${stat.size}|${stat.ino}`;
  } catch {
    // ignore — fall through
  }
  // Linked worktree: .git is a file pointing to the actual gitdir.
  // Stat the file itself; safer than chasing the pointer (rare moves only).
  try {
    const stat = statSync(join(cwd, ".git"));
    return `gitfile|${stat.mtimeMs}|${stat.size}|${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Clear the process-level git context cache.
 * Intended for test isolation only — production code should never call this.
 */
export function clearGitContextCache(): void {
  gitContextCache.clear();
}

/**
 * Return the number of entries currently held in the process-level cache.
 * Intended for test assertions only.
 */
export function gitContextCacheSize(): number {
  return gitContextCache.size;
}

export function resolveGitContext(cwd: string, persistedAt: number = Date.now()): ResolvedGitContext {
  const storagePaths = resolveStoragePaths(cwd);
  const worktreePath: string = storagePaths.worktreeRoot;
  const headStatKey: string | null = readHeadStatKey(worktreePath);

  const cached: GitContextCore | undefined = gitContextCache.get(worktreePath);
  if (cached !== undefined && cached.headStatKey === headStatKey) {
    return { worktreePath: cached.worktreePath, branchName: cached.branchName, headSha: cached.headSha, persistedAt };
  }

  const branchName: string | null = runGit(["branch", "--show-current"], cwd);
  const headSha: string | null = runGit(["rev-parse", "HEAD"], cwd);

  const core: GitContextCore = { worktreePath, branchName, headSha, headStatKey };
  gitContextCache.set(worktreePath, core);

  return { worktreePath, branchName, headSha, persistedAt };
}

function persistGitContextInner(db: Database, git: GitContextSnapshot, persistedAt: number): void {
  db.query(
    `
    INSERT INTO git_context (
      id,
      metadata_scope,
      worktree_path,
      branch_name,
      head_sha,
      created_at,
      updated_at,
      version
    ) VALUES (
      @worktreePath,
      'worktree',
      @worktreePath,
      @branchName,
      @headSha,
      @persistedAt,
      @persistedAt,
      1
    )
    ON CONFLICT(id) DO UPDATE SET
      metadata_scope = excluded.metadata_scope,
      worktree_path = excluded.worktree_path,
      branch_name = excluded.branch_name,
      head_sha = excluded.head_sha,
      updated_at = excluded.updated_at,
      version = git_context.version + 1;
    `,
  ).run({
    "@worktreePath": git.worktreePath,
    "@branchName": git.branchName,
    "@headSha": git.headSha,
    "@persistedAt": persistedAt,
  });
}

/**
 * Persist the git context snapshot to the database.
 *
 * If the caller is already inside a write transaction this function writes
 * directly (no double-BEGIN).  Otherwise it self-acquires a BEGIN IMMEDIATE
 * transaction so concurrent callers — e.g. five parallel `session` invocations
 * — never race on the deferred-to-immediate lock promotion that causes
 * SQLITE_BUSY.
 */
export function persistGitContext(db: Database, git: GitContextSnapshot, persistedAt: number = Date.now()): void {
  if (db.inTransaction) {
    persistGitContextInner(db, git, persistedAt);
  } else {
    writeTransaction(db, (txDb) => {
      persistGitContextInner(txDb, git, persistedAt);
    });
  }
}
