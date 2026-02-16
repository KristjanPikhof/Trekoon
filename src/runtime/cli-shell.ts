import { type CliResult, type OutputMode } from "./command-types";

const SUPPORTED_ROOT_COMMANDS: readonly string[] = [
  "init",
  "quickstart",
  "epic",
  "task",
  "subtask",
  "dep",
  "sync",
  "wipe",
];

export interface ParsedInvocation {
  readonly mode: OutputMode;
  readonly command: string | null;
  readonly args: readonly string[];
}

export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  if (argv[0] === "--toon") {
    return {
      mode: "toon",
      command: argv[1] ?? null,
      args: argv.slice(2),
    };
  }

  return {
    mode: "human",
    command: argv[0] ?? null,
    args: argv.slice(1),
  };
}

export function renderShellResult(result: CliResult, mode: OutputMode): string {
  if (mode === "toon") {
    return JSON.stringify({ ok: result.ok, command: "shell", data: result.message });
  }

  return result.message;
}

export function executeShell(argv: readonly string[]): CliResult {
  const parsed: ParsedInvocation = parseInvocation(argv);

  if (!parsed.command) {
    return {
      ok: true,
      message: `Trekoon scaffold ready. Commands: ${SUPPORTED_ROOT_COMMANDS.join(", ")}`,
    };
  }

  if (!SUPPORTED_ROOT_COMMANDS.includes(parsed.command)) {
    return {
      ok: false,
      message: `Unknown command: ${parsed.command}`,
    };
  }

  return {
    ok: true,
    message: `Registered command '${parsed.command}' is scaffolded.`,
  };
}
