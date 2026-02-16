import { hasFlag, parseArgs, readEnumOption, readOption } from "./arg-parser";

import { DomainError, type EpicRecord } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatEpic(epic: EpicRecord): string {
  return `${epic.id} | ${epic.title} | ${epic.status}`;
}

const VIEW_MODES = ["table", "compact", "tree", "detail"] as const;
const LIST_VIEW_MODES = ["table", "compact"] as const;

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths: number[] = headers.map((header, index) => {
    const rowMax = rows.reduce((max, row) => Math.max(max, (row[index] ?? "").length), 0);
    return Math.max(header.length, rowMax);
  });

  const formatRow = (row: readonly string[]): string =>
    row.map((cell, index) => (cell ?? "").padEnd(widths[index] ?? 0)).join(" | ");

  const divider = widths.map((width) => "-".repeat(width)).join("-+-");
  return [formatRow(headers), divider, ...rows.map(formatRow)].join("\n");
}

function formatEpicListTable(epics: readonly EpicRecord[]): string {
  const rows = epics.map((epic) => [epic.id, epic.title, epic.status]);
  return formatTable(["ID", "TITLE", "STATUS"], rows);
}

function formatEpicShowCompact(tree: {
  id: string;
  title: string;
  status: string;
  tasks: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  }>;
}): string {
  const humanLines: string[] = [`${tree.id} | ${tree.title} | ${tree.status}`];

  for (const task of tree.tasks) {
    humanLines.push(`  task ${task.id} | ${task.title} | ${task.status}`);
    for (const subtask of task.subtasks) {
      humanLines.push(`    subtask ${subtask.id} | ${subtask.title} | ${subtask.status}`);
    }
  }

  return humanLines.join("\n");
}

function formatEpicShowDetailed(tree: {
  id: string;
  title: string;
  description: string;
  status: string;
  tasks: ReadonlyArray<{
    id: string;
    title: string;
    description: string;
    status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; description: string; status: string }>;
  }>;
}): string {
  const humanLines: string[] = [`${tree.id} | ${tree.title} | ${tree.status} | desc=${tree.description}`];

  for (const task of tree.tasks) {
    humanLines.push(`  task ${task.id} | ${task.title} | ${task.status} | desc=${task.description}`);
    for (const subtask of task.subtasks) {
      humanLines.push(`    subtask ${subtask.id} | ${subtask.title} | ${subtask.status} | desc=${subtask.description}`);
    }
  }

  return humanLines.join("\n");
}

function formatEpicShowTable(tree: {
  id: string;
  title: string;
  description: string;
  status: string;
  tasks: ReadonlyArray<{
    id: string;
    title: string;
    description: string;
    status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; description: string; status: string }>;
  }>;
}): string {
  const sections: string[] = [];
  sections.push("EPIC");
  sections.push(formatTable(["ID", "TITLE", "STATUS", "DESCRIPTION"], [[tree.id, tree.title, tree.status, tree.description]]));

  if (tree.tasks.length === 0) {
    sections.push("\nTASKS\nNo tasks found.");
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nTASKS");
  sections.push(
    formatTable(
      ["ID", "TITLE", "STATUS", "DESCRIPTION"],
      tree.tasks.map((task) => [task.id, task.title, task.status, task.description]),
    ),
  );

  const subtaskRows = tree.tasks.flatMap((task) => task.subtasks.map((subtask) => [subtask.id, task.id, subtask.title, subtask.status]));
  if (subtaskRows.length === 0) {
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nSUBTASKS");
  sections.push(formatTable(["ID", "TASK", "TITLE", "STATUS"], subtaskRows));
  return sections.join("\n");
}

function failFromError(error: unknown, command: string): CliResult {
  if (error instanceof DomainError) {
    return failResult({
      command,
      human: error.message,
      data: {
        code: error.code,
        ...(error.details ?? {}),
      },
      error: {
        code: error.code,
        message: error.message,
      },
    });
  }

  return failResult({
    command,
    human: "Unexpected epic command failure",
    data: {},
    error: {
      code: "internal_error",
      message: "Unexpected epic command failure",
    },
  });
}

export async function runEpic(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);

    switch (subcommand) {
      case "create": {
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const epic = domain.createEpic({
          title: title ?? "",
          description: description ?? "",
          status,
        });

        return okResult({
          command: "epic.create",
          human: `Created epic ${formatEpic(epic)}`,
          data: { epic },
        });
      }
      case "list": {
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        if (rawView !== undefined && view === undefined) {
          return failResult({
            command: "epic.list",
            human: "Invalid --view value. Use: table, compact",
            data: { view: rawView, allowedViews: LIST_VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view value",
            },
          });
        }

        if (view !== undefined && view !== "table" && view !== "compact") {
          return failResult({
            command: "epic.list",
            human: "Invalid --view for epic list. Use: table, compact",
            data: { view, allowedViews: LIST_VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view for epic list",
            },
          });
        }

        const epics = domain.listEpics();
        const listView = view ?? "table";
        const human = epics.length === 0 ? "No epics found." : listView === "compact" ? epics.map(formatEpic).join("\n") : formatEpicListTable(epics);

        return okResult({
          command: "epic.list",
          human,
          data: { epics },
        });
      }
      case "show": {
        const epicId: string = parsed.positional[1] ?? "";
        const includeAll: boolean = hasFlag(parsed.flags, "all");
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        if (rawView !== undefined && view === undefined) {
          return failResult({
            command: "epic.show",
            human: "Invalid --view value. Use: table, compact, tree, detail",
            data: { view: rawView, allowedViews: VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view value",
            },
          });
        }

        const effectiveView = view ?? (includeAll ? "detail" : "tree");

        if (effectiveView === "compact" || effectiveView === "tree") {
          const tree = domain.buildEpicTree(epicId);

          return okResult({
            command: "epic.show",
            human: formatEpicShowCompact(tree),
            data: { tree, includeAll: false },
          });
        }

        const tree = domain.buildEpicTreeDetailed(epicId);

        return okResult({
          command: "epic.show",
          human: effectiveView === "table" ? formatEpicShowTable(tree) : formatEpicShowDetailed(tree),
          data: { tree, includeAll: true },
        });
      }
      case "update": {
        const epicId: string = parsed.positional[1] ?? "";
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const epic = domain.updateEpic(epicId, { title, description, status });

        return okResult({
          command: "epic.update",
          human: `Updated epic ${formatEpic(epic)}`,
          data: { epic },
        });
      }
      case "delete": {
        const epicId: string = parsed.positional[1] ?? "";
        domain.deleteEpic(epicId);

        return okResult({
          command: "epic.delete",
          human: `Deleted epic ${epicId}`,
          data: { id: epicId },
        });
      }
      default:
        return failResult({
          command: "epic",
          human: "Usage: trekoon epic <create|list|show|update|delete>",
          data: {
            args: context.args,
          },
          error: {
            code: "invalid_subcommand",
            message: "Invalid epic subcommand",
          },
        });
    }
  } catch (error: unknown) {
    return failFromError(error, "epic");
  } finally {
    database.close();
  }
}
