export type OutputMode = "human" | "json" | "toon";

export interface CliContext {
  readonly mode: OutputMode;
  readonly args: readonly string[];
  readonly cwd: string;
}

export interface ToonError {
  readonly code: string;
  readonly message: string;
}

export interface ToonEnvelope {
  readonly ok: boolean;
  readonly command: string;
  readonly data: unknown;
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
