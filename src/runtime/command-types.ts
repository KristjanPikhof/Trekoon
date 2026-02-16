export type OutputMode = "human" | "toon";

export interface CliContext {
  readonly mode: OutputMode;
  readonly args: readonly string[];
}

export interface CliResult {
  readonly ok: boolean;
  readonly message: string;
}

export interface CommandHandler {
  run(context: CliContext): Promise<CliResult>;
}
