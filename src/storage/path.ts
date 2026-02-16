import { resolve } from "node:path";

const DB_DIRNAME = ".trekoon";
const DB_FILENAME = "trekoon.db";

export interface StoragePaths {
  readonly worktreeRoot: string;
  readonly storageDir: string;
  readonly databaseFile: string;
}

export function resolveStoragePaths(workingDirectory: string = process.cwd()): StoragePaths {
  const worktreeRoot: string = resolve(workingDirectory);
  const storageDir: string = resolve(worktreeRoot, DB_DIRNAME);
  const databaseFile: string = resolve(storageDir, DB_FILENAME);

  return {
    worktreeRoot,
    storageDir,
    databaseFile,
  };
}
