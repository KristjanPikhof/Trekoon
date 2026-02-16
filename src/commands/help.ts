import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";

const ROOT_HELP = [
  "Trekoon - AI-first local issue tracker",
  "",
  "Usage:",
  "  trekoon [global-options] <command> [command-options]",
  "",
  "Global options:",
  "  --json       Emit stable JSON machine output",
  "  --toon       Emit true TOON-encoded output",
  "  --help       Show root or command help",
  "  --version    Print CLI version",
  "",
  "Commands:",
  "  init         Initialize .trekoon storage and local DB",
  "  quickstart   Show workflow + where to see task descriptions",
  "  wipe         Remove local Trekoon state (requires --yes)",
  "  epic         Epic lifecycle commands",
  "  task         Task lifecycle commands",
  "  subtask      Subtask lifecycle commands",
  "  dep          Dependency graph commands",
  "  sync         Cross-branch sync commands",
].join("\n");

const COMMAND_HELP: Record<string, string> = {
  init: "Usage: trekoon init [--json|--toon]",
  quickstart: "Usage: trekoon quickstart [--json|--toon]",
  wipe: "Usage: trekoon wipe --yes [--json|--toon]",
  epic:
    "Usage: trekoon epic <subcommand> [options] (list defaults: open statuses + limit 10; list flags: --status <csv> | --limit <n> | --all | --view table|compact; show supports --all and --view table|compact|tree|detail; update bulk flags: --all | --ids <csv> with --append <text> and/or --status <status>)",
  task:
    "Usage: trekoon task <subcommand> [options] (list defaults: open statuses + limit 10; list flags: --status <csv> | --limit <n> | --all | --view table|compact; show supports --all and --view table|compact|tree|detail; update bulk flags: --all | --ids <csv> with --append <text> and/or --status <status>)",
  subtask: "Usage: trekoon subtask <subcommand> [options] (list supports --view table|compact)",
  dep: "Usage: trekoon dep <subcommand> [options]",
  sync: "Usage: trekoon sync <subcommand> [options]",
  help: "Usage: trekoon help [command] [--json|--toon]",
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
