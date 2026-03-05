import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const DB_DIRNAME = ".trekoon";
const DB_FILENAME = "trekoon.db";

export interface StoragePaths {
  readonly invocationCwd: string;
  readonly worktreeRoot: string;
  readonly storageDir: string;
  readonly databaseFile: string;
  readonly diagnostics: StoragePathDiagnostics;
}

export interface StoragePathIssue {
  readonly code: string;
  readonly message: string;
  readonly invocationCwd: string;
  readonly canonicalRoot: string;
}

export interface StoragePathDiagnostics {
  readonly invocationCwd: string;
  readonly canonicalRoot: string;
  readonly warnings: readonly StoragePathIssue[];
  readonly errors: readonly StoragePathIssue[];
}

function resolveGitTopLevel(workingDirectory: string): string | null {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return null;
  }

  const topLevel: string = result.stdout.trim();
  if (!topLevel) {
    return null;
  }

  return resolve(topLevel);
}

export function resolveStoragePaths(workingDirectory: string = process.cwd()): StoragePaths {
  const invocationCwd: string = resolve(workingDirectory);
  const canonicalRoot: string = resolveGitTopLevel(invocationCwd) ?? invocationCwd;
  const worktreeRoot: string = canonicalRoot;
  const storageDir: string = resolve(worktreeRoot, DB_DIRNAME);
  const databaseFile: string = resolve(storageDir, DB_FILENAME);
  const warnings: StoragePathIssue[] = [];

  if (invocationCwd !== canonicalRoot) {
    warnings.push({
      code: "storage_root_diverged_from_cwd",
      message: "Resolved storage root differs from invocation cwd.",
      invocationCwd,
      canonicalRoot,
    });
  }

  const diagnostics: StoragePathDiagnostics = {
    invocationCwd,
    canonicalRoot,
    warnings,
    errors: [],
  };

  return {
    invocationCwd,
    worktreeRoot,
    storageDir,
    databaseFile,
    diagnostics,
  };
}
