import { parseArgs, readMissingOptionValue, readOption } from "./arg-parser";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";
import { describeMigrations, rollbackDatabase } from "../storage/migrations";

const MIGRATE_USAGE = "Usage: trekoon migrate <status|rollback> [--to-version <n>]";

function usage(message: string): CliResult {
  return failResult({
    command: "migrate",
    human: `${message}\n${MIGRATE_USAGE}`,
    data: { message },
    error: {
      code: "invalid_args",
      message,
    },
  });
}

function parseVersion(rawValue: string | undefined): number | null {
  if (rawValue === undefined) {
    return null;
  }

  if (!/^\d+$/.test(rawValue)) {
    return Number.NaN;
  }

  return Number.parseInt(rawValue, 10);
}

export async function runMigrate(context: CliContext): Promise<CliResult> {
  const parsed = parseArgs(context.args);
  const subcommand: string | undefined = parsed.positional[0];

  if (!subcommand) {
    return usage("Missing migrate subcommand.");
  }

  const missingOption = readMissingOptionValue(parsed.missingOptionValues, "to-version");
  if (missingOption !== undefined) {
    return failResult({
      command: "migrate",
      human: `Option --${missingOption} requires a value.`,
      data: {
        option: missingOption,
      },
      error: {
        code: "invalid_input",
        message: `Option --${missingOption} requires a value.`,
      },
    });
  }

  const storage = openTrekoonDatabase(context.cwd, { autoMigrate: false });

  try {
    if (subcommand === "status") {
      const status = describeMigrations(storage.db);

      return okResult({
        command: "migrate.status",
        human: [
          `Current version: ${status.currentVersion}`,
          `Latest version: ${status.latestVersion}`,
          `Pending migrations: ${status.pending.length}`,
        ].join("\n"),
        data: status,
      });
    }

    if (subcommand === "rollback") {
      const status = describeMigrations(storage.db);
      const parsedVersion: number | null = parseVersion(readOption(parsed.options, "to-version"));

      if (Number.isNaN(parsedVersion)) {
        return failResult({
          command: "migrate.rollback",
          human: "--to-version must be a non-negative integer.",
          data: {
            option: "to-version",
          },
          error: {
            code: "invalid_input",
            message: "--to-version must be a non-negative integer.",
          },
        });
      }

      const targetVersion: number = parsedVersion ?? Math.max(0, status.currentVersion - 1);
      const summary = rollbackDatabase(storage.db, targetVersion);

      return okResult({
        command: "migrate.rollback",
        human: [
          `Rolled back ${summary.rolledBack} migration(s).`,
          `From version ${summary.fromVersion} to ${summary.toVersion}.`,
        ].join("\n"),
        data: summary,
      });
    }

    return usage(`Unknown migrate subcommand '${subcommand}'.`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unknown migration failure.";

    return failResult({
      command: "migrate",
      human: message,
      data: {
        reason: "migrate_failed",
      },
      error: {
        code: "migrate_failed",
        message,
      },
    });
  } finally {
    storage.close();
  }
}
