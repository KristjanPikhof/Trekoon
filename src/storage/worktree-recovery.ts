import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { DomainError } from "../domain/types";
import {
  resolveLegacyWorktreeDatabaseFile,
  TREKOON_DATABASE_FILENAME,
  type StoragePaths,
} from "./path";

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

interface LegacyDatabaseFingerprint {
  readonly path: string;
  readonly hash: string;
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

  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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

function listTrackedStorageFiles(paths: StoragePaths): string[] {
  if (paths.repoCommonDir === null) {
    return [];
  }

  return readGitLines(paths.sharedStorageRoot, ["ls-files", "--cached", "--", ".trekoon"])
    .map((entry) => resolve(paths.sharedStorageRoot, entry));
}

function listLegacyDatabaseFiles(paths: StoragePaths): string[] {
  const files = new Set<string>();

  for (const worktreeRoot of listWorktreeRoots(paths)) {
    const legacyDatabaseFile: string = resolveLegacyWorktreeDatabaseFile(worktreeRoot);
    if (legacyDatabaseFile === paths.databaseFile || !existsSync(legacyDatabaseFile)) {
      continue;
    }

    files.add(legacyDatabaseFile);
  }

  return [...files].sort();
}

function fingerprintDatabaseFile(filePath: string): LegacyDatabaseFingerprint {
  const content = readFileSync(filePath);
  const hash = createHash("sha256").update(content).digest("hex");
  return {
    path: filePath,
    hash,
  };
}

function createBackupFilePath(filePath: string): string {
  let attempt = 0;

  while (true) {
    const suffix = attempt === 0 ? ".pre-shared-import.bak" : `.pre-shared-import.${attempt}.bak`;
    const candidate = `${filePath}${suffix}`;
    if (!existsSync(candidate)) {
      return candidate;
    }

    attempt += 1;
  }
}

function backupLegacyDatabaseFile(filePath: string): string {
  const backupPath: string = createBackupFilePath(filePath);
  mkdirSync(dirname(backupPath), { recursive: true });
  copyFileSync(filePath, backupPath);
  return backupPath;
}

function formatTrackedMismatchAction(paths: StoragePaths): string {
  return [
    "Remove tracked .trekoon files from git before continuing.",
    `Suggested action: git rm --cached -r -- ${resolve(paths.sharedStorageRoot, ".trekoon")}`,
    "Commit the index cleanup, keep .trekoon ignored, then rerun trekoon init.",
  ].join(" ");
}

function formatAmbiguousRecoveryAction(paths: StoragePaths, legacyFiles: readonly string[]): string {
  const sharedDatabaseFile: string = paths.databaseFile;
  const firstLegacyFile: string = legacyFiles[0] ?? sharedDatabaseFile;

  return [
    "Multiple divergent legacy databases were found.",
    `Choose one source database, back it up, then copy it to ${sharedDatabaseFile}.`,
    `Example: cp ${firstLegacyFile} ${sharedDatabaseFile}`,
    "Rerun trekoon init after selecting the authoritative database.",
  ].join(" ");
}

export function recoverWorktreeDatabaseState(paths: StoragePaths): WorktreeRecoveryDiagnostics {
  const trackedStorageFiles: string[] = listTrackedStorageFiles(paths);
  const legacyDatabaseFiles: string[] = listLegacyDatabaseFiles(paths);

  if (trackedStorageFiles.length > 0) {
    return {
      status: "tracked_ignored_mismatch",
      legacyDatabaseFiles,
      backupFiles: [],
      trackedStorageFiles,
      autoMigrated: false,
      importedFrom: null,
      operatorAction: formatTrackedMismatchAction(paths),
    };
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
    return {
      status: "safe_auto_migrate",
      legacyDatabaseFiles,
      backupFiles: [],
      trackedStorageFiles,
      autoMigrated: false,
      importedFrom: null,
      operatorAction: "Shared database already exists. Review and remove stale legacy worktree-local databases after verification.",
    };
  }

  const fingerprints: LegacyDatabaseFingerprint[] = legacyDatabaseFiles.map(fingerprintDatabaseFile);
  const distinctHashes: string[] = [...new Set(fingerprints.map((entry) => entry.hash))];

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

  const backupFiles: string[] = legacyDatabaseFiles.map(backupLegacyDatabaseFile);
  mkdirSync(dirname(paths.databaseFile), { recursive: true });
  copyFileSync(legacyDatabaseFiles[0], paths.databaseFile);

  return {
    status: "safe_auto_migrate",
    legacyDatabaseFiles,
    backupFiles,
    trackedStorageFiles,
    autoMigrated: true,
    importedFrom: legacyDatabaseFiles[0],
    operatorAction: `Imported legacy worktree database into shared storage and backed up ${legacyDatabaseFiles.length} original file(s).`,
  };
}

export function isLegacyDatabaseBackup(filePath: string): boolean {
  return filePath.endsWith(`${TREKOON_DATABASE_FILENAME}.pre-shared-import.bak`)
    || /\.pre-shared-import\.\d+\.bak$/u.test(filePath);
}
