import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

export async function runInit(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
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
  } finally {
    database.close();
  }
}
