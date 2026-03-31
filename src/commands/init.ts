import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { unexpectedFailureResult } from "./error-utils";

import { ensureBoardInstalled } from "../board/install";
import { BoardInstallError } from "../board/types";
import { DomainError } from "../domain/types";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import { type StorageMode } from "../storage/path";

type GitignoreAction = "created" | "already_exists" | "skipped";

const GITIGNORE_CONTENT = "*\n";

function buildRecoverySummary(database: TrekoonDatabase): string[] {
  const diagnostics = database.diagnostics;
  const lines: string[] = [];

  if (diagnostics.recoveryStatus === "no_legacy_state") {
    lines.push("Recovery status: no legacy worktree-local state detected.");
    return lines;
  }

  if (diagnostics.recoveryStatus === "safe_auto_migrate") {
    if (diagnostics.autoMigratedLegacyState) {
      lines.push("Recovery status: safe auto-migrate completed.");
      lines.push(`Imported from: ${diagnostics.importedFromLegacyDatabase}`);
      lines.push(`Backups created: ${diagnostics.backupFiles.join(", ")}`);
    } else {
      lines.push("Recovery status: legacy worktree-local state detected.");
      lines.push("Shared storage already exists; no import was required.");
    }

    lines.push(`Operator action: ${diagnostics.operatorAction}`);
    return lines;
  }

  lines.push(`Recovery status: ${diagnostics.recoveryStatus}`);
  lines.push(`Operator action: ${diagnostics.operatorAction}`);
  return lines;
}

function recoveryFailureResult(error: DomainError): CliResult | null {
  if (error.code !== "ambiguous_legacy_state" && error.code !== "tracked_ignored_mismatch") {
    return null;
  }

  const details = error.details ?? {};
  const status = typeof details.status === "string" ? details.status : error.code;
  const operatorAction = typeof details.operatorAction === "string" ? details.operatorAction : error.message;
  const legacyDatabaseFiles = Array.isArray(details.legacyDatabaseFiles) ? details.legacyDatabaseFiles : [];
  const trackedStorageFiles = Array.isArray(details.trackedStorageFiles) ? details.trackedStorageFiles : [];
  const humanLines: string[] = [
    "Trekoon init requires operator action.",
    `Recovery status: ${status}`,
    error.message,
    `Operator action: ${operatorAction}`,
  ];

  if (legacyDatabaseFiles.length > 0) {
    humanLines.push(`Legacy databases: ${legacyDatabaseFiles.join(", ")}`);
  }

  if (trackedStorageFiles.length > 0) {
    humanLines.push(`Tracked storage files: ${trackedStorageFiles.join(", ")}`);
  }

  return failResult({
    command: "init",
    human: humanLines.join("\n"),
    data: {
      status,
      legacyDatabaseFiles,
      trackedStorageFiles,
      operatorAction,
    },
    error: {
      code: error.code,
      message: error.message,
    },
  });
}

function ensureGitignore(storageDir: string, storageMode: StorageMode): GitignoreAction {
  if (storageMode === "cwd") {
    return "skipped";
  }

  const gitignorePath: string = resolve(storageDir, ".gitignore");

  if (existsSync(gitignorePath)) {
    const existing: string = readFileSync(gitignorePath, "utf8");
    if (existing === GITIGNORE_CONTENT) {
      return "already_exists";
    }
  }

  writeFileSync(gitignorePath, GITIGNORE_CONTENT, "utf8");
  return "created";
}

export async function runInit(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    database = openTrekoonDatabase(context.cwd);
    const diagnostics = database.diagnostics;
    const bundledAssetRoot: string | undefined = process.env.TREKOON_BOARD_ASSET_ROOT;
    const board = ensureBoardInstalled({
      workingDirectory: context.cwd,
      ...(bundledAssetRoot === undefined ? {} : { bundledAssetRoot }),
    });
    const gitignoreAction: GitignoreAction = ensureGitignore(
      database.paths.storageDir,
      diagnostics.storageMode,
    );

    const humanLines: string[] = [
      "Trekoon initialized.",
      `Storage mode: ${diagnostics.storageMode}`,
      `Worktree root: ${diagnostics.worktreeRoot}`,
      `Shared storage root: ${diagnostics.sharedStorageRoot}`,
      `Storage directory: ${database.paths.storageDir}`,
      `Database file: ${database.paths.databaseFile}`,
      `Board assets: ${board.action}`,
      `Board runtime root: ${board.paths.runtimeRoot}`,
      `Gitignore: ${gitignoreAction}`,
      ...buildRecoverySummary(database),
    ];

    return okResult({
      command: "init",
      human: humanLines.join("\n"),
      data: {
        invocationCwd: diagnostics.invocationCwd,
        storageMode: diagnostics.storageMode,
        repoCommonDir: diagnostics.repoCommonDir,
        worktreeRoot: diagnostics.worktreeRoot,
        sharedStorageRoot: diagnostics.sharedStorageRoot,
        storageDir: database.paths.storageDir,
        databaseFile: database.paths.databaseFile,
        board: {
          action: board.action,
          paths: board.paths,
          manifest: board.manifest,
        },
        gitignore: {
          action: gitignoreAction,
          path: resolve(database.paths.storageDir, ".gitignore"),
        },
        legacyStateDetected: diagnostics.legacyStateDetected,
        recoveryRequired: diagnostics.recoveryRequired,
        recoveryStatus: diagnostics.recoveryStatus,
        legacyDatabaseFiles: diagnostics.legacyDatabaseFiles,
        backupFiles: diagnostics.backupFiles,
        trackedStorageFiles: diagnostics.trackedStorageFiles,
        autoMigratedLegacyState: diagnostics.autoMigratedLegacyState,
        importedFromLegacyDatabase: diagnostics.importedFromLegacyDatabase,
        operatorAction: diagnostics.operatorAction,
      },
    });
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      const recoveryFailure = recoveryFailureResult(error);
      if (recoveryFailure !== null) {
        return recoveryFailure;
      }
    }

    if (error instanceof BoardInstallError) {
      return failResult({
        command: "init",
        human: error.message,
        data: {
          code: error.code,
          ...error.details,
        },
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    return unexpectedFailureResult(error, {
      command: "init",
      human: "Unexpected init command failure",
    });
  } finally {
    database?.close();
  }
}
