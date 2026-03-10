import { unexpectedFailureResult } from "./error-utils";

import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";

export async function runInit(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    database = openTrekoonDatabase(context.cwd);
    return okResult({
      command: "init",
      human: [
        "Trekoon initialized.",
        `Storage directory: ${database.paths.storageDir}`,
        `Database file: ${database.paths.databaseFile}`,
      ].join("\n"),
      data: {
        storageDir: database.paths.storageDir,
        databaseFile: database.paths.databaseFile,
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
