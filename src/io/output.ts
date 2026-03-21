import { encode } from "@toon-format/toon";
import {
  type CliResult,
  type CompatibilityMetadata,
  type CompatibilityMode,
  type ContractMetadata,
  type OutputMode,
  type ToonEnvelope,
  type ToonError,
} from "../runtime/command-types";

const CONTRACT_VERSION = "1.0.0";
const COMPATIBILITY_DEPRECATED_SINCE = "0.1.8";
const COMPATIBILITY_REMOVAL_AFTER = "2026-09-30";

export interface RenderOptions {
  readonly compatibilityMode?: CompatibilityMode | null;
  readonly compact?: boolean;
}

function toLegacySyncCommandId(command: string): string {
  const mapping: Record<string, string> = {
    "sync.status": "sync_status",
    "sync.pull": "sync_pull",
    "sync.resolve": "sync_resolve",
    "sync.conflicts": "sync_conflicts",
    "sync.conflicts.list": "sync_conflicts_list",
    "sync.conflicts.show": "sync_conflicts_show",
  };

  return mapping[command] ?? command;
}

function resolveCompatibilityCommand(command: string, compatibilityMode: CompatibilityMode | null): string {
  if (compatibilityMode === "legacy-sync-command-ids") {
    return toLegacySyncCommandId(command);
  }

  return command;
}

function createCompatibilityMetadata(command: string, compatibilityMode: CompatibilityMode | null): CompatibilityMetadata | undefined {
  if (compatibilityMode !== "legacy-sync-command-ids") {
    return undefined;
  }

  const compatibilityCommand: string = toLegacySyncCommandId(command);
  return {
    mode: compatibilityMode,
    warningCode: "compatibility_mode_deprecated",
    deprecatedSince: COMPATIBILITY_DEPRECATED_SINCE,
    removalAfter: COMPATIBILITY_REMOVAL_AFTER,
    migration: "Drop --compat legacy-sync-command-ids and parse canonical dotted command IDs.",
    canonicalCommand: command,
    compatibilityCommand,
  };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createContractMetadata(result: CliResult, compatibilityMode: CompatibilityMode | null): ContractMetadata {
  const requestSignature = JSON.stringify({
    ok: result.ok,
    command: result.command,
    data: result.data,
    error: result.error ?? null,
    meta: result.meta ?? null,
  });

  const base: ContractMetadata = {
    contractVersion: CONTRACT_VERSION,
    requestId: `req-${hashString(requestSignature)}`,
  };

  const compatibility = createCompatibilityMetadata(result.command, compatibilityMode);
  if (!compatibility) {
    return base;
  }

  return {
    ...base,
    compatibility,
  };
}

export interface ResultInput {
  readonly command: string;
  readonly data: unknown;
  readonly human: string;
  readonly meta?: Record<string, unknown>;
}

export function okResult(input: ResultInput): CliResult {
  const base: CliResult = {
    ok: true,
    command: input.command,
    data: input.data,
    human: input.human,
  };

  if (!input.meta) {
    return base;
  }

  return {
    ...base,
    meta: input.meta,
  };
}

export function failResult(input: ResultInput & { readonly error: ToonError }): CliResult {
  const base: CliResult = {
    ok: false,
    command: input.command,
    data: input.data,
    human: input.human,
    error: input.error,
  };

  if (!input.meta) {
    return base;
  }

  return {
    ...base,
    meta: input.meta,
  };
}

export function toToonEnvelope(result: CliResult, options: RenderOptions = {}): ToonEnvelope {
  const compatibilityMode: CompatibilityMode | null = options.compatibilityMode ?? null;
  const compact: boolean = options.compact ?? false;
  const command: string = resolveCompatibilityCommand(result.command, compatibilityMode);

  return {
    ok: result.ok,
    command,
    data: result.data,
    ...(compact ? {} : { metadata: createContractMetadata(result, compatibilityMode) }),
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

export function renderResult(result: CliResult, mode: OutputMode, options: RenderOptions = {}): string {
  const envelope: ToonEnvelope = toToonEnvelope(result, options);

  if (mode === "json") {
    return JSON.stringify(envelope);
  }

  if (mode === "toon") {
    return encode(envelope);
  }

  return result.human;
}
