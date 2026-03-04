import { hasFlag, parseArgs, parseStrictPositiveInt, readEnumOption, readMissingOptionValue, readOption } from "./arg-parser";

import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError, type EpicRecord } from "../domain/types";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatEpic(epic: EpicRecord): string {
  return `${epic.id} | ${epic.title} | ${epic.status}`;
}

const VIEW_MODES = ["table", "compact", "tree", "detail"] as const;
const LIST_VIEW_MODES = ["table", "compact"] as const;
const DEFAULT_LIST_LIMIT = 10;
const DEFAULT_OPEN_STATUSES = ["in_progress", "in-progress", "todo"] as const;

function parseStatusCsv(rawStatuses: string | undefined): string[] | undefined {
  if (rawStatuses === undefined) {
    return undefined;
  }

  return rawStatuses
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function getStatusPriority(status: string): number {
  if (status === "in_progress" || status === "in-progress") {
    return 0;
  }

  if (status === "todo") {
    return 1;
  }

  return 2;
}

function sortByStatusPriority(epics: readonly EpicRecord[]): EpicRecord[] {
  return [...epics].sort((left, right) => getStatusPriority(left.status) - getStatusPriority(right.status));
}

function filterSortAndLimitEpics(epics: readonly EpicRecord[], options: { includeAll: boolean; statuses: readonly string[] | undefined; limit: number | undefined }): EpicRecord[] {
  const { includeAll, statuses, limit } = options;
  const selectedStatuses = includeAll ? undefined : (statuses ?? DEFAULT_OPEN_STATUSES);
  const selectedEpics = selectedStatuses === undefined ? [...epics] : epics.filter((epic) => selectedStatuses.includes(epic.status));
  const sortedEpics = sortByStatusPriority(selectedEpics);

  if (includeAll) {
    return sortedEpics;
  }

  const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
  return sortedEpics.slice(0, effectiveLimit);
}

function invalidEpicListInput(human: string, message: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command: "epic.list",
    human,
    data,
    error: {
      code: "invalid_input",
      message,
    },
  });
}

function failMissingOptionValue(command: string, option: string): CliResult {
  return failResult({
    command,
    human: `Option --${option} requires a value.`,
    data: {
      code: "invalid_input",
      option,
    },
    error: {
      code: "invalid_input",
      message: `Option --${option} requires a value`,
    },
  });
}

function parseIdsOption(rawIds: string | undefined): string[] {
  if (rawIds === undefined) {
    return [];
  }

  return rawIds
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function appendLine(existing: string, line: string): string {
  return existing.length > 0 ? `${existing}\n${line}` : line;
}

function formatEpicListTable(epics: readonly EpicRecord[]): string {
  const rows = epics.map((epic) => [epic.id, epic.title, epic.status]);
  return formatHumanTable(["ID", "TITLE", "STATUS"], rows, { wrapColumns: [1] });
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
  sections.push(
    formatHumanTable(["ID", "TITLE", "STATUS", "DESCRIPTION"], [[tree.id, tree.title, tree.status, tree.description]], {
      wrapColumns: [1, 3],
    }),
  );

  if (tree.tasks.length === 0) {
    sections.push("\nTASKS\nNo tasks found.");
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nTASKS");
  sections.push(
    formatHumanTable(
      ["ID", "TITLE", "STATUS", "DESCRIPTION"],
      tree.tasks.map((task) => [task.id, task.title, task.status, task.description]),
      { wrapColumns: [1, 3] },
    ),
  );

  const subtaskRows = tree.tasks.flatMap((task) =>
    task.subtasks.map((subtask) => [subtask.id, task.id, subtask.title, subtask.status, subtask.description]),
  );
  if (subtaskRows.length === 0) {
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nSUBTASKS");
  sections.push(formatHumanTable(["ID", "TASK", "TITLE", "STATUS", "DESCRIPTION"], subtaskRows, { wrapColumns: [2, 4] }));
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
    const mutations = new MutationService(database.db, context.cwd);

    switch (subcommand) {
      case "create": {
        const missingCreateOption =
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d");
        if (missingCreateOption !== undefined) {
          return failMissingOptionValue("epic.create", missingCreateOption);
        }

        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const epic = mutations.createEpic({
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
        const missingListOption =
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "view");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("epic.list", missingListOption);
        }

        const includeAll: boolean = hasFlag(parsed.flags, "all");
        const rawStatuses: string | undefined = readOption(parsed.options, "status");
        const rawLimit: string | undefined = readOption(parsed.options, "limit");
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        if (rawView !== undefined && view === undefined) {
          return invalidEpicListInput("Invalid --view value. Use: table, compact", "Invalid --view value", {
            view: rawView,
            allowedViews: LIST_VIEW_MODES,
          });
        }

        if (view !== undefined && view !== "table" && view !== "compact") {
          return invalidEpicListInput("Invalid --view for epic list. Use: table, compact", "Invalid --view for epic list", {
            view,
            allowedViews: LIST_VIEW_MODES,
          });
        }

        if (includeAll && rawStatuses !== undefined) {
          return invalidEpicListInput("Use either --all or --status, not both.", "--all and --status are mutually exclusive", {
            code: "invalid_input",
            flags: ["all", "status"],
          });
        }

        if (includeAll && rawLimit !== undefined) {
          return invalidEpicListInput("Use either --all or --limit, not both.", "--all and --limit are mutually exclusive", {
            code: "invalid_input",
            flags: ["all", "limit"],
          });
        }

        const statuses = parseStatusCsv(rawStatuses);
        if (rawStatuses !== undefined && statuses !== undefined && statuses.length === 0) {
          return invalidEpicListInput("Invalid --status value. Provide at least one status.", "Invalid --status value", {
            code: "invalid_input",
            status: rawStatuses,
          });
        }

        const limit = parseStrictPositiveInt(rawLimit);
        if (Number.isNaN(limit)) {
          return invalidEpicListInput("Invalid --limit value. Use an integer >= 1.", "Invalid --limit value", {
            code: "invalid_input",
            limit: rawLimit,
          });
        }

        const epics = filterSortAndLimitEpics(domain.listEpics(), {
          includeAll,
          statuses,
          limit,
        });
        const listView = view ?? "table";
        const human = epics.length === 0 ? "No epics found." : listView === "compact" ? epics.map(formatEpic).join("\n") : formatEpicListTable(epics);

        return okResult({
          command: "epic.list",
          human,
          data: { epics },
        });
      }
      case "show": {
        const missingShowOption = readMissingOptionValue(parsed.missingOptionValues, "view");
        if (missingShowOption !== undefined) {
          return failMissingOptionValue("epic.show", missingShowOption);
        }

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

        const effectiveView = view ?? (context.mode === "human" ? "table" : includeAll ? "detail" : "tree");

        if (effectiveView === "compact") {
          const epic = domain.getEpicOrThrow(epicId);

          return okResult({
            command: "epic.show",
            human: formatEpic(epic),
            data: { epic, includeAll: false },
          });
        }

        if (effectiveView === "tree") {
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
        const missingUpdateOption =
          readMissingOptionValue(parsed.missingOptionValues, "ids") ??
          readMissingOptionValue(parsed.missingOptionValues, "append") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s");
        if (missingUpdateOption !== undefined) {
          return failMissingOptionValue("epic.update", missingUpdateOption);
        }

        const epicId: string = parsed.positional[1] ?? "";
        const updateAll: boolean = hasFlag(parsed.flags, "all");
        const rawIds: string | undefined = readOption(parsed.options, "ids");
        const ids = parseIdsOption(rawIds);
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const append: string | undefined = readOption(parsed.options, "append");
        const status: string | undefined = readOption(parsed.options, "status", "s");

        if (updateAll && ids.length > 0) {
          return failResult({
            command: "epic.update",
            human: "Use either --all or --ids, not both.",
            data: { code: "invalid_input", target: ["all", "ids"] },
            error: {
              code: "invalid_input",
              message: "--all and --ids are mutually exclusive",
            },
          });
        }

        if (append !== undefined && description !== undefined) {
          return failResult({
            command: "epic.update",
            human: "Use either --append or --description, not both.",
            data: { code: "invalid_input", fields: ["append", "description"] },
            error: {
              code: "invalid_input",
              message: "--append and --description are mutually exclusive",
            },
          });
        }

        const hasBulkTarget = updateAll || ids.length > 0;
        if (hasBulkTarget) {
          if (epicId.length > 0) {
            return failResult({
              command: "epic.update",
              human: "Do not pass an epic id when using --all or --ids.",
              data: { code: "invalid_input", id: epicId },
              error: {
                code: "invalid_input",
                message: "Positional id is not allowed with --all/--ids",
              },
            });
          }

          if (title !== undefined || description !== undefined) {
            return failResult({
              command: "epic.update",
              human: "Bulk update supports only --append and/or --status.",
              data: { code: "invalid_input" },
              error: {
                code: "invalid_input",
                message: "Bulk update supports only --append and --status",
              },
            });
          }

          if (append === undefined && status === undefined) {
            return failResult({
              command: "epic.update",
              human: "Bulk update requires --append and/or --status.",
              data: { code: "invalid_input" },
              error: {
                code: "invalid_input",
                message: "Missing bulk update fields",
              },
            });
          }

          const targets = updateAll ? [...domain.listEpics()] : ids.map((id) => domain.getEpicOrThrow(id));
          const epics = targets.map((target) =>
            mutations.updateEpic(target.id, {
              status,
              description: append === undefined ? undefined : appendLine(target.description, append),
            }),
          );

          return okResult({
            command: "epic.update",
            human: `Updated ${epics.length} epic(s)`,
            data: {
              epics,
              target: updateAll ? "all" : "ids",
              ids: epics.map((epic) => epic.id),
            },
          });
        }

        if (epicId.length === 0) {
          return failResult({
            command: "epic.update",
            human: "Provide an epic id, or use --all/--ids for bulk update.",
            data: { code: "invalid_input" },
            error: {
              code: "invalid_input",
              message: "Missing epic id",
            },
          });
        }

        const nextDescription =
          append === undefined
            ? description
            : appendLine(domain.getEpicOrThrow(epicId).description, append);
        const epic = mutations.updateEpic(epicId, { title, description: nextDescription, status });

        return okResult({
          command: "epic.update",
          human: `Updated epic ${formatEpic(epic)}`,
          data: { epic },
        });
      }
      case "delete": {
        const epicId: string = parsed.positional[1] ?? "";
        mutations.deleteEpic(epicId);

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
