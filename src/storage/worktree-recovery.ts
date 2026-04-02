import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { DomainError } from "../domain/types";
import {
  resolveLegacyWorktreeDatabaseFile,
  TREKOON_DATABASE_FILENAME,
  type StoragePaths,
} from "./path";

function formatShellPath(filePath: string): string {
  return `'${filePath.replaceAll("'", `'\\''`)}'`;
}

function formatSqliteDotCommandPath(filePath: string): string {
  return `"${filePath.replaceAll('"', '""')}"`;
}

export type WorktreeRecoveryStatus =
  | "no_legacy_state"
  | "safe_auto_migrate"
  | "ambiguous_recovery"
  | "tracked_ignored_mismatch";

export interface WorktreeRecoveryDiagnostics {
  readonly status: WorktreeRecoveryStatus;
  readonly legacyDatabaseFiles: readonly string[];
  readonly backupFiles: readonly string[];
  readonly trackedStorageFiles: readonly string[];
  readonly autoMigrated: boolean;
  readonly importedFrom: string | null;
  readonly operatorAction: string;
}

interface WorktreeRecoveryOptions {
  readonly applyRecovery?: boolean;
  readonly worktreeRoots?: readonly string[];
}

function readGitLines(workingDirectory: string, args: readonly string[]): string[] {
  const result = spawnSync("git", args, {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.status !== 0) {
    return [];
  }

  const stdout: string = typeof result.stdout === "string" ? result.stdout : "";

  return stdout
    .split(/\r?\n/u)
    .map((line: string) => line.trim())
    .filter((line: string) => line.length > 0);
}

function listWorktreeRoots(paths: StoragePaths): string[] {
  if (paths.repoCommonDir === null) {
    return [paths.worktreeRoot];
  }

  const lines = readGitLines(paths.worktreeRoot, ["worktree", "list", "--porcelain"]);
  const worktreeRoots = new Set<string>();

  for (const line of lines) {
    if (!line.startsWith("worktree ")) {
      continue;
    }

    const rawPath: string = line.slice("worktree ".length).trim();
    if (!rawPath) {
      continue;
    }

    try {
      worktreeRoots.add(realpathSync(rawPath));
    } catch {
      worktreeRoots.add(resolve(rawPath));
    }
  }

  if (worktreeRoots.size === 0) {
    worktreeRoots.add(paths.worktreeRoot);
  }

  return [...worktreeRoots];
}

function resolveRecoveryWorktreeRoots(paths: StoragePaths, options: WorktreeRecoveryOptions): readonly string[] {
  return options.worktreeRoots ?? listWorktreeRoots(paths);
}

function listTrackedStorageFiles(paths: StoragePaths, worktreeRoots: readonly string[]): string[] {
  if (paths.repoCommonDir === null) {
    return [];
  }

  const trackedFiles = new Set<string>();

  for (const worktreeRoot of worktreeRoots) {
    for (const entry of readGitLines(worktreeRoot, ["ls-files", "--cached", "--", ".trekoon"])) {
      trackedFiles.add(resolve(worktreeRoot, entry));
    }
  }

  return [...trackedFiles].sort();
}

function listLegacyDatabaseFiles(paths: StoragePaths, worktreeRoots: readonly string[]): string[] {
  const files = new Set<string>();

  for (const worktreeRoot of worktreeRoots) {
    const legacyDatabaseFile: string = resolveLegacyWorktreeDatabaseFile(worktreeRoot);
    if (legacyDatabaseFile === paths.databaseFile || !existsSync(legacyDatabaseFile)) {
      continue;
    }

    files.add(legacyDatabaseFile);
  }

  return [...files].sort();
}

function fingerprintDatabaseFile(filePath: string): string {
  const dumpResult = spawnSync("sqlite3", [filePath, ".dump"], {
    cwd: dirname(filePath),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (dumpResult.status === 0 && typeof dumpResult.stdout === "string") {
    return createHash("sha256").update(dumpResult.stdout).digest("hex");
  }

  const content = readFileSync(filePath);
  return createHash("sha256").update(content).digest("hex");
}

function createBackupFilePath(filePath: string): string {
  const maxAttempts = 1000;
  let attempt = 0;

  while (attempt < maxAttempts) {
    const suffix = attempt === 0 ? ".pre-shared-import.bak" : `.pre-shared-import.${attempt}.bak`;
    const candidate = `${filePath}${suffix}`;
    if (!existsSync(candidate)) {
      return candidate;
    }

    attempt += 1;
  }

  throw new DomainError({
    code: "legacy_import_failed",
    message: `Unable to find available backup path after ${maxAttempts} attempts for ${filePath}`,
  });
}

function createDatabaseSnapshot(sourcePath: string, targetPath: string): void {
  const backupResult = spawnSync("sqlite3", [sourcePath, `.backup ${formatSqliteDotCommandPath(targetPath)}`], {
    cwd: dirname(sourcePath),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (backupResult.status !== 0) {
    const stderr: string = typeof backupResult.stderr === "string" ? backupResult.stderr.trim() : "";
    const stdout: string = typeof backupResult.stdout === "string" ? backupResult.stdout.trim() : "";
    const detail: string = stderr || stdout || `sqlite3 exited with status ${backupResult.status ?? "unknown"}`;

    throw new DomainError({
      code: "legacy_import_failed",
      message: `Failed to snapshot legacy database state from ${sourcePath} to ${targetPath}: ${detail}`,
    });
  }
}

function backupLegacyDatabaseFile(filePath: string): string {
  const backupPath: string = createBackupFilePath(filePath);
  mkdirSync(dirname(backupPath), { recursive: true });
  createDatabaseSnapshot(filePath, backupPath);
  return backupPath;
}

function resolveTrackedFileWorktreeRoot(paths: StoragePaths, trackedFilePath: string): string {
  const worktreeRoots: string[] = listWorktreeRoots(paths).sort(
    (left: string, right: string) => right.length - left.length,
  );

  for (const worktreeRoot of worktreeRoots) {
    if (trackedFilePath === worktreeRoot || trackedFilePath.startsWith(`${worktreeRoot}${sep}`)) {
      return worktreeRoot;
    }
  }

  return paths.worktreeRoot;
}

function formatTrackedMismatchAction(paths: StoragePaths, trackedStorageFiles: readonly string[]): string {
  const commandsByWorktree = new Map<string, string[]>();

  for (const trackedFilePath of trackedStorageFiles) {
    const worktreeRoot: string = resolveTrackedFileWorktreeRoot(paths, trackedFilePath);
    const relativeTrackedPath: string = relative(worktreeRoot, trackedFilePath);
    const trackedPathsForWorktree: string[] = commandsByWorktree.get(worktreeRoot) ?? [];
    trackedPathsForWorktree.push(relativeTrackedPath);
    commandsByWorktree.set(worktreeRoot, trackedPathsForWorktree);
  }

  const suggestedCommands: string = [...commandsByWorktree.entries()]
    .map(([worktreeRoot, trackedPaths]: [string, string[]]) => (
      `git -C ${formatShellPath(worktreeRoot)} rm --cached -- ${trackedPaths
        .map((trackedPath: string) => formatShellPath(trackedPath))
        .join(" ")}`
    ))
    .join(" ; ");

  return [
    "Remove tracked .trekoon files from every worktree index before continuing.",
    `Tracked path(s): ${trackedStorageFiles.map(formatShellPath).join(", ")}`,
    `Suggested action: ${suggestedCommands}`,
    "Commit the index cleanup, keep .trekoon ignored, then rerun trekoon init.",
  ].join(" ");
}

function formatAmbiguousRecoveryAction(paths: StoragePaths, legacyFiles: readonly string[]): string {
  const sharedDatabaseFile: string = paths.databaseFile;
  const firstLegacyFile: string = legacyFiles[0] ?? resolveLegacyWorktreeDatabaseFile(paths.worktreeRoot);
  const sharedDatabaseDirectory: string = dirname(sharedDatabaseFile);
  const remainingLegacyFiles: string[] = legacyFiles.filter((filePath: string) => filePath !== firstLegacyFile);
  const reconciliationStep: string = remainingLegacyFiles.length === 0
    ? `After verifying ${sharedDatabaseFile}, remove the remaining divergent legacy database before rerunning trekoon init.`
    : `After verifying ${sharedDatabaseFile}, remove or reconcile the other divergent legacy database files before rerunning trekoon init: ${remainingLegacyFiles.map(formatShellPath).join(", ")}.`;

  return [
    "Multiple divergent legacy databases were found.",
    `Choose one source database, ensure ${sharedDatabaseDirectory} exists, then use sqlite3 .backup to create a WAL-safe snapshot at ${sharedDatabaseFile}.`,
    `Example: mkdir -p ${formatShellPath(sharedDatabaseDirectory)} && sqlite3 ${formatShellPath(firstLegacyFile)} '.backup ${formatSqliteDotCommandPath(sharedDatabaseFile)}'`,
    reconciliationStep,
  ].join(" ");
}

function assertNoSplitState(
  paths: StoragePaths,
  legacyDatabaseFiles: readonly string[],
  trackedStorageFiles: readonly string[],
): void {
  if (!existsSync(paths.databaseFile)) {
    return;
  }

  const sharedFingerprint: string = fingerprintDatabaseFile(paths.databaseFile);
  const divergentLegacyFiles: string[] = legacyDatabaseFiles.filter(
    (legacyDatabaseFile: string) => fingerprintDatabaseFile(legacyDatabaseFile) !== sharedFingerprint,
  );

  if (divergentLegacyFiles.length === 0) {
    return;
  }

  throw new DomainError({
    code: "ambiguous_legacy_state",
    message: "Shared storage conflicts with divergent legacy worktree databases.",
    details: {
      status: "ambiguous_recovery",
      legacyDatabaseFiles,
      trackedStorageFiles,
      operatorAction: formatAmbiguousRecoveryAction(paths, divergentLegacyFiles),
    },
  });
}

export function recoverWorktreeDatabaseState(paths: StoragePaths): WorktreeRecoveryDiagnostics {
  return inspectWorktreeDatabaseState(paths, { applyRecovery: true });
}

export function inspectWorktreeDatabaseState(
  paths: StoragePaths,
  options: WorktreeRecoveryOptions = {},
): WorktreeRecoveryDiagnostics {
  const applyRecovery: boolean = options.applyRecovery ?? false;
  const worktreeRoots: readonly string[] = resolveRecoveryWorktreeRoots(paths, options);
  const trackedStorageFiles: string[] = listTrackedStorageFiles(paths, worktreeRoots);
  const legacyDatabaseFiles: string[] = listLegacyDatabaseFiles(paths, worktreeRoots);

  if (trackedStorageFiles.length > 0) {
    throw new DomainError({
      code: "tracked_ignored_mismatch",
      message: "Tracked .trekoon files conflict with ignored shared storage.",
      details: {
        status: "tracked_ignored_mismatch",
        legacyDatabaseFiles,
        trackedStorageFiles,
        operatorAction: formatTrackedMismatchAction(paths, trackedStorageFiles),
      },
    });
  }

  if (legacyDatabaseFiles.length === 0) {
    return {
      status: "no_legacy_state",
      legacyDatabaseFiles,
      backupFiles: [],
      trackedStorageFiles,
      autoMigrated: false,
      importedFrom: null,
      operatorAction: "No legacy worktree-local database detected.",
    };
  }

  if (existsSync(paths.databaseFile)) {
    assertNoSplitState(paths, legacyDatabaseFiles, trackedStorageFiles);

    return {
      status: "safe_auto_migrate",
      legacyDatabaseFiles,
      backupFiles: [],
      trackedStorageFiles,
      autoMigrated: false,
      importedFrom: null,
      operatorAction: "Shared database already exists and matches legacy worktree-local databases. Review and remove stale legacy worktree-local databases after verification.",
    };
  }

  const distinctHashes: string[] = [...new Set(legacyDatabaseFiles.map(fingerprintDatabaseFile))];

  if (distinctHashes.length !== 1) {
    throw new DomainError({
      code: "ambiguous_legacy_state",
      message: "Multiple divergent legacy worktree databases require explicit recovery.",
      details: {
        status: "ambiguous_recovery",
        legacyDatabaseFiles,
        trackedStorageFiles,
        operatorAction: formatAmbiguousRecoveryAction(paths, legacyDatabaseFiles),
      },
    });
  }

  const importSource: string | undefined = legacyDatabaseFiles[0];
  if (importSource === undefined) {
    throw new DomainError({
      code: "legacy_import_failed",
      message: "Legacy import could not determine a source database.",
    });
  }

  if (!applyRecovery) {
    return {
      status: "safe_auto_migrate",
      legacyDatabaseFiles,
      backupFiles: [],
      trackedStorageFiles,
      autoMigrated: false,
      importedFrom: null,
      operatorAction: `Legacy worktree database can be imported into shared storage during init/open. Source: ${importSource}`,
    };
  }

  const backupFiles: string[] = legacyDatabaseFiles.map(backupLegacyDatabaseFile);
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  createDatabaseSnapshot(importSource, paths.databaseFile);

  return {
    status: "safe_auto_migrate",
    legacyDatabaseFiles,
    backupFiles,
    trackedStorageFiles,
    autoMigrated: true,
    importedFrom: importSource,
    operatorAction: `Imported legacy worktree database into shared storage and backed up ${legacyDatabaseFiles.length} original file(s).`,
  };
}

export function isLegacyDatabaseBackup(filePath: string): boolean {
  return filePath.endsWith(`${TREKOON_DATABASE_FILENAME}.pre-shared-import.bak`)
    || /\.pre-shared-import\.\d+\.bak$/u.test(filePath);
}
