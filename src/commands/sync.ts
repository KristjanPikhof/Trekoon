import { findUnknownOption, hasFlag, parseArgs, readMissingOptionValue, readOption, suggestOptions } from "./arg-parser";
import { safeErrorMessage, sqliteBusyFailure } from "./error-utils";

import { DomainError } from "../domain/types";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { resolveStorageResolutionDiagnostics } from "../storage/database";
import { assertValidSourceRef } from "../sync/branch-db";
import { getSyncConflict, listSyncConflicts, syncPull, syncResolve, syncResolvePreview, syncStatus } from "../sync/service";
import { type SyncResolution } from "../sync/types";

const STATUS_OPTIONS = ["from"] as const;
const PULL_OPTIONS = ["from"] as const;
const RESOLVE_OPTIONS = ["use", "dry-run"] as const;
const CONFLICTS_LIST_OPTIONS = ["mode"] as const;
const CONFLICTS_SHOW_OPTIONS: readonly string[] = [];

function resolveSyncCommandId(subcommand: string | undefined, conflictsSubcommand: string | undefined): string {
  if (subcommand === "status") {
    return "sync.status";
  }

  if (subcommand === "pull") {
    return "sync.pull";
  }

  if (subcommand === "resolve") {
    return "sync.resolve";
  }

  if (subcommand !== "conflicts") {
    return "sync";
  }

  if (conflictsSubcommand === "list") {
    return "sync.conflicts.list";
  }

  if (conflictsSubcommand === "show") {
    return "sync.conflicts.show";
  }

  return "sync.conflicts";
}

function usage(message: string, command = "sync"): CliResult {
  return failResult({
    command,
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

function formatDomainErrorHuman(message: string, details: Record<string, unknown> | undefined): string {
  const operatorAction = typeof details?.operatorAction === "string" ? details.operatorAction : null;
  return operatorAction ? `${message}\n${operatorAction}` : message;
}

function isStorageBootstrapError(code: string): boolean {
  return code === "tracked_ignored_mismatch" || code === "ambiguous_legacy_state" || code === "legacy_import_failed";
}

export async function runSync(context: CliContext): Promise<CliResult> {
  const parsed = parseArgs(context.args);
  const subcommand: string | undefined = parsed.positional[0];
  const conflictsSubcommand: string | undefined = subcommand === "conflicts" ? parsed.positional[1] : undefined;
  const resolvedCommand: string = resolveSyncCommandId(subcommand, conflictsSubcommand);

  if (!subcommand) {
    return usage("Missing sync subcommand.");
  }

  try {
    if (subcommand === "status") {
      const statusUnknownOption = findUnknownOption(parsed, STATUS_OPTIONS);
      if (statusUnknownOption !== undefined) {
        return unknownOption("sync.status", statusUnknownOption, STATUS_OPTIONS);
      }

      const missingFromOption = readMissingOptionValue(parsed.missingOptionValues, "from");
      if (missingFromOption !== undefined) {
        return usage("sync status requires --from <branch> when provided.", "sync.status");
      }

      const sourceBranch: string = readOption(parsed.options, "from") ?? "main";
      assertValidSourceRef(context.cwd, sourceBranch);
      const summary = syncStatus(context.cwd, sourceBranch);

      const humanLines = [statusMessage(summary.sourceBranch, summary.ahead, summary.behind, summary.pendingConflicts)];
      if (summary.sameBranch) {
        humanLines.push(`Same-branch mode: already on '${summary.sourceBranch}', no sync needed`);
      }

      return okResult({
        command: "sync.status",
        human: humanLines.join("\n"),
        data: summary,
      });
    }

    if (subcommand === "pull") {
      const pullUnknownOption = findUnknownOption(parsed, PULL_OPTIONS);
      if (pullUnknownOption !== undefined) {
        return unknownOption("sync.pull", pullUnknownOption, PULL_OPTIONS);
      }

      const missingFromOption = readMissingOptionValue(parsed.missingOptionValues, "from");
      if (missingFromOption !== undefined) {
        return usage("sync pull requires --from <branch>.", "sync.pull");
      }

      const sourceBranch: string | undefined = readOption(parsed.options, "from");
      if (sourceBranch === undefined) {
        return usage("sync pull requires --from <branch>.", "sync.pull");
      }

      assertValidSourceRef(context.cwd, sourceBranch);
      const summary = syncPull(context.cwd, sourceBranch);

      const humanLines = [
        `Pulled from '${summary.sourceBranch}'`,
        `Scanned events: ${summary.scannedEvents}`,
        `Applied events: ${summary.appliedEvents}`,
        `Created conflicts: ${summary.createdConflicts}`,
        `Malformed payloads: ${summary.diagnostics.malformedPayloadEvents}`,
        `Quarantined events: ${summary.diagnostics.quarantinedEvents}`,
        `Conflict events: ${summary.diagnostics.conflictEvents}`,
        ...summary.diagnostics.errorHints,
      ];
      if (summary.sameBranch) {
        humanLines.push(`Same-branch mode: already on '${summary.sourceBranch}', no sync needed`);
      }

      return okResult({
        command: "sync.pull",
        human: humanLines.join("\n"),
        data: summary,
      });
    }

    if (subcommand === "resolve") {
      const resolveUnknownOption = findUnknownOption(parsed, RESOLVE_OPTIONS);
      if (resolveUnknownOption !== undefined) {
        return unknownOption("sync.resolve", resolveUnknownOption, RESOLVE_OPTIONS);
      }

      const conflictId: string | undefined = parsed.positional[1];
      const missingResolutionOption = readMissingOptionValue(parsed.missingOptionValues, "use");
      if (missingResolutionOption !== undefined) {
        return usage("sync resolve requires <conflict-id> --use ours|theirs.", "sync.resolve");
      }

      const rawResolution: string | undefined = readOption(parsed.options, "use");

      if (!conflictId || !rawResolution) {
        return usage("sync resolve requires <conflict-id> --use ours|theirs.", "sync.resolve");
      }

      if (rawResolution !== "ours" && rawResolution !== "theirs") {
        return usage("sync resolve --use only accepts ours|theirs.", "sync.resolve");
      }

      const dryRun: boolean = hasFlag(parsed.flags, "dry-run");

      if (dryRun) {
        const preview = syncResolvePreview(context.cwd, conflictId, rawResolution as SyncResolution);

        return okResult({
          command: "sync.resolve",
          human: [
            `[dry-run] Would resolve ${preview.conflictId} using ${preview.resolution}.`,
            `Entity: ${preview.entityKind} ${preview.entityId}`,
            `Field: ${preview.fieldName}`,
            `Ours: ${JSON.stringify(preview.oursValue)}`,
            `Theirs: ${JSON.stringify(preview.theirsValue)}`,
            `Would write: ${JSON.stringify(preview.wouldWrite)}`,
          ].join("\n"),
          data: preview,
        });
      }

      const summary = syncResolve(context.cwd, conflictId, rawResolution as SyncResolution);

      return okResult({
        command: "sync.resolve",
        human: `Resolved ${summary.conflictId} using ${summary.resolution}.`,
        data: summary,
      });
    }

    if (subcommand === "conflicts") {
      const conflictsCommand: string | undefined = parsed.positional[1];
      if (!conflictsCommand) {
          return usage("sync conflicts requires list|show.", "sync.conflicts");
      }

      if (conflictsCommand === "list") {
        const listUnknownOption = findUnknownOption(parsed, CONFLICTS_LIST_OPTIONS);
        if (listUnknownOption !== undefined) {
          return unknownOption("sync.conflicts.list", listUnknownOption, CONFLICTS_LIST_OPTIONS);
        }

        const missingModeOption = readMissingOptionValue(parsed.missingOptionValues, "mode");
        if (missingModeOption !== undefined) {
            return usage("sync conflicts list --mode only accepts pending|all.", "sync.conflicts.list");
        }

        const mode = readOption(parsed.options, "mode") ?? "pending";
        if (mode !== "pending" && mode !== "all") {
            return usage("sync conflicts list --mode only accepts pending|all.", "sync.conflicts.list");
        }

        const conflicts = listSyncConflicts(context.cwd, mode);

        return okResult({
          command: "sync.conflicts.list",
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
          return unknownOption("sync.conflicts.show", showUnknownOption, CONFLICTS_SHOW_OPTIONS);
        }

        const conflictId: string | undefined = parsed.positional[2];
          if (!conflictId) {
            return usage("sync conflicts show requires <conflict-id>.", "sync.conflicts.show");
          }

        const conflict = getSyncConflict(context.cwd, conflictId);

        return okResult({
          command: "sync.conflicts.show",
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

        return usage(`Unknown sync conflicts subcommand '${conflictsCommand}'.`, "sync.conflicts");
    }

    return usage(`Unknown sync subcommand '${subcommand}'.`);
  } catch (error) {
    const busyFailure = sqliteBusyFailure(resolvedCommand, error);
    if (busyFailure !== null) {
      return busyFailure;
    }

    if (error instanceof DomainError) {
      if (isStorageBootstrapError(error.code)) {
        const storageDiagnostics = resolveStorageResolutionDiagnostics(context.cwd);

        return failResult({
          command: resolvedCommand,
          human: formatDomainErrorHuman(error.message, error.details),
          data: {
            reason: "storage_bootstrap_blocked",
            ...storageDiagnostics,
          },
          error: {
            code: error.code,
            message: error.message,
          },
        });
      }

      return failResult({
        command: resolvedCommand,
        human: formatDomainErrorHuman(error.message, error.details),
        data: {
          ...(error.details ?? {}),
          reason: error.code,
        },
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    const message = safeErrorMessage(error, "Unknown sync error.");

    return failResult({
      command: resolvedCommand,
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
