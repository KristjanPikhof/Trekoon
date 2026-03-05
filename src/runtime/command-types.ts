export type OutputMode = "human" | "json" | "toon";
export type CompatibilityMode = "legacy-sync-command-ids";

export interface CliContext {
  readonly mode: OutputMode;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ToonError {
  readonly code: string;
  readonly message: string;
}

export interface ContractMetadata {
  readonly contractVersion: string;
  readonly requestId: string;
  readonly compatibility?: CompatibilityMetadata;
}

export interface CompatibilityMetadata {
  readonly mode: CompatibilityMode;
  readonly warningCode: "compatibility_mode_deprecated";
  readonly deprecatedSince: string;
  readonly removalAfter: string;
  readonly migration: string;
  readonly canonicalCommand: string;
  readonly compatibilityCommand: string;
}

export interface ToonEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data: unknown;
  readonly metadata: ContractMetadata;
  readonly error?: ToonError;
  readonly meta?: Record<string, unknown>;
}

export interface CliResult {
  readonly ok: boolean;
  readonly command: string;
  readonly data: unknown;
  readonly human: string;
  readonly error?: ToonError;
  readonly meta?: Record<string, unknown>;
}

export interface CommandHandler {
  run(context: CliContext): Promise<CliResult>;
}
