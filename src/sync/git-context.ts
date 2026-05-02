import { type Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

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
  readonly gitDir: string | null;
}

const gitContextCache: Map<string, GitContextCore> = new Map();

/** Cache of worktree path → absolute gitdir, populated lazily. */
const gitDirCache: Map<string, string | null> = new Map();

function statKey(prefix: string, path: string): string | null {
  try {
    const stat = statSync(path);
    return `${prefix}|${stat.mtimeMs}|${stat.size}|${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute gitdir for a worktree path.
 *
 * - In a normal (primary) repo, gitdir = `<worktree>/.git` (a directory).
 * - In a linked worktree, `<worktree>/.git` is a regular file containing
 *   `gitdir: <abs-or-rel-path>` and the real gitdir lives elsewhere
 *   (typically `<main-gitdir>/worktrees/<name>`).
 *
 * Reads the `.git` entry directly when possible (cheap, no subprocess) and
 * falls back to `git rev-parse --absolute-git-dir` only when the entry is
 * missing or unreadable. Result is memoized per worktree path because the
 * gitdir location only changes when a worktree is moved/recreated — safe to
 * pin for process lifetime in CLI usage.
 */
function resolveGitDir(worktreePath: string): string | null {
  const cached = gitDirCache.get(worktreePath);
  if (cached !== undefined) {
    return cached;
  }

  const dotGit = join(worktreePath, ".git");
  let resolved: string | null = null;

  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      resolved = dotGit;
    } else if (stat.isFile()) {
      // Linked worktree: parse the `gitdir: <path>` pointer.
      const raw: string = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(raw);
      if (match) {
        const pointer: string = match[1]!.trim();
        resolved = isAbsolute(pointer) ? pointer : resolvePath(worktreePath, pointer);
      }
    }
  } catch {
    // Fall through to git rev-parse below.
  }

  if (resolved === null) {
    const fromGit: string | null = runGit(["rev-parse", "--absolute-git-dir"], worktreePath);
    resolved = fromGit;
  }

  gitDirCache.set(worktreePath, resolved);
  return resolved;
}

/**
 * Compute a composite cache key that changes whenever HEAD moves — including
 * commit advance on the same branch and checkouts in linked worktrees.
 *
 * Sources of variance:
 *   1. `<gitdir>/HEAD` — changes on branch checkout (symbolic-ref content)
 *      or detached-HEAD updates.
 *   2. The resolved branch ref tip (loose ref file or packed-refs) — changes
 *      on every commit on the current branch. Stat'ing this is what catches
 *      the previously-missed "same-branch commit advance" case.
 */
function readHeadStatKey(worktreePath: string): string | null {
  const gitDir: string | null = resolveGitDir(worktreePath);
  if (gitDir === null) {
    // Best effort: fall back to stat'ing the dotgit entry. Better than
    // pinning forever on a stale cache when git is missing.
    return statKey("dotgit", join(worktreePath, ".git"));
  }

  const parts: string[] = [];

  const headKey: string | null = statKey("head", join(gitDir, "HEAD"));
  parts.push(headKey ?? "head|missing");

  // Resolve the branch ref pointed to by HEAD (if symbolic). Otherwise HEAD
  // itself encodes the SHA (detached) and stat'ing HEAD already covers it.
  let refTipKey: string | null = null;
  try {
    const headContent: string = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const symMatch = /^ref:\s*(.+)$/m.exec(headContent);
    if (symMatch) {
      const refPath: string = symMatch[1]!.trim();
      // Loose ref file: <gitdir>/<refPath>. Falls back to packed-refs stat.
      refTipKey =
        statKey("ref", join(gitDir, refPath)) ?? statKey("packed", join(gitDir, "packed-refs"));
    }
  } catch {
    // ignore — HEAD already in `parts`
  }

  if (refTipKey !== null) {
    parts.push(refTipKey);
  }

  return parts.join("::");
}

/**
 * Clear the process-level git context cache.
 * Intended for test isolation only — production code should never call this.
 */
export function clearGitContextCache(): void {
  gitContextCache.clear();
  gitDirCache.clear();
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

  const gitDir: string | null = resolveGitDir(worktreePath);
  const core: GitContextCore = { worktreePath, branchName, headSha, headStatKey, gitDir };
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
