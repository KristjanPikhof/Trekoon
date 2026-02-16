import { existsSync, rmSync } from "node:fs";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { resolveStoragePaths } from "../storage/path";

export async function runWipe(context: CliContext): Promise<CliResult> {
  const confirmed: boolean = context.args.includes("--yes");

  if (!confirmed) {
    return failResult({
      command: "wipe",
      human: "Refusing to wipe local state without --yes.",
      data: {
        confirmed,
      },
      error: {
        code: "confirmation_required",
        message: "Wipe requires --yes",
      },
    });
  }

  const paths = resolveStoragePaths(context.cwd);
  const existed: boolean = existsSync(paths.storageDir);

  rmSync(paths.storageDir, { recursive: true, force: true });

  return okResult({
    command: "wipe",
    human: existed
      ? `Removed local Trekoon state at ${paths.storageDir}`
      : `No local Trekoon state found at ${paths.storageDir}`,
    data: {
      storageDir: paths.storageDir,
      wiped: existed,
    },
  });
}
