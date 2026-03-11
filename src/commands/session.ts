import { unexpectedFailureResult } from "./error-utils";
import { buildTaskReadiness, type DependencyBlocker } from "./task-readiness";

import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError } from "../domain/types";
import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import { countBranchEventsSince } from "../sync/branch-db";
import { persistGitContext, resolveGitContext } from "../sync/git-context";
import { type GitContextSnapshot, type SyncStatusSummary } from "../sync/types";

const DEFAULT_SOURCE_BRANCH = "main";

interface SessionReadiness {
  readonly readyCount: number;
  readonly blockedCount: number;
}

interface NextCandidate {
  readonly id: string;
  readonly epicId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly subtasks: ReadonlyArray<{
    readonly id: string;
    readonly taskId: string;
    readonly title: string;
    readonly description: string;
    readonly status: string;
  }>;
}

interface SessionResult {
  readonly diagnostics: {
    readonly storageMode: string;
    readonly recoveryRequired: boolean;
    readonly recoveryStatus: string;
  };
  readonly sync: {
    readonly ahead: number;
    readonly behind: number;
    readonly pendingConflicts: number;
    readonly git: GitContextSnapshot;
  };
  readonly next: NextCandidate | null;
  readonly nextDeps: ReadonlyArray<DependencyBlocker>;
  readonly readiness: SessionReadiness;
}

function countAheadLocal(db: import("bun:sqlite").Database, currentBranch: string | null, sourceBranch: string): number {
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

function countPendingConflictsLocal(db: import("bun:sqlite").Database): number {
  const row = db
    .query("SELECT COUNT(*) AS count FROM sync_conflicts WHERE resolution = 'pending';")
    .get() as { count: number } | null;

  return row?.count ?? 0;
}

function loadCursorLocal(
  db: import("bun:sqlite").Database,
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

function resolveSyncStatus(
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


function formatSessionHuman(result: SessionResult): string {
  const lines: string[] = [];

  lines.push("=== Session ===");
  lines.push(`Storage mode: ${result.diagnostics.storageMode}`);
  lines.push(`Recovery required: ${result.diagnostics.recoveryRequired}`);
  lines.push(`Recovery status: ${result.diagnostics.recoveryStatus}`);

  lines.push("");
  lines.push("=== Sync ===");
  lines.push(`Source branch: ${DEFAULT_SOURCE_BRANCH}`);
  lines.push(`Ahead: ${result.sync.ahead}`);
  lines.push(`Behind: ${result.sync.behind}`);
  lines.push(`Pending conflicts: ${result.sync.pendingConflicts}`);
  lines.push(`Branch: ${result.sync.git.branchName ?? "(detached)"}`);

  lines.push("");
  lines.push("=== Readiness ===");
  lines.push(`Ready: ${result.readiness.readyCount}`);
  lines.push(`Blocked: ${result.readiness.blockedCount}`);

  lines.push("");
  lines.push("=== Next Task ===");
  if (result.next === null) {
    lines.push("No ready tasks.");
  } else {
    lines.push(`${result.next.id} | epic=${result.next.epicId} | ${result.next.title} | ${result.next.status}`);
    lines.push(`Description: ${result.next.description}`);
    if (result.next.subtasks.length > 0) {
      lines.push("Subtasks:");
      for (const subtask of result.next.subtasks) {
        lines.push(`  ${subtask.id} | ${subtask.title} | ${subtask.status}`);
      }
    } else {
      lines.push("Subtasks: none");
    }
  }

  lines.push("");
  lines.push("=== Next Task Deps ===");
  if (result.nextDeps.length === 0) {
    lines.push("No blockers.");
  } else {
    for (const dep of result.nextDeps) {
      lines.push(`${dep.id} | kind=${dep.kind} | status=${dep.status}`);
    }
  }

  return lines.join("\n");
}

export async function runSession(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    database = openTrekoonDatabase(context.cwd);
    const diagnostics = database.diagnostics;

    const syncSummary = resolveSyncStatus(database, context.cwd, DEFAULT_SOURCE_BRANCH);
    const domain = new TrackerDomain(database.db);
    const readiness = buildTaskReadiness(domain, undefined);
    const topCandidate = readiness.candidates[0] ?? null;

    let nextTask: NextCandidate | null = null;
    if (topCandidate !== null) {
      const tree = domain.buildTaskTreeDetailed(topCandidate.task.id);
      nextTask = tree;
    }

    const result: SessionResult = {
      diagnostics: {
        storageMode: diagnostics.storageMode,
        recoveryRequired: diagnostics.recoveryRequired,
        recoveryStatus: diagnostics.recoveryStatus,
      },
      sync: {
        ahead: syncSummary.ahead,
        behind: syncSummary.behind,
        pendingConflicts: syncSummary.pendingConflicts,
        git: syncSummary.git,
      },
      next: nextTask,
      nextDeps: readinessInfo.nextTaskBlockers,
      readiness: {
        readyCount: readinessInfo.readyCount,
        blockedCount: readinessInfo.blockedCount,
      },
    };

    return okResult({
      command: "session",
      human: formatSessionHuman(result),
      data: result,
    });
  } catch (error: unknown) {
    return unexpectedFailureResult(error, {
      command: "session",
      human: "Unexpected session command failure",
    });
  } finally {
    database?.close();
  }
}
