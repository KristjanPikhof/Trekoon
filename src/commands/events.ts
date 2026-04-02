import { hasFlag, parseArgs, parseStrictPositiveInt, readMissingOptionValue, readOption } from "./arg-parser";
import { safeErrorMessage, sqliteBusyFailure } from "./error-utils";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import { DEFAULT_EVENT_RETENTION_DAYS, pruneEvents } from "../storage/events-retention";

const EVENTS_USAGE = "Usage: trekoon events prune [--dry-run] [--archive] [--retention-days <n>]";

function usage(message: string): CliResult {
  return failResult({
    command: "events",
    human: `${message}\n${EVENTS_USAGE}`,
    data: { message },
    error: {
      code: "invalid_args",
      message,
    },
  });
}

function invalidInput(command: string, message: string, option: string): CliResult {
  return failResult({
    command,
    human: message,
    data: {
      option,
    },
    error: {
      code: "invalid_input",
      message,
    },
  });
}

export async function runEvents(context: CliContext): Promise<CliResult> {
  const parsed = parseArgs(context.args);
  const subcommand: string | undefined = parsed.positional[0];

  if (!subcommand) {
    return usage("Missing events subcommand.");
  }

  if (subcommand !== "prune") {
    return usage(`Unknown events subcommand '${subcommand}'.`);
  }

  if (parsed.positional.length > 1) {
    return usage("Unexpected positional arguments for events prune.");
  }

  const missingOption: string | undefined = readMissingOptionValue(parsed.missingOptionValues, "retention-days");
  if (missingOption !== undefined) {
    return invalidInput("events.prune", `Option --${missingOption} requires a value.`, missingOption);
  }

  const parsedRetentionDays: number | undefined = parseStrictPositiveInt(readOption(parsed.options, "retention-days"));
  if (Number.isNaN(parsedRetentionDays)) {
    return invalidInput("events.prune", "--retention-days must be a positive integer.", "retention-days");
  }

  const retentionDays: number = parsedRetentionDays ?? DEFAULT_EVENT_RETENTION_DAYS;
  const dryRun: boolean = hasFlag(parsed.flags, "dry-run");
  const archive: boolean = hasFlag(parsed.flags, "archive");
  let storage: TrekoonDatabase | undefined;

  try {
    storage = openTrekoonDatabase(context.cwd);
    const summary = pruneEvents(storage.db, {
      retentionDays,
      dryRun,
      archive,
    });

      return okResult({
        command: "events.prune",
        human: [
          dryRun ? "Dry run complete." : "Prune complete.",
          `Retention days: ${summary.retentionDays}`,
          `Candidates: ${summary.candidateCount}`,
          `Archived: ${summary.archivedCount}`,
          `Deleted: ${summary.deletedCount}`,
          summary.staleCursorCount > 0
            ? `Sync guidance: ${summary.staleCursorCount} cursor(s) reference pruned history. Run 'trekoon sync pull --from <branch>' and rebuild if stale cursor hints persist.`
            : "Sync guidance: pruning stayed within retained cursor history.",
          archive
            ? "Retention automation: archived copies were kept before deletion."
            : "Retention automation: rerun with --archive to keep retained copies before deletion.",
        ].join("\n"),
        data: summary,
      });
  } catch (error: unknown) {
    const busyFailure = sqliteBusyFailure("events.prune", error);
    if (busyFailure !== null) {
      return busyFailure;
    }

    const message = safeErrorMessage(error, "Unknown events prune failure.");
    return failResult({
      command: "events.prune",
      human: message,
      data: {
        reason: "events_failed",
      },
      error: {
        code: "events_failed",
        message,
      },
    });
  } finally {
    storage?.close();
  }
}
