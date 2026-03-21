import { parseArgs, readOption } from "./arg-parser";
import { unexpectedFailureResult } from "./error-utils";
import { resolveSyncStatus } from "./sync-helpers";
import { buildTaskReadiness, type TaskReadinessResult } from "./task-readiness";

import { TrackerDomain } from "../domain/tracker-domain";
import { VALID_TRANSITIONS, type EpicRecord, type ValidStatus } from "../domain/types";
import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import type { SyncStatusSummary } from "../sync/types";

const DEFAULT_SOURCE_BRANCH = "main";
const MAX_SUGGESTIONS = 3;

type SuggestionCategory = "recovery" | "sync" | "execution" | "planning";

interface Suggestion {
  readonly priority: number;
  readonly action: string;
  readonly command: string;
  readonly reason: string;
  readonly category: SuggestionCategory;
}

interface SuggestContext {
  readonly totalEpics: number;
  readonly activeEpic: string | null;
  readonly readyTasks: number;
  readonly blockedTasks: number;
  readonly inProgressTasks: number;
  readonly syncBehind: number;
  readonly pendingConflicts: number;
}

interface SuggestResult {
  readonly suggestions: readonly Suggestion[];
  readonly context: SuggestContext;
}

function resolveActiveEpic(domain: TrackerDomain, epicId: string | undefined): EpicRecord | null {
  if (epicId !== undefined) {
    return domain.getEpic(epicId);
  }

  const epics = domain.listEpics();
  const inProgress = epics.find((epic) => epic.status === "in_progress");
  if (inProgress) {
    return inProgress;
  }

  const todo = epics.find((epic) => epic.status === "todo");
  return todo ?? epics[0] ?? null;
}

function countInProgressTasks(readiness: TaskReadinessResult): number {
  const allCandidates = [
    ...readiness.candidates,
    ...readiness.blocked,
  ];

  return allCandidates
    .filter((candidate) => candidate.task.status === "in_progress")
    .length;
}

function getFirstInProgressTask(readiness: TaskReadinessResult): { id: string; title: string } | null {
  const allCandidates = [
    ...readiness.candidates,
    ...readiness.blocked,
  ];

  const inProgress = allCandidates.find((candidate) => candidate.task.status === "in_progress");
  if (!inProgress) {
    return null;
  }

  return { id: inProgress.task.id, title: inProgress.task.title };
}

function buildSuggestions(
  recoveryRequired: boolean,
  syncSummary: SyncStatusSummary,
  readiness: TaskReadinessResult,
  epics: readonly EpicRecord[],
  activeEpic: EpicRecord | null,
): readonly Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Priority 1: Recovery required
  if (recoveryRequired) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: "init",
      command: "trekoon --toon init",
      reason: "Storage needs repair — run init to recover",
      category: "recovery",
    });
  }

  // Priority 2: Pending conflicts
  if (suggestions.length < MAX_SUGGESTIONS && syncSummary.pendingConflicts > 0) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: "sync conflicts",
      command: "trekoon --toon sync conflicts",
      reason: `${syncSummary.pendingConflicts} unresolved sync conflict${syncSummary.pendingConflicts === 1 ? "" : "s"} blocking accurate state`,
      category: "sync",
    });
  }

  // Priority 3: Sync behind
  if (suggestions.length < MAX_SUGGESTIONS && syncSummary.behind > 0) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: `sync pull --from ${syncSummary.sourceBranch}`,
      command: `trekoon --toon sync pull --from ${syncSummary.sourceBranch}`,
      reason: `${syncSummary.behind} event${syncSummary.behind === 1 ? "" : "s"} behind ${syncSummary.sourceBranch} branch`,
      category: "sync",
    });
  }

  // Priority 4: In-progress tasks exist
  const inProgressTask = getFirstInProgressTask(readiness);
  if (suggestions.length < MAX_SUGGESTIONS && inProgressTask !== null) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: `continue task ${inProgressTask.id}`,
      command: `trekoon --toon task show ${inProgressTask.id}`,
      reason: `In-progress task: ${inProgressTask.title}`,
      category: "execution",
    });
  }

  // Priority 5: Ready tasks available
  const topReady = readiness.candidates.find((c) => c.task.status !== "in_progress");
  if (suggestions.length < MAX_SUGGESTIONS && topReady) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: `claim task ${topReady.task.id}`,
      command: `trekoon --toon task update ${topReady.task.id} --status in_progress`,
      reason: `Highest priority ready task: ${topReady.task.title}`,
      category: "execution",
    });
  }

  // Priority 6: All tasks blocked
  if (
    suggestions.length < MAX_SUGGESTIONS
    && readiness.summary.totalOpenTasks > 0
    && readiness.summary.readyCount === 0
    && inProgressTask === null
  ) {
    const blockerCount = readiness.summary.unresolvedDependencyCount;
    suggestions.push({
      priority: suggestions.length + 1,
      action: "review blocked tasks",
      command: "trekoon --toon task ready",
      reason: `All ${readiness.summary.blockedCount} open task${readiness.summary.blockedCount === 1 ? " is" : "s are"} blocked by ${blockerCount} unresolved dependenc${blockerCount === 1 ? "y" : "ies"}`,
      category: "planning",
    });
  }

  // Priority 7: All tasks done (epic still open)
  if (
    suggestions.length < MAX_SUGGESTIONS
    && activeEpic !== null
    && readiness.summary.totalOpenTasks === 0
    && activeEpic.status !== "done"
  ) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: `mark epic ${activeEpic.id} done`,
      command: `trekoon --toon epic update ${activeEpic.id} --status done`,
      reason: `All tasks complete — mark epic "${activeEpic.title}" as done`,
      category: "planning",
    });
  }

  // Priority 8: No epics exist
  if (suggestions.length < MAX_SUGGESTIONS && epics.length === 0) {
    suggestions.push({
      priority: suggestions.length + 1,
      action: "quickstart",
      command: "trekoon --toon quickstart",
      reason: "No epics found — create your first epic with quickstart",
      category: "planning",
    });
  }

  return suggestions.slice(0, MAX_SUGGESTIONS);
}

function formatSuggestHuman(result: SuggestResult): string {
  const lines: string[] = [];

  if (result.suggestions.length === 0) {
    lines.push("No suggestions — tracker state looks good.");
    return lines.join("\n");
  }

  lines.push("=== Suggestions ===");
  for (const suggestion of result.suggestions) {
    lines.push(`${suggestion.priority}. [${suggestion.category}] ${suggestion.action}`);
    lines.push(`   Reason: ${suggestion.reason}`);
    lines.push(`   Command: ${suggestion.command}`);
  }

  lines.push("");
  lines.push("=== Context ===");
  lines.push(`Epics: ${result.context.totalEpics}`);
  if (result.context.activeEpic !== null) {
    lines.push(`Active epic: ${result.context.activeEpic}`);
  }
  lines.push(`Ready tasks: ${result.context.readyTasks}`);
  lines.push(`Blocked tasks: ${result.context.blockedTasks}`);
  lines.push(`In-progress tasks: ${result.context.inProgressTasks}`);
  lines.push(`Sync behind: ${result.context.syncBehind}`);
  lines.push(`Pending conflicts: ${result.context.pendingConflicts}`);

  return lines.join("\n");
}

export async function runSuggest(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    const parsed = parseArgs(context.args);
    const epicId: string | undefined = readOption(parsed.options, "epic");

    database = openTrekoonDatabase(context.cwd);
    const diagnostics = database.diagnostics;

    const syncSummary = resolveSyncStatus(database, context.cwd, DEFAULT_SOURCE_BRANCH);
    const domain = new TrackerDomain(database.db);
    const epics = domain.listEpics();
    const activeEpic = resolveActiveEpic(domain, epicId);

    const readiness = buildTaskReadiness(domain, epicId ?? activeEpic?.id);

    const suggestions = buildSuggestions(
      diagnostics.recoveryRequired,
      syncSummary,
      readiness,
      epics,
      activeEpic,
    );

    const result: SuggestResult = {
      suggestions,
      context: {
        totalEpics: epics.length,
        activeEpic: activeEpic?.id ?? null,
        readyTasks: readiness.summary.readyCount,
        blockedTasks: readiness.summary.blockedCount,
        inProgressTasks: countInProgressTasks(readiness),
        syncBehind: syncSummary.behind,
        pendingConflicts: syncSummary.pendingConflicts,
      },
    };

    return okResult({
      command: "suggest",
      human: formatSuggestHuman(result),
      data: result,
    });
  } catch (error: unknown) {
    return unexpectedFailureResult(error, {
      command: "suggest",
      human: "Unexpected suggest command failure",
    });
  } finally {
    database?.close();
  }
}
