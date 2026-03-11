import { unexpectedFailureResult } from "./error-utils";

import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";

export async function runInit(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    database = openTrekoonDatabase(context.cwd);
    const diagnostics = database.diagnostics;
    const humanLines: string[] = [
      "Trekoon initialized.",
      `Storage mode: ${diagnostics.storageMode}`,
      `Worktree root: ${diagnostics.worktreeRoot}`,
      `Shared storage root: ${diagnostics.sharedStorageRoot}`,
      `Storage directory: ${database.paths.storageDir}`,
      `Database file: ${database.paths.databaseFile}`,
    ];

    if (diagnostics.legacyStateDetected) {
      humanLines.push(`Legacy worktree-local state detected at ${diagnostics.worktreeRoot}/.trekoon/trekoon.db.`);
    }

    if (diagnostics.recoveryRequired) {
      humanLines.push("Recovery required before using shared storage to avoid splitting state.");
    }

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
        legacyStateDetected: diagnostics.legacyStateDetected,
        recoveryRequired: diagnostics.recoveryRequired,
      },
    });
  } catch (error: unknown) {
    return unexpectedFailureResult(error, {
      command: "init",
      human: "Unexpected init command failure",
    });
  } finally {
    database?.close();
  }
}
