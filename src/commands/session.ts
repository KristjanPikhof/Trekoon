import { parseArgs, readOption } from "./arg-parser";
import { unexpectedFailureResult } from "./error-utils";
import { DEFAULT_SOURCE_BRANCH, resolveSyncStatus } from "./sync-helpers";
import { buildTaskReadiness, type DependencyBlocker } from "./task-readiness";

import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
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

type ItemKind = "epic" | "task" | "subtask";

interface ItemEnvelope {
  readonly id: string;
  readonly kind: ItemKind;
  readonly parentEpicId: string;
  readonly entity: unknown;
  readonly readiness: SessionReadiness;
  readonly suggestedNext: string;
}

interface ItemSessionResult {
  readonly diagnostics: SessionResult["diagnostics"];
  readonly sync: SessionResult["sync"];
  readonly item: ItemEnvelope;
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

function formatItemHuman(result: ItemSessionResult): string {
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
  lines.push("=== Item ===");
  lines.push(`${result.item.id} | kind=${result.item.kind} | epic=${result.item.parentEpicId}`);

  lines.push("");
  lines.push("=== Readiness (epic-scoped) ===");
  lines.push(`Ready: ${result.item.readiness.readyCount}`);
  lines.push(`Blocked: ${result.item.readiness.blockedCount}`);

  lines.push("");
  lines.push("=== Suggested Next ===");
  lines.push(result.item.suggestedNext);

  return lines.join("\n");
}

function resolveItem(
  domain: TrackerDomain,
  id: string,
): { kind: ItemKind; parentEpicId: string; entity: unknown } | null {
  const epic = domain.getEpic(id);
  if (epic !== null) {
    return {
      kind: "epic",
      parentEpicId: epic.id,
      entity: domain.buildEpicTreeDetailed(epic.id),
    };
  }

  const task = domain.getTask(id);
  if (task !== null) {
    return {
      kind: "task",
      parentEpicId: task.epicId,
      entity: domain.buildTaskTreeDetailed(task.id),
    };
  }

  const subtask = domain.getSubtask(id);
  if (subtask !== null) {
    const parentTask = domain.getTask(subtask.taskId);
    const parentEpicId = parentTask?.epicId ?? "";
    return {
      kind: "subtask",
      parentEpicId,
      entity: subtask,
    };
  }

  return null;
}

function suggestNextCommand(kind: ItemKind, id: string, parentEpicId: string): string {
  switch (kind) {
    case "epic":
      return `trekoon --toon epic progress ${id}`;
    case "task":
      return `trekoon --toon task claim ${id} --owner <TODO_OWNER>`;
    case "subtask":
      return `trekoon --toon session --epic ${parentEpicId}`;
  }
}

export async function runSession(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    const parsed = parseArgs(context.args);
    const epicId: string | undefined = readOption(parsed.options, "epic");
    const itemId: string | undefined = readOption(parsed.options, "item");

    database = openTrekoonDatabase(context.cwd);
    const diagnostics = database.diagnostics;

    const syncSummary = resolveSyncStatus(database, context.cwd, DEFAULT_SOURCE_BRANCH);
    const domain = new TrackerDomain(database.db);

    if (itemId !== undefined) {
      const resolved = resolveItem(domain, itemId);
      if (resolved === null) {
        return failResult({
          command: "session",
          human: `No epic, task, or subtask matches id ${itemId}`,
          data: { code: "not_found", id: itemId },
          error: {
            code: "not_found",
            message: `No epic, task, or subtask matches id ${itemId}`,
          },
        });
      }

      const scopedReadiness = resolved.parentEpicId.length > 0
        ? buildTaskReadiness(domain, resolved.parentEpicId)
        : buildTaskReadiness(domain, undefined);

      const result: ItemSessionResult = {
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
        item: {
          id: itemId,
          kind: resolved.kind,
          parentEpicId: resolved.parentEpicId,
          entity: resolved.entity,
          readiness: {
            readyCount: scopedReadiness.summary.readyCount,
            blockedCount: scopedReadiness.summary.blockedCount,
          },
          suggestedNext: suggestNextCommand(resolved.kind, itemId, resolved.parentEpicId),
        },
      };

      return okResult({
        command: "session",
        human: formatItemHuman(result),
        data: result,
      });
    }

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
