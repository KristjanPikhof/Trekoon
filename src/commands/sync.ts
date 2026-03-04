import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { MissingBranchDatabaseError } from "../sync/branch-db";
import { getSyncConflict, listSyncConflicts, syncPull, syncResolve, syncStatus } from "../sync/service";
import { type SyncConflictMode, type SyncResolution } from "../sync/types";

function parseOption(args: readonly string[], option: string): string | null {
  const index: number = args.indexOf(option);
  if (index < 0) {
    return null;
  }

  const value: string | undefined = args[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function usage(message: string): CliResult {
  return failResult({
    command: "sync",
    human: `${message}\nUsage: trekoon sync <status|pull|resolve|conflicts> [options]`,
    data: { message },
    error: {
      code: "invalid_args",
      message,
    },
  });
}

function statusMessage(sourceBranch: string, ahead: number, behind: number, conflicts: number): string {
  return [
    `Sync status against '${sourceBranch}'`,
    `Ahead: ${ahead}`,
    `Behind: ${behind}`,
    `Pending conflicts: ${conflicts}`,
  ].join("\n");
}

function formatConflictList(
  conflicts: ReadonlyArray<{
    id: string;
    entity_kind: string;
    entity_id: string;
    field_name: string;
    resolution: string;
  }>,
): string {
  if (conflicts.length === 0) {
    return "No conflicts found.";
  }

  return conflicts
    .map((conflict) =>
      [
        conflict.id,
        conflict.entity_kind,
        conflict.entity_id,
        conflict.field_name,
        conflict.resolution,
      ].join(" | "),
    )
    .join("\n");
}

function parseConflictMode(args: readonly string[]): SyncConflictMode {
  const explicitMode = parseOption(args, "--mode");
  if (explicitMode === "all") {
    return "all";
  }

  return "pending";
}

export async function runSync(context: CliContext): Promise<CliResult> {
  const subcommand: string | undefined = context.args[0];

  if (!subcommand) {
    return usage("Missing sync subcommand.");
  }

  try {
    if (subcommand === "status") {
      const sourceBranch: string = parseOption(context.args, "--from") ?? "main";
      const summary = syncStatus(context.cwd, sourceBranch);

      return okResult({
        command: "sync status",
        human: statusMessage(summary.sourceBranch, summary.ahead, summary.behind, summary.pendingConflicts),
        data: summary,
      });
    }

    if (subcommand === "pull") {
      const sourceBranch: string | null = parseOption(context.args, "--from");
      if (!sourceBranch) {
        return usage("sync pull requires --from <branch>.");
      }

      const summary = syncPull(context.cwd, sourceBranch);

      return okResult({
        command: "sync pull",
        human: [
          `Pulled from '${summary.sourceBranch}'`,
          `Scanned events: ${summary.scannedEvents}`,
          `Applied events: ${summary.appliedEvents}`,
          `Created conflicts: ${summary.createdConflicts}`,
        ].join("\n"),
        data: summary,
      });
    }

    if (subcommand === "resolve") {
      const conflictId: string | undefined = context.args[1];
      const rawResolution: string | null = parseOption(context.args, "--use");

      if (!conflictId || !rawResolution) {
        return usage("sync resolve requires <conflict-id> --use ours|theirs.");
      }

      if (rawResolution !== "ours" && rawResolution !== "theirs") {
        return usage("sync resolve --use only accepts ours|theirs.");
      }

      const summary = syncResolve(context.cwd, conflictId, rawResolution as SyncResolution);

      return okResult({
        command: "sync resolve",
        human: `Resolved ${summary.conflictId} using ${summary.resolution}.`,
        data: summary,
      });
    }

    if (subcommand === "conflicts") {
      const conflictsCommand: string | undefined = context.args[1];
      if (!conflictsCommand) {
        return usage("sync conflicts requires list|show.");
      }

      if (conflictsCommand === "list") {
        const mode = parseConflictMode(context.args);
        const conflicts = listSyncConflicts(context.cwd, mode);

        return okResult({
          command: "sync conflicts list",
          human: formatConflictList(conflicts),
          data: {
            mode,
            conflicts,
          },
        });
      }

      if (conflictsCommand === "show") {
        const conflictId: string | undefined = context.args[2];
        if (!conflictId) {
          return usage("sync conflicts show requires <conflict-id>.");
        }

        const conflict = getSyncConflict(context.cwd, conflictId);

        return okResult({
          command: "sync conflicts show",
          human: [
            `Conflict: ${conflict.id}`,
            `Entity: ${conflict.entityKind} ${conflict.entityId}`,
            `Field: ${conflict.fieldName}`,
            `Resolution: ${conflict.resolution}`,
            `Ours: ${JSON.stringify(conflict.oursValue)}`,
            `Theirs: ${JSON.stringify(conflict.theirsValue)}`,
          ].join("\n"),
          data: {
            conflict,
          },
        });
      }

      return usage(`Unknown sync conflicts subcommand '${conflictsCommand}'.`);
    }

    return usage(`Unknown sync subcommand '${subcommand}'.`);
  } catch (error) {
    if (error instanceof MissingBranchDatabaseError) {
      return failResult({
        command: "sync",
        human: error.message,
        data: {
          reason: "missing_branch_db",
        },
        error: {
          code: "missing_branch_db",
          message: error.message,
        },
      });
    }

    const message = error instanceof Error ? error.message : "Unknown sync error.";

    return failResult({
      command: "sync",
      human: message,
      data: {
        reason: "sync_failed",
      },
      error: {
        code: "sync_failed",
        message,
      },
    });
  }
}
