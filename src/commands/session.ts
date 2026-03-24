import { parseArgs, readOption } from "./arg-parser";
import { unexpectedFailureResult } from "./error-utils";
import { DEFAULT_SOURCE_BRANCH, resolveSyncStatus } from "./sync-helpers";
import { buildTaskReadiness, type DependencyBlocker } from "./task-readiness";

import { TrackerDomain } from "../domain/tracker-domain";
import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import { pruneEvents, pruneResolvedConflicts } from "../storage/events-retention";
import { type GitContextSnapshot } from "../sync/types";

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
    readonly prunedEvents: number;
    readonly prunedConflicts: number;
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


function formatSessionHuman(result: SessionResult): string {
  const lines: string[] = [];

  lines.push("=== Session ===");
  lines.push(`Storage mode: ${result.diagnostics.storageMode}`);
  lines.push(`Recovery required: ${result.diagnostics.recoveryRequired}`);
  lines.push(`Recovery status: ${result.diagnostics.recoveryStatus}`);
  lines.push(`Pruned events: ${result.diagnostics.prunedEvents}`);
  lines.push(`Pruned conflicts: ${result.diagnostics.prunedConflicts}`);

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
    const parsed = parseArgs(context.args);
    const epicId: string | undefined = readOption(parsed.options, "epic");

    database = openTrekoonDatabase(context.cwd);
    const diagnostics = database.diagnostics;

    const eventPruneSummary = pruneEvents(database.db, { archive: false });
    const conflictPruneSummary = pruneResolvedConflicts(database.db);

    const syncSummary = resolveSyncStatus(database, context.cwd, DEFAULT_SOURCE_BRANCH);
    const domain = new TrackerDomain(database.db);
    const readiness = buildTaskReadiness(domain, epicId);
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
        prunedEvents: eventPruneSummary.deletedCount,
        prunedConflicts: conflictPruneSummary.deletedCount,
      },
      sync: {
        ahead: syncSummary.ahead,
        behind: syncSummary.behind,
        pendingConflicts: syncSummary.pendingConflicts,
        git: syncSummary.git,
      },
      next: nextTask,
      nextDeps: topCandidate?.blockerSummary.blockedBy ?? [],
      readiness: {
        readyCount: readiness.summary.readyCount,
        blockedCount: readiness.summary.blockedCount,
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
