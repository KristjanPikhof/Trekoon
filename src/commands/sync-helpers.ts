import type { Database } from "bun:sqlite";

import { countBranchEventsSince } from "../sync/branch-db";
import { persistGitContext, resolveGitContext } from "../sync/git-context";
import type { GitContextSnapshot, SyncStatusSummary } from "../sync/types";
import type { TrekoonDatabase } from "../storage/database";

export const DEFAULT_SOURCE_BRANCH = "main";

export function countAheadLocal(db: Database, currentBranch: string | null, sourceBranch: string): number {
  if (!currentBranch || currentBranch === sourceBranch) {
    return 0;
  }

  const row = db
    .query(
      `
      SELECT COUNT(*) AS count
      FROM events
      WHERE git_branch = @branch;
      `,
    )
    .get({ "@branch": currentBranch }) as { count: number } | null;

  return row?.count ?? 0;
}

export function countPendingConflictsLocal(db: Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
    .get() as { count: number } | null;

  return row?.count ?? 0;
}

export function loadCursorLocal(
  db: Database,
  worktreePath: string,
  sourceBranch: string,
): { cursor_token: string } | null {
  return db
    .query(
      `
      SELECT cursor_token
      FROM sync_cursors
      WHERE owner_scope = 'worktree'
        AND owner_worktree_path = ?
        AND source_branch = ?
      LIMIT 1;
      `,
    )
    .get(worktreePath, sourceBranch) as { cursor_token: string } | null;
}

export function resolveSyncStatus(
  database: TrekoonDatabase,
  cwd: string,
  sourceBranch: string,
): SyncStatusSummary {
  const git: GitContextSnapshot = resolveGitContext(cwd);
  persistGitContext(database.db, git);

  const cursor = loadCursorLocal(database.db, git.worktreePath, sourceBranch);
  const cursorToken: string = cursor?.cursor_token ?? "0:";
  const onSourceBranch: boolean = git.branchName !== null && git.branchName === sourceBranch;

  return {
    sourceBranch,
    ahead: countAheadLocal(database.db, git.branchName, sourceBranch),
    behind: onSourceBranch ? 0 : countBranchEventsSince(database.db, sourceBranch, cursorToken),
    pendingConflicts: countPendingConflictsLocal(database.db),
    sameBranch: onSourceBranch,
    git,
  };
}
