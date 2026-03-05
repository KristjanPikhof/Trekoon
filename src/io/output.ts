import { encode } from "@toon-format/toon";
import { type CliResult, type ContractMetadata, type OutputMode, type ToonEnvelope, type ToonError } from "../runtime/command-types";

const CONTRACT_VERSION = "1.0.0";
let requestSequence = 0;

function createContractMetadata(): ContractMetadata {
  requestSequence += 1;
  return {
    contractVersion: CONTRACT_VERSION,
    requestId: `req-${requestSequence}`,
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

export function toToonEnvelope(result: CliResult): ToonEnvelope {
  return {
    ok: result.ok,
    command: result.command,
    data: result.data,
    metadata: createContractMetadata(),
    ...(result.error ? { error: result.error } : {}),
    ...(result.meta ? { meta: result.meta } : {}),
  };
}

export function renderResult(result: CliResult, mode: OutputMode): string {
  const envelope: ToonEnvelope = toToonEnvelope(result);

  if (mode === "json") {
    return JSON.stringify(envelope);
  }

  if (mode === "toon") {
    return encode(envelope);
  }

  return result.human;
}
