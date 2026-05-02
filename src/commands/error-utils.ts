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

// Keys whose values must never appear in surfaced error output.
// Handles formats: key=val, key: val, key="val", 'key':'val', "key":"val",
// Authorization: Bearer val, Authorization: Basic val.
const SENSITIVE_KEY_PATTERN =
  /(["']?)(token|secret|password|bearer|authorization|api[_-]?key|client[_-]?secret|private[_-]?key|cookie|session[_-]?id)(["']?\s*[:=]\s*(?:Bearer\s+|Basic\s+)?["']?)([^\s"',;&\]}{)<>]+)/giu;

// Tag-style sensitive values: <key>value</key>.
const SENSITIVE_TAG_PATTERN =
  /(<\s*(token|secret|password|bearer|authorization|api[_-]?key|client[_-]?secret|private[_-]?key|cookie|session[_-]?id)\s*>)([^<]+)/giu;

// Standalone "Bearer xyz" / "Basic xyz" anywhere in the message.
// SENSITIVE_KEY_PATTERN runs first and consumes Authorization: Bearer/Basic forms; this
// catches bare occurrences that remain (e.g. "got Bearer eyJ..." or "auth: Basic dXNl...").
const STANDALONE_AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+([A-Za-z0-9._\-+/=]+)/giu;

export function redactSensitive(input: string): string {
  const keyRedacted = input.replace(
    SENSITIVE_KEY_PATTERN,
    (_match, open, key, sep) => `${open}${key}${sep}REDACTED`,
  );
  const tagRedacted = keyRedacted.replace(
    SENSITIVE_TAG_PATTERN,
    (_match, openTag) => `${openTag}REDACTED`,
  );
  return tagRedacted.replace(
    STANDALONE_AUTH_SCHEME_PATTERN,
    (_match, scheme) => `${scheme} REDACTED`,
  );
}

function sanitizeErrorMessage(message: string): string {
  const normalized = redactSensitive(message.replace(/\s+/gu, " ").trim());
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
