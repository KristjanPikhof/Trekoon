import { mkdirSync, openSync, renameSync, unlinkSync, writeSync, closeSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface WriteResult {
  readonly path: string;
  readonly overwritten: boolean;
}

export function atomicWrite(options: {
  readonly path: string;
  readonly content: string;
  readonly overwrite: boolean;
}): WriteResult {
  const dir = dirname(options.path);
  mkdirSync(dir, { recursive: true });

  if (options.overwrite) {
    return writeViaTempRename(options.path, options.content);
  }

  return writeExclusive(options.path, options.content);
}

function writeViaTempRename(targetPath: string, content: string): WriteResult {
  const dir = dirname(targetPath);
  const tempPath = resolve(dir, `.export-${randomUUID()}.tmp`);
  let overwritten = false;

  try {
    // Probe whether the target already exists by attempting an exclusive open.
    // If it succeeds, the file didn't exist, so we close and remove that probe
    // since we'll write via temp+rename anyway for atomicity.
    try {
      const probeFd = openSync(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      closeSync(probeFd);
      unlinkSync(targetPath);
      overwritten = false;
    } catch {
      overwritten = true;
    }

    const fd = openSync(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    renameSync(tempPath, targetPath);
  } catch (error) {
    try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    throw error;
  }

  return { path: targetPath, overwritten };
}

function writeExclusive(targetPath: string, content: string): WriteResult {
  // O_CREAT | O_EXCL is atomic: the kernel fails if the file already exists.
  let fd: number;
  try {
    fd = openSync(targetPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
  } catch (error: unknown) {
    if (isFileExistsError(error)) {
      throw new ExportWriteError(
        `File already exists: ${targetPath}. Use --overwrite to resave.`,
        "file_exists",
      );
    }
    throw error;
  }

  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }

  return { path: targetPath, overwritten: false };
}

function isFileExistsError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "code" in error) {
    return (error as { code: string }).code === "EEXIST";
  }
  return false;
}

export class ExportWriteError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ExportWriteError";
    this.code = code;
  }
}
