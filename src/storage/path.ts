import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const DB_DIRNAME = ".trekoon";
const DB_FILENAME = "trekoon.db";

export type StorageMode = "cwd" | "git_common_dir";

export interface StoragePaths {
  readonly invocationCwd: string;
  readonly storageMode: StorageMode;
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly storageDir: string;
  readonly databaseFile: string;
  readonly diagnostics: StoragePathDiagnostics;
}

export interface StoragePathIssue {
  readonly code: string;
  readonly message: string;
  readonly invocationCwd: string;
  readonly storageMode: StorageMode;
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly databaseFile: string;
}

export interface StoragePathDiagnostics {
  readonly invocationCwd: string;
  readonly storageMode: StorageMode;
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly databaseFile: string;
  readonly warnings: readonly StoragePathIssue[];
  readonly errors: readonly StoragePathIssue[];
}

function resolveGitPath(workingDirectory: string, argument: "--git-common-dir" | "--show-toplevel"): string | null {
  const result = spawnSync("git", ["rev-parse", argument], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return null;
  }

  const rawPath: string = result.stdout.trim();
  if (!rawPath) {
    return null;
  }

  return resolve(workingDirectory, rawPath);
}

export function resolveStoragePaths(workingDirectory: string = process.cwd()): StoragePaths {
  const invocationCwd: string = resolve(workingDirectory);
  const worktreeRoot: string = resolveGitPath(invocationCwd, "--show-toplevel") ?? invocationCwd;
  const repoCommonDirRaw: string | null = resolveGitPath(invocationCwd, "--git-common-dir");
  const repoCommonDir: string | null = repoCommonDirRaw ? realpathSync(repoCommonDirRaw) : null;
  const storageMode: StorageMode = repoCommonDir ? "git_common_dir" : "cwd";
  const sharedStorageRoot: string = repoCommonDir ?? invocationCwd;
  const storageDir: string = resolve(sharedStorageRoot, DB_DIRNAME);
  const databaseFile: string = resolve(storageDir, DB_FILENAME);
  const warnings: StoragePathIssue[] = [];

  const createIssue = (code: string, message: string): StoragePathIssue => ({
    code,
    message,
    invocationCwd,
    storageMode,
    repoCommonDir,
    worktreeRoot,
    sharedStorageRoot,
    databaseFile,
  });

  if (invocationCwd !== worktreeRoot) {
    warnings.push(
      createIssue("storage_root_diverged_from_cwd", "Resolved worktree root differs from invocation cwd."),
    );
  }

  if (sharedStorageRoot !== worktreeRoot) {
    warnings.push(
      createIssue(
        "shared_storage_root_differs_from_worktree_root",
        "Resolved shared storage root differs from worktree root.",
      ),
    );
  }

  const diagnostics: StoragePathDiagnostics = {
    invocationCwd,
    storageMode,
    repoCommonDir,
    worktreeRoot,
    sharedStorageRoot,
    databaseFile,
    warnings,
    errors: [],
  };

  return {
    invocationCwd,
    storageMode,
    repoCommonDir,
    worktreeRoot,
    sharedStorageRoot,
    storageDir,
    databaseFile,
    diagnostics,
  };
}
