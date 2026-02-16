import { type CliResult, type OutputMode, type ToonEnvelope, type ToonError } from "../runtime/command-types";

export interface ResultInput {
  readonly command: string;
  readonly data: unknown;
  readonly human: string;
  readonly meta?: Record<string, unknown>;
}

export function okResult(input: ResultInput): CliResult {
  return {
    ok: true,
    command: input.command,
    data: input.data,
    human: input.human,
    meta: input.meta,
  };
}

export function failResult(input: ResultInput & { readonly error: ToonError }): CliResult {
  return {
    ok: false,
    command: input.command,
    data: input.data,
    human: input.human,
    error: input.error,
    meta: input.meta,
  };
}

export function toToonEnvelope(result: CliResult): ToonEnvelope {
  return {
    ok: result.ok,
    command: result.command,
    data: result.data,
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

export function renderResult(result: CliResult, mode: OutputMode): string {
  if (mode === "toon") {
    return JSON.stringify(toToonEnvelope(result));
  }

  return result.human;
}
