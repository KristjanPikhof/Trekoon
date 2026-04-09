import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
  const existed = existsSync(options.path);

  if (existed && !options.overwrite) {
    throw new ExportWriteError(
      `File already exists: ${options.path}. Use --overwrite to resave.`,
      "file_exists",
    );
  }

  mkdirSync(dir, { recursive: true });

  const tempPath = resolve(dir, `.export-${randomUUID()}.tmp`);
  try {
    writeFileSync(tempPath, options.content, "utf8");
    renameSync(tempPath, options.path);
  } catch (error) {
    try {
      const { unlinkSync } = require("node:fs");
      unlinkSync(tempPath);
    } catch {
      // temp file cleanup is best-effort
    }
    throw error;
  }

  return { path: options.path, overwritten: existed };
}

export class ExportWriteError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "ExportWriteError";
    this.code = code;
  }
}
