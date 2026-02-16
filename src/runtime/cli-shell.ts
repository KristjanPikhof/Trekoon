import { runHelp } from "../commands/help";
import { runDep } from "../commands/dep";
import { runEpic } from "../commands/epic";
import { runInit } from "../commands/init";
import { runQuickstart } from "../commands/quickstart";
import { runSubtask } from "../commands/subtask";
import { runSync } from "../commands/sync";
import { runTask } from "../commands/task";
import { runWipe } from "../commands/wipe";
import { failResult, okResult, renderResult } from "../io/output";
import { type CliContext, type CliResult, type OutputMode } from "./command-types";

const CLI_VERSION = "0.1.0";

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
  readonly wantsHelp: boolean;
  readonly wantsVersion: boolean;
}

export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  let mode: OutputMode = "human";
  let wantsHelp = false;
  let wantsVersion = false;
  const positionals: string[] = [];

  for (const token of argv) {
    if (token === "--toon") {
      mode = "toon";
      continue;
    }

    if (token === "--help" || token === "-h") {
      wantsHelp = true;
      continue;
    }

    if (token === "--version" || token === "-v") {
      wantsVersion = true;
      continue;
    }

    positionals.push(token);
  }

  return {
    mode,
    command: positionals[0] ?? null,
    args: positionals.slice(1),
    wantsHelp,
    wantsVersion,
  };
}

export function renderShellResult(result: CliResult, mode: OutputMode): string {
  return renderResult(result, mode);
}

export async function executeShell(parsed: ParsedInvocation, cwd: string = process.cwd()): Promise<CliResult> {
  if (parsed.wantsVersion) {
    return okResult({
      command: "version",
      human: CLI_VERSION,
      data: { version: CLI_VERSION },
    });
  }

  if (parsed.wantsHelp) {
    const helpContext: CliContext = {
      mode: parsed.mode,
      cwd,
      args: parsed.command ? [parsed.command] : [],
    };

    return runHelp(helpContext);
  }

  if (!parsed.command) {
    return runHelp({
      mode: parsed.mode,
      args: [],
      cwd,
    });
  }

  if (!SUPPORTED_ROOT_COMMANDS.includes(parsed.command)) {
    return failResult({
      command: "shell",
      human: `Unknown command: ${parsed.command}\nRun 'trekoon --help' for usage.`,
      data: {
        command: parsed.command,
        supportedCommands: SUPPORTED_ROOT_COMMANDS,
      },
      error: {
        code: "unknown_command",
        message: `Unknown command '${parsed.command}'`,
      },
    });
  }

  const context: CliContext = {
    mode: parsed.mode,
    args: parsed.args,
    cwd,
  };

  switch (parsed.command) {
    case "init":
      return runInit(context);
    case "quickstart":
      return runQuickstart(context);
    case "wipe":
      return runWipe(context);
    case "epic":
      return runEpic(context);
    case "task":
      return runTask(context);
    case "subtask":
      return runSubtask(context);
    case "dep":
      return runDep(context);
    case "sync":
      return runSync(context);
    default:
      return failResult({
        command: "shell",
        human: `Unhandled command: ${parsed.command}`,
        data: { command: parsed.command },
        error: {
          code: "unhandled_command",
          message: `No shell handler for '${parsed.command}'`,
        },
      });
  }
}
