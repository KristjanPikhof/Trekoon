import { DomainError } from "../domain/types";
import { failResult } from "../io/output";
import { type CliResult } from "../runtime/command-types";

interface UnexpectedFailureOptions {
  readonly command: string;
  readonly human: string;
  readonly data?: Record<string, unknown>;
  readonly errorCode?: string;
  readonly errorMessage?: string;
}

function readErrorMessage(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === "string") {
      return candidate;
    }
  }

  return null;
}

function sanitizeErrorMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, " ").trim();
  if (normalized.length <= 240) {
    return normalized;
  }

  return `${normalized.slice(0, 237)}...`;
}

function isSqliteBusyMessage(message: string): boolean {
  const normalized = sanitizeErrorMessage(message).toLowerCase();
  const hasDatabaseContext = normalized.includes("sqlite") || normalized.includes("database");
  const hasBusySignal =
    normalized.includes("sqlite_busy") ||
    normalized.includes("database is locked") ||
    normalized.includes("database schema is locked") ||
    normalized.includes("database table is locked") ||
    normalized.includes("busy");

  return hasDatabaseContext && hasBusySignal;
}

export function sqliteBusyFailure(command: string, error: unknown): CliResult | null {
  const message = readErrorMessage(error);
  if (message === null || !isSqliteBusyMessage(message)) {
    return null;
  }

  const safeMessage = sanitizeErrorMessage(message);
  return failResult({
    command,
    human: `Trekoon database is busy. ${safeMessage}`,
    data: {
      code: "database_busy",
      reason: "database_busy",
      databaseMessage: safeMessage,
    },
    error: {
      code: "database_busy",
      message: `Trekoon database is busy: ${safeMessage}`,
    },
  });
}

export function unexpectedFailureResult(error: unknown, options: UnexpectedFailureOptions): CliResult {
  if (error instanceof DomainError) {
    return failResult({
      command: options.command,
      human: error.message,
      data: {
        code: error.code,
        ...(error.details ?? {}),
      },
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  const busyFailure = sqliteBusyFailure(options.command, error);
  if (busyFailure !== null) {
    return busyFailure;
  }

  return failResult({
    command: options.command,
    human: options.human,
    data: options.data ?? {},
    error: {
      code: options.errorCode ?? "internal_error",
      message: options.errorMessage ?? options.human,
    },
  });
}

export function safeErrorMessage(error: unknown, fallback: string): string {
  const message = readErrorMessage(error);
  return message === null ? fallback : sanitizeErrorMessage(message);
}
