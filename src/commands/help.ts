import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";

const ROOT_HELP = [
  "Trekoon - AI-first local issue tracker",
  "",
  "Usage:",
  "  trekoon [global-options] <command> [command-options]",
  "",
  "Global options:",
  "  --toon       Emit stable machine-readable output",
  "  --help       Show root or command help",
  "  --version    Print CLI version",
  "",
  "Commands:",
  "  init         Initialize .trekoon storage and local DB",
  "  quickstart   Show local-first and sync workflow guidance",
  "  wipe         Remove local Trekoon state (requires --yes)",
  "  epic         Epic commands (scaffolded)",
  "  task         Task commands (scaffolded)",
  "  subtask      Subtask commands (scaffolded)",
  "  dep          Dependency commands (scaffolded)",
  "  sync         Sync commands (scaffolded)",
].join("\n");

const COMMAND_HELP: Record<string, string> = {
  init: "Usage: trekoon init [--toon]",
  quickstart: "Usage: trekoon quickstart [--toon]",
  wipe: "Usage: trekoon wipe --yes [--toon]",
  epic: "Usage: trekoon epic <subcommand> [options]",
  task: "Usage: trekoon task <subcommand> [options]",
  subtask: "Usage: trekoon subtask <subcommand> [options]",
  dep: "Usage: trekoon dep <subcommand> [options]",
  sync: "Usage: trekoon sync <subcommand> [options]",
  help: "Usage: trekoon help [command] [--toon]",
};

export function resolveHelpText(topic: string | null): string {
  if (!topic) {
    return ROOT_HELP;
  }

  return COMMAND_HELP[topic] ?? `Unknown command for help: ${topic}`;
}

export async function runHelp(context: CliContext): Promise<CliResult> {
  const topic: string | null = context.args[0] ?? null;
  const text: string = resolveHelpText(topic);

  return okResult({
    command: "help",
    human: text,
    data: {
      topic,
      text,
    },
  });
}
