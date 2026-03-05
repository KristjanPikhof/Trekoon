import { findUnknownOption, parseArgs, readMissingOptionValue, readOption, suggestOptions } from "./arg-parser";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { MissingBranchDatabaseError } from "../sync/branch-db";
import { getSyncConflict, listSyncConflicts, syncPull, syncResolve, syncStatus } from "../sync/service";
import { type SyncResolution } from "../sync/types";

const STATUS_OPTIONS = ["from"] as const;
const PULL_OPTIONS = ["from"] as const;
const RESOLVE_OPTIONS = ["use"] as const;
const CONFLICTS_LIST_OPTIONS = ["mode"] as const;
const CONFLICTS_SHOW_OPTIONS: readonly string[] = [];

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

function prefixedOptions(options: readonly string[]): string[] {
  return options.map((option) => `--${option}`);
}

function unknownOption(command: string, option: string, allowedOptions: readonly string[]): CliResult {
  const suggestions = suggestOptions(option, allowedOptions).map((suggestion) => `--${suggestion}`);
  const suggestionMessage = suggestions.length > 0 ? ` Did you mean ${suggestions.join(" or ")}?` : "";
  return failResult({
    command,
    human: `Unknown option --${option}.${suggestionMessage}`,
    data: {
      option: `--${option}`,
      allowedOptions: prefixedOptions(allowedOptions),
      suggestions,
    },
    error: {
      code: "unknown_option",
      message: `Unknown option --${option}`,
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

export async function runSync(context: CliContext): Promise<CliResult> {
  const parsed = parseArgs(context.args);
  const subcommand: string | undefined = parsed.positional[0];

  if (!subcommand) {
    return usage("Missing sync subcommand.");
  }

  try {
    if (subcommand === "status") {
      const statusUnknownOption = findUnknownOption(parsed, STATUS_OPTIONS);
      if (statusUnknownOption !== undefined) {
        return unknownOption("sync status", statusUnknownOption, STATUS_OPTIONS);
      }

      const missingFromOption = readMissingOptionValue(parsed.missingOptionValues, "from");
      if (missingFromOption !== undefined) {
        return usage("sync status requires --from <branch> when provided.");
      }

      const sourceBranch: string = readOption(parsed.options, "from") ?? "main";
      const summary = syncStatus(context.cwd, sourceBranch);

      return okResult({
        command: "sync status",
        human: statusMessage(summary.sourceBranch, summary.ahead, summary.behind, summary.pendingConflicts),
        data: summary,
      });
    }

    if (subcommand === "pull") {
      const pullUnknownOption = findUnknownOption(parsed, PULL_OPTIONS);
      if (pullUnknownOption !== undefined) {
        return unknownOption("sync pull", pullUnknownOption, PULL_OPTIONS);
      }

      const missingFromOption = readMissingOptionValue(parsed.missingOptionValues, "from");
      if (missingFromOption !== undefined) {
        return usage("sync pull requires --from <branch>.");
      }

      const sourceBranch: string | undefined = readOption(parsed.options, "from");
      if (sourceBranch === undefined) {
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
          `Malformed payloads: ${summary.diagnostics.malformedPayloadEvents}`,
          `Quarantined events: ${summary.diagnostics.quarantinedEvents}`,
          `Conflict events: ${summary.diagnostics.conflictEvents}`,
          ...summary.diagnostics.errorHints,
        ].join("\n"),
        data: summary,
      });
    }

    if (subcommand === "resolve") {
      const resolveUnknownOption = findUnknownOption(parsed, RESOLVE_OPTIONS);
      if (resolveUnknownOption !== undefined) {
        return unknownOption("sync resolve", resolveUnknownOption, RESOLVE_OPTIONS);
      }

      const conflictId: string | undefined = parsed.positional[1];
      const missingResolutionOption = readMissingOptionValue(parsed.missingOptionValues, "use");
      if (missingResolutionOption !== undefined) {
        return usage("sync resolve requires <conflict-id> --use ours|theirs.");
      }

      const rawResolution: string | undefined = readOption(parsed.options, "use");

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
      const conflictsCommand: string | undefined = parsed.positional[1];
      if (!conflictsCommand) {
        return usage("sync conflicts requires list|show.");
      }

      if (conflictsCommand === "list") {
        const listUnknownOption = findUnknownOption(parsed, CONFLICTS_LIST_OPTIONS);
        if (listUnknownOption !== undefined) {
          return unknownOption("sync conflicts list", listUnknownOption, CONFLICTS_LIST_OPTIONS);
        }

        const missingModeOption = readMissingOptionValue(parsed.missingOptionValues, "mode");
        if (missingModeOption !== undefined) {
          return usage("sync conflicts list --mode only accepts pending|all.");
        }

        const mode = readOption(parsed.options, "mode") ?? "pending";
        if (mode !== "pending" && mode !== "all") {
          return usage("sync conflicts list --mode only accepts pending|all.");
        }

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
        const showUnknownOption = findUnknownOption(parsed, CONFLICTS_SHOW_OPTIONS);
        if (showUnknownOption !== undefined) {
          return unknownOption("sync conflicts show", showUnknownOption, CONFLICTS_SHOW_OPTIONS);
        }

        const conflictId: string | undefined = parsed.positional[2];
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
