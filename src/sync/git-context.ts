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

interface GitDirInfo {
  readonly gitDir: string | null;
  readonly commonDir: string | null;
}

/**
 * Process-level cache, keyed by worktree path. Bounded LRU so a long-running
 * daemon serving requests for many distinct cwds (e.g. running across
 * unrelated clones) does not grow this map without bound.
 */
const GIT_CONTEXT_CACHE_CAPACITY = 16;
const gitContextCache: Map<string, GitContextCore> = new Map();

/** Cache of worktree path → resolved gitdir + commondir, populated lazily. */
const gitDirCache: Map<string, GitDirInfo> = new Map();

function evictLruIfNeeded<K, V>(map: Map<K, V>, capacity: number): void {
  while (map.size >= capacity) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    map.delete(oldestKey);
  }
}

function touchEntry<K, V>(map: Map<K, V>, key: K, value: V): void {
  // Re-insert so this key moves to the MRU end of the insertion-order.
  map.delete(key);
  map.set(key, value);
}

function statKey(prefix: string, path: string): string | null {
  try {
    const stat = statSync(path);
    return `${prefix}|${stat.mtimeMs}|${stat.size}|${stat.ino}`;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute gitdir + commondir for a worktree path.
 *
 * - In a normal (primary) repo, gitdir = commondir = `<worktree>/.git`.
 * - In a linked worktree, `<worktree>/.git` is a regular file containing
 *   `gitdir: <abs-or-rel-path>` pointing at `<main-gitdir>/worktrees/<name>`.
 *   The commondir (where shared refs/heads live) is read from
 *   `<gitdir>/commondir`, which contains a path (often relative) to the
 *   primary `.git` directory.
 *
 * Reads the on-disk pointer files directly when possible (cheap, no
 * subprocess) and falls back to `git rev-parse --absolute-git-dir
 * --git-common-dir` only when the files are missing or unreadable. Result
 * is memoized per worktree path because the location only changes when a
 * worktree is moved/recreated — safe to pin for process lifetime in CLI use.
 */
function resolveGitDir(worktreePath: string): GitDirInfo {
  const cached = gitDirCache.get(worktreePath);
  if (cached !== undefined) {
    touchEntry(gitDirCache, worktreePath, cached);
    return cached;
  }

  const dotGit = join(worktreePath, ".git");
  let gitDir: string | null = null;

  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      gitDir = dotGit;
    } else if (stat.isFile()) {
      const raw: string = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/m.exec(raw);
      if (match) {
        const pointer: string = match[1]!.trim();
        gitDir = isAbsolute(pointer) ? pointer : resolvePath(worktreePath, pointer);
      }
    }
  } catch {
    // Fall through to git rev-parse below.
  }

  if (gitDir === null) {
    gitDir = runGit(["rev-parse", "--absolute-git-dir"], worktreePath);
  }

  let commonDir: string | null = gitDir;

  if (gitDir !== null) {
    // Linked worktrees record the shared refs location in <gitdir>/commondir.
    // The file content is typically a path relative to the linked gitdir.
    try {
      const commonRaw: string = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      if (commonRaw.length > 0) {
        commonDir = isAbsolute(commonRaw) ? commonRaw : resolvePath(gitDir, commonRaw);
      }
    } catch {
      // Primary repos have no commondir file; commonDir stays === gitDir.
    }
  }

  if (commonDir === null) {
    commonDir = runGit(["rev-parse", "--git-common-dir"], worktreePath);
    if (commonDir !== null && !isAbsolute(commonDir)) {
      commonDir = resolvePath(worktreePath, commonDir);
    }
  }

  const info: GitDirInfo = { gitDir, commonDir };
  evictLruIfNeeded(gitDirCache, GIT_CONTEXT_CACHE_CAPACITY);
  gitDirCache.set(worktreePath, info);
  return info;
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
  const { gitDir, commonDir } = resolveGitDir(worktreePath);
  if (gitDir === null) {
    // Best effort: fall back to stat'ing the dotgit entry. Better than
    // pinning forever on a stale cache when git is missing.
    return statKey("dotgit", join(worktreePath, ".git"));
  }

  const parts: string[] = [];

  // 1. Per-worktree HEAD — changes on checkout in this worktree.
  parts.push(statKey("head", join(gitDir, "HEAD")) ?? "head|missing");

  // 2. Resolved branch ref tip — changes on every commit on the current
  //    branch. For linked worktrees, refs/heads live under the commonDir.
  //    Detached HEAD has no symbolic ref; stat'ing HEAD above already
  //    covers SHA changes in that case.
  try {
    const headContent: string = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const symMatch = /^ref:\s*(.+)$/m.exec(headContent);
    if (symMatch) {
      const refPath: string = symMatch[1]!.trim();
      const refsRoot: string = commonDir ?? gitDir;
      const refTipKey: string | null =
        statKey("ref", join(refsRoot, refPath)) ?? statKey("packed", join(refsRoot, "packed-refs"));
      if (refTipKey !== null) {
        parts.push(refTipKey);
      }
    }
  } catch {
    // ignore — HEAD stat already captured above
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
    touchEntry(gitContextCache, worktreePath, cached);
    return { worktreePath: cached.worktreePath, branchName: cached.branchName, headSha: cached.headSha, persistedAt };
  }

  const branchName: string | null = runGit(["branch", "--show-current"], cwd);
  const headSha: string | null = runGit(["rev-parse", "HEAD"], cwd);

  const { gitDir } = resolveGitDir(worktreePath);
  const core: GitContextCore = { worktreePath, branchName, headSha, headStatKey, gitDir };
  evictLruIfNeeded(gitContextCache, GIT_CONTEXT_CACHE_CAPACITY);
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
