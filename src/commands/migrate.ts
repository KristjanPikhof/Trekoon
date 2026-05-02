import { findUnknownOption, parseArgs, readMissingOptionValue, readOption } from "./arg-parser";
import { safeErrorMessage, sqliteBusyFailure } from "./error-utils";

import { DomainError } from "../domain/types";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { createMigrationBackup } from "../storage/backup";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import { describeMigrations, rollbackDatabase } from "../storage/migrations";

const MIGRATE_USAGE = "Usage: trekoon migrate <status|rollback|backup> [--to-version <n>]";

const STATUS_OPTIONS: readonly string[] = [];
const ROLLBACK_OPTIONS: readonly string[] = ["to-version"];
const BACKUP_OPTIONS: readonly string[] = [];

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

function unknownOptionResult(command: string, option: string): CliResult {
  const message = `Unknown option --${option}.`;
  return failResult({
    command,
    human: message,
    data: { option: `--${option}` },
    error: {
      code: "unknown_option",
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

  // The backup subcommand never opens the live DB through the standard
  // openTrekoonDatabase pathway: backups must work even when the DB is
  // in a partially-migrated or otherwise diagnostic-blocked state.
  if (subcommand === "backup") {
    const unknown = findUnknownOption(parsed, BACKUP_OPTIONS);
    if (unknown !== undefined) {
      return unknownOptionResult("migrate.backup", unknown);
    }

    try {
      const result = createMigrationBackup({ cwd: context.cwd });
      return okResult({
        command: "migrate.backup",
        human: [
          `Backed up Trekoon database to ${result.backupPath}`,
          `Bytes: ${result.bytes}`,
          `Schema version at backup: ${result.migrationVersion} of ${result.latestVersion}`,
        ].join("\n"),
        data: {
          backupPath: result.backupPath,
          bytes: result.bytes,
          migrationVersion: result.migrationVersion,
          latestVersion: result.latestVersion,
          timestamp: result.timestamp,
        },
      });
    } catch (error: unknown) {
      if (error instanceof DomainError) {
        return failResult({
          command: "migrate.backup",
          human: error.message,
          data: { code: error.code, ...(error.details ?? {}) },
          error: { code: error.code, message: error.message },
        });
      }

      const busyFailure = sqliteBusyFailure("migrate.backup", error);
      if (busyFailure !== null) {
        return busyFailure;
      }

      const message = safeErrorMessage(error, "Unknown backup failure.");
      return failResult({
        command: "migrate.backup",
        human: message,
        data: { reason: "backup_failed" },
        error: { code: "backup_failed", message },
      });
    }
  }

  let storage: TrekoonDatabase | undefined;

  try {
    storage = openTrekoonDatabase(context.cwd, { autoMigrate: false });
    if (subcommand === "status") {
      const unknown = findUnknownOption(parsed, STATUS_OPTIONS);
      if (unknown !== undefined) {
        return unknownOptionResult("migrate.status", unknown);
      }

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
      const unknown = findUnknownOption(parsed, ROLLBACK_OPTIONS);
      if (unknown !== undefined) {
        return unknownOptionResult("migrate.rollback", unknown);
      }

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
      try {
        const summary = rollbackDatabase(storage.db, targetVersion);

        return okResult({
          command: "migrate.rollback",
          human: [
            `Rolled back ${summary.rolledBack} migration(s).`,
            `From version ${summary.fromVersion} to ${summary.toVersion}.`,
          ].join("\n"),
          data: summary,
        });
      } catch (error: unknown) {
        if (error instanceof DomainError) {
          return failResult({
            command: "migrate.rollback",
            human: error.message,
            data: { code: error.code, ...(error.details ?? {}) },
            error: { code: error.code, message: error.message },
          });
        }
        throw error;
      }
    }

    return usage(`Unknown migrate subcommand '${subcommand}'.`);
  } catch (error: unknown) {
    const busyFailure = sqliteBusyFailure("migrate", error);
    if (busyFailure !== null) {
      return busyFailure;
    }

    const message = safeErrorMessage(error, "Unknown migration failure.");

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
    storage?.close();
  }
}
