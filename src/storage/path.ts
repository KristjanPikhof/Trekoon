import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export const TREKOON_STORAGE_DIRNAME = ".trekoon";
export const TREKOON_DATABASE_FILENAME = "trekoon.db";
export const TREKOON_BOARD_DIRNAME = "board";
export const TREKOON_BOARD_ENTRY_FILENAME = "index.html";
export const TREKOON_BOARD_MANIFEST_FILENAME = "manifest.json";

export function resolveLegacyWorktreeStorageDir(worktreeRoot: string): string {
  return resolve(worktreeRoot, TREKOON_STORAGE_DIRNAME);
}

export function resolveLegacyWorktreeDatabaseFile(worktreeRoot: string): string {
  return resolve(resolveLegacyWorktreeStorageDir(worktreeRoot), TREKOON_DATABASE_FILENAME);
}

export type StorageMode = "cwd" | "git_common_dir";

export function resolveBoardStorageDir(storageDir: string): string {
  return resolve(storageDir, TREKOON_BOARD_DIRNAME);
}

export function resolveBoardEntryFile(storageDir: string): string {
  return resolve(resolveBoardStorageDir(storageDir), TREKOON_BOARD_ENTRY_FILENAME);
}

export function resolveBoardManifestFile(storageDir: string): string {
  return resolve(resolveBoardStorageDir(storageDir), TREKOON_BOARD_MANIFEST_FILENAME);
}

export interface StoragePaths {
  readonly invocationCwd: string;
  readonly storageMode: StorageMode;
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly storageDir: string;
  readonly databaseFile: string;
  readonly boardDir: string;
  readonly boardEntryFile: string;
  readonly boardManifestFile: string;
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
  readonly boardDir: string;
  readonly boardEntryFile: string;
  readonly boardManifestFile: string;
}

export interface StoragePathDiagnostics {
  readonly invocationCwd: string;
  readonly storageMode: StorageMode;
  readonly repoCommonDir: string | null;
  readonly worktreeRoot: string;
  readonly sharedStorageRoot: string;
  readonly databaseFile: string;
  readonly boardDir: string;
  readonly boardEntryFile: string;
  readonly boardManifestFile: string;
  readonly warnings: readonly StoragePathIssue[];
  readonly errors: readonly StoragePathIssue[];
}

const storagePathCache: Map<string, StoragePaths> = new Map();

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
  const cachedPaths: StoragePaths | undefined = storagePathCache.get(invocationCwd);
  if (cachedPaths) {
    return cachedPaths;
  }

  const worktreeRoot: string = resolveGitPath(invocationCwd, "--show-toplevel") ?? invocationCwd;
  const repoCommonDirRaw: string | null = resolveGitPath(invocationCwd, "--git-common-dir");
  const repoCommonDir: string | null = repoCommonDirRaw ? realpathSync(repoCommonDirRaw) : null;
  const storageMode: StorageMode = repoCommonDir ? "git_common_dir" : "cwd";
  const sharedStorageRoot: string = repoCommonDir ? realpathSync(resolve(repoCommonDir, "..")) : invocationCwd;
  const storageDir: string = resolve(sharedStorageRoot, TREKOON_STORAGE_DIRNAME);
  const databaseFile: string = resolve(storageDir, TREKOON_DATABASE_FILENAME);
  const boardDir: string = resolveBoardStorageDir(storageDir);
  const boardEntryFile: string = resolveBoardEntryFile(storageDir);
  const boardManifestFile: string = resolveBoardManifestFile(storageDir);
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
    boardDir,
    boardEntryFile,
    boardManifestFile,
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
    boardDir,
    boardEntryFile,
    boardManifestFile,
    warnings,
    errors: [],
  };

  const storagePaths: StoragePaths = {
    invocationCwd,
    storageMode,
    repoCommonDir,
    worktreeRoot,
    sharedStorageRoot,
    storageDir,
    databaseFile,
    boardDir,
    boardEntryFile,
    boardManifestFile,
    diagnostics,
  };

  storagePathCache.set(invocationCwd, storagePaths);

  return storagePaths;
}
