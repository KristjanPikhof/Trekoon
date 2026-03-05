import { okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { CLI_VERSION } from "../runtime/version";

const ROOT_HELP = [
  "Trekoon - AI-first local issue tracker",
  `Version: ${CLI_VERSION}`,
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
  "  quickstart   Show AI execution loop + task detail workflow",
  "  wipe         Remove local Trekoon state (requires --yes)",
  "  epic         Epic lifecycle commands",
  "  task         Task lifecycle commands",
  "  subtask      Subtask lifecycle commands",
  "  dep          Dependency graph commands",
  "  events       Event retention and cleanup commands",
  "  migrate      Migration status and rollback commands",
  "  sync         Cross-branch sync commands",
  "  skills       Project-local skill install/link commands",
].join("\n");

const DEP_HELP = [
  "Usage: trekoon dep <add|remove|list|reverse> [options]",
  "",
  "Subcommands:",
  "  add <source-id> <depends-on-id>",
  "      Create dependency edge: source depends on depends-on.",
  "  remove <source-id> <depends-on-id>",
  "      Remove one dependency edge if it exists.",
  "  list <source-id>",
  "      Show direct dependencies for a node.",
  "  reverse <target-id>",
  "      Show downstream nodes blocked by target (with distance).",
  "",
  "Examples:",
  "  trekoon dep add <task-a> <task-b>",
  "  trekoon dep remove <task-a> <task-b>",
  "  trekoon dep list <task-a>",
  "  trekoon dep reverse <task-b>",
].join("\n");

const EVENTS_HELP = [
  "Usage: trekoon events prune [--dry-run] [--archive] [--retention-days <n>]",
  "",
  "Purpose:",
  "  Manage retention for internal sync event log rows.",
  "",
  "Options:",
  "  --dry-run             Preview candidate/archive/delete counts only.",
  "  --archive             Copy pruned rows to event_archive before delete.",
  "  --retention-days <n>  Keep last n days (positive integer, default 90).",
  "",
  "Examples:",
  "  trekoon events prune --dry-run",
  "  trekoon events prune --retention-days 30",
  "  trekoon events prune --archive",
].join("\n");

const MIGRATE_HELP = [
  "Usage: trekoon migrate <status|rollback> [--to-version <n>]",
  "",
  "Subcommands:",
  "  status",
  "      Show current schema version, latest version, and pending count.",
  "  rollback [--to-version <n>]",
  "      Roll back migrations; default target is one version back.",
  "",
  "Examples:",
  "  trekoon migrate status",
  "  trekoon migrate rollback",
  "  trekoon migrate rollback --to-version 1",
].join("\n");

const COMMAND_HELP: Record<string, string> = {
  init: "Usage: trekoon init [--json|--toon]",
  quickstart:
    "Usage: trekoon quickstart [--json|--toon] (canonical AI loop: --toon sync status -> --toon task ready/task next -> --toon dep reverse -> --toon status updates)",
  wipe: "Usage: trekoon wipe --yes [--json|--toon]",
  epic:
    "Usage: trekoon epic <subcommand> [options] (list defaults: open statuses + limit 10; list flags: --status <csv> | --limit <n> | --cursor <n> | --all | --view table|compact; --cursor is offset-like and machine pagination uses meta.pagination.hasMore/nextCursor; --all is mutually exclusive with --status/--limit/--cursor; show: compact=epic summary, tree=hierarchy, detail=descriptions, and --all defaults to detail in machine modes; update bulk flags: --all | --ids <csv> with --append <text> and/or --status <status>)",
  task:
    "Usage: trekoon task <subcommand> [options] (list defaults: open statuses + limit 10; list flags: --status <csv> | --limit <n> | --cursor <n> | --all | --view table|compact; --cursor is offset-like and machine pagination uses meta.pagination.hasMore/nextCursor; --all is mutually exclusive with --status/--limit/--cursor; show: compact=task summary, tree=hierarchy, detail=descriptions, and --all defaults to detail in machine modes; ready: deterministic unblocked candidates sorted by status, blockers, createdAt, id with --limit <n> and --epic <id>; next: top ready candidate with --epic <id>; update bulk flags: --all | --ids <csv> with --append <text> and/or --status <status>)",
  subtask:
    "Usage: trekoon subtask <subcommand> [options] (list defaults: open statuses + limit 10; list flags: --task <id> | --status <csv> | --limit <n> | --cursor <n> | --all | --view table|compact; --cursor is offset-like and machine pagination uses meta.pagination.hasMore/nextCursor; --all is mutually exclusive with --status/--limit/--cursor; update bulk flags: --all | --ids <csv> with --append <text> and/or --status <status>)",
  dep: DEP_HELP,
  events: EVENTS_HELP,
  migrate: MIGRATE_HELP,
  sync: "Usage: trekoon sync <subcommand> [options]",
  skills:
    "Usage: trekoon skills install [--link --editor opencode|claude|pi] [--to <path>] [--allow-outside-repo] | trekoon skills update (--to sets symlink root for --link only; install path always <cwd>/.agents/skills/trekoon/SKILL.md; links must resolve inside repo unless --allow-outside-repo is set; update refreshes canonical SKILL and reports default link states)",
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
      version: CLI_VERSION,
    },
  });
}
