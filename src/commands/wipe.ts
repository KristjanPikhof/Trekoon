import { existsSync, rmSync } from "node:fs";

import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { resolveStoragePaths } from "../storage/path";

export async function runWipe(context: CliContext): Promise<CliResult> {
  const confirmed: boolean = context.args.includes("--yes");
  const paths = resolveStoragePaths(context.cwd);
  const repoScoped: boolean = paths.storageMode === "git_common_dir";
  const sharedAcrossWorktrees: boolean = repoScoped && paths.sharedStorageRoot !== paths.worktreeRoot;
  const scopeLabel: string = repoScoped ? "repo-wide Trekoon state" : "local Trekoon state";

  if (!confirmed) {
    return failResult({
      command: "wipe",
      human: `Refusing to wipe ${scopeLabel} without --yes. This deletes ${paths.storageDir}${repoScoped ? " for the entire repository, including any linked worktrees that share this storage" : " for this working directory"}.`,
      data: {
        confirmed,
        storageDir: paths.storageDir,
        worktreeRoot: paths.worktreeRoot,
        sharedStorageRoot: paths.sharedStorageRoot,
        repoScoped,
      },
      error: {
        code: "confirmation_required",
        message: `Wipe requires --yes to remove ${scopeLabel}`,
      },
    });
  }

  const existed: boolean = existsSync(paths.storageDir);

  rmSync(paths.storageDir, { recursive: true, force: true });

  return okResult({
    command: "wipe",
    human: existed
      ? `Removed ${scopeLabel} at ${paths.storageDir}${repoScoped ? ` for repository ${paths.sharedStorageRoot}` : ""}${sharedAcrossWorktrees ? ", which is shared with linked worktrees" : ""}.`
      : `No ${scopeLabel} found at ${paths.storageDir}${repoScoped ? ` for repository ${paths.sharedStorageRoot}` : ""}${sharedAcrossWorktrees ? ", which is shared with linked worktrees" : ""}.`,
    data: {
      storageDir: paths.storageDir,
      worktreeRoot: paths.worktreeRoot,
      sharedStorageRoot: paths.sharedStorageRoot,
      repoScoped,
      wiped: existed,
    },
  });
}
