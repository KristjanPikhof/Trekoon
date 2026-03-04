import { hasFlag, parseArgs, parseStrictPositiveInt, readEnumOption, readMissingOptionValue, readOption } from "./arg-parser";

import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError, type SubtaskRecord } from "../domain/types";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatSubtask(subtask: SubtaskRecord): string {
  return `${subtask.id} | task=${subtask.taskId} | ${subtask.title} | ${subtask.status}`;
}

const VIEW_MODES = ["table", "compact"] as const;
const DEFAULT_SUBTASK_LIST_LIMIT = 10;
const DEFAULT_OPEN_SUBTASK_STATUSES = ["in_progress", "in-progress", "todo"] as const;

function parseIdsOption(rawIds: string | undefined): string[] {
  if (rawIds === undefined) {
    return [];
  }

  return rawIds
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function parseStatusCsv(rawStatuses: string | undefined): string[] | undefined {
  if (rawStatuses === undefined) {
    return undefined;
  }

  return rawStatuses
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function subtaskStatusPriority(status: string): number {
  if (status === "in_progress" || status === "in-progress") {
    return 0;
  }

  if (status === "todo") {
    return 1;
  }

  return 2;
}

function filterSortAndLimitSubtasks(
  subtasks: readonly SubtaskRecord[],
  statuses: readonly string[] | undefined,
  limit: number | undefined,
): SubtaskRecord[] {
  const allowedStatuses = statuses === undefined ? undefined : new Set(statuses);
  const filtered = allowedStatuses === undefined ? [...subtasks] : subtasks.filter((subtask) => allowedStatuses.has(subtask.status));
  const sorted = [...filtered].sort((left, right) => subtaskStatusPriority(left.status) - subtaskStatusPriority(right.status));

  if (limit === undefined) {
    return sorted;
  }

  return sorted.slice(0, limit);
}

function appendLine(existing: string, line: string): string {
  return existing.length > 0 ? `${existing}\n${line}` : line;
}

function formatSubtaskListTable(subtasks: readonly SubtaskRecord[]): string {
  return formatHumanTable(
    ["ID", "TASK", "TITLE", "STATUS"],
    subtasks.map((subtask) => [subtask.id, subtask.taskId, subtask.title, subtask.status]),
    { wrapColumns: [2] },
  );
}

function failFromError(error: unknown): CliResult {
  if (error instanceof DomainError) {
    return failResult({
      command: "subtask",
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
    command: "subtask",
    human: "Unexpected subtask command failure",
    data: {},
    error: {
      code: "internal_error",
      message: "Unexpected subtask command failure",
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

export async function runSubtask(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);
    const mutations = new MutationService(database.db, context.cwd);

    switch (subcommand) {
      case "create": {
        const missingCreateOption =
          readMissingOptionValue(parsed.missingOptionValues, "task", "t") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s");
        if (missingCreateOption !== undefined) {
          return failMissingOptionValue("subtask.create", missingCreateOption);
        }

        const taskId: string | undefined = readOption(parsed.options, "task", "t") ?? parsed.positional[1];
        const title: string | undefined = readOption(parsed.options, "title") ?? parsed.positional[2];
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const subtask = mutations.createSubtask({
          taskId: taskId ?? "",
          title: title ?? "",
          description,
          status,
        });

        return okResult({
          command: "subtask.create",
          human: `Created subtask ${formatSubtask(subtask)}`,
          data: { subtask },
        });
      }
      case "list": {
        const missingListOption =
          readMissingOptionValue(parsed.missingOptionValues, "view") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "task", "t");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("subtask.list", missingListOption);
        }

        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        const includeAll = hasFlag(parsed.flags, "all");
        const rawStatuses = readOption(parsed.options, "status", "s");
        const rawLimit = readOption(parsed.options, "limit", "l");

        if (rawView !== undefined && view === undefined) {
          return failResult({
            command: "subtask.list",
            human: "Invalid --view value. Use: table, compact",
            data: { view: rawView, allowedViews: VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view value",
            },
          });
        }

        if (includeAll && rawStatuses !== undefined) {
          return failResult({
            command: "subtask.list",
            human: "Use either --all or --status, not both.",
            data: { code: "invalid_input", flags: ["all", "status"] },
            error: {
              code: "invalid_input",
              message: "--all and --status are mutually exclusive",
            },
          });
        }

        if (includeAll && rawLimit !== undefined) {
          return failResult({
            command: "subtask.list",
            human: "Use either --all or --limit, not both.",
            data: { code: "invalid_input", flags: ["all", "limit"] },
            error: {
              code: "invalid_input",
              message: "--all and --limit are mutually exclusive",
            },
          });
        }

        const statuses = parseStatusCsv(rawStatuses);
        if (rawStatuses !== undefined && statuses !== undefined && statuses.length === 0) {
          return failResult({
            command: "subtask.list",
            human: "Provide at least one status with --status.",
            data: { code: "invalid_input", status: rawStatuses },
            error: {
              code: "invalid_input",
              message: "Invalid --status value",
            },
          });
        }

        const parsedLimit = parseStrictPositiveInt(rawLimit);
        if (Number.isNaN(parsedLimit)) {
          return failResult({
            command: "subtask.list",
            human: "Invalid --limit value. Use an integer >= 1.",
            data: { code: "invalid_input", limit: rawLimit },
            error: {
              code: "invalid_input",
              message: "Invalid --limit value",
            },
          });
        }

        const taskId: string | undefined = readOption(parsed.options, "task", "t") ?? parsed.positional[1];
        const selectedStatuses = includeAll
          ? undefined
          : statuses ?? [...DEFAULT_OPEN_SUBTASK_STATUSES];
        const selectedLimit = includeAll
          ? undefined
          : parsedLimit ?? DEFAULT_SUBTASK_LIST_LIMIT;
        const subtasks = filterSortAndLimitSubtasks(domain.listSubtasks(taskId), selectedStatuses, selectedLimit);
        const listView = view ?? "table";
        const human =
          subtasks.length === 0
            ? "No subtasks found."
            : listView === "compact"
              ? subtasks.map(formatSubtask).join("\n")
              : formatSubtaskListTable(subtasks);

        return okResult({
          command: "subtask.list",
          human,
          data: { subtasks },
        });
      }
      case "update": {
        const missingUpdateOption =
          readMissingOptionValue(parsed.missingOptionValues, "ids") ??
          readMissingOptionValue(parsed.missingOptionValues, "append") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s");
        if (missingUpdateOption !== undefined) {
          return failMissingOptionValue("subtask.update", missingUpdateOption);
        }

        const subtaskId: string = parsed.positional[1] ?? "";
        const updateAll: boolean = hasFlag(parsed.flags, "all");
        const rawIds: string | undefined = readOption(parsed.options, "ids");
        const ids = parseIdsOption(rawIds);
        const title: string | undefined = readOption(parsed.options, "title");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const append: string | undefined = readOption(parsed.options, "append");
        const status: string | undefined = readOption(parsed.options, "status", "s");

        if (updateAll && ids.length > 0) {
          return failResult({
            command: "subtask.update",
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
            command: "subtask.update",
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
          if (subtaskId.length > 0) {
            return failResult({
              command: "subtask.update",
              human: "Do not pass a subtask id when using --all or --ids.",
              data: { code: "invalid_input", id: subtaskId },
              error: {
                code: "invalid_input",
                message: "Positional id is not allowed with --all/--ids",
              },
            });
          }

          if (title !== undefined || description !== undefined) {
            return failResult({
              command: "subtask.update",
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
              command: "subtask.update",
              human: "Bulk update requires --append and/or --status.",
              data: { code: "invalid_input" },
              error: {
                code: "invalid_input",
                message: "Missing bulk update fields",
              },
            });
          }

          const targets = updateAll ? [...domain.listSubtasks()] : ids.map((id) => domain.getSubtaskOrThrow(id));
          const subtasks = targets.map((target) =>
            domain.updateSubtask(target.id, {
              status,
              description: append === undefined ? undefined : appendLine(target.description, append),
            }),
          );

          return okResult({
            command: "subtask.update",
            human: `Updated ${subtasks.length} subtask(s)`,
            data: {
              subtasks,
              target: updateAll ? "all" : "ids",
              ids: subtasks.map((subtask) => subtask.id),
            },
          });
        }

        if (subtaskId.length === 0) {
          return failResult({
            command: "subtask.update",
            human: "Provide a subtask id, or use --all/--ids for bulk update.",
            data: { code: "invalid_input" },
            error: {
              code: "invalid_input",
              message: "Missing subtask id",
            },
          });
        }

        const nextDescription =
          append === undefined
            ? description
            : appendLine(domain.getSubtaskOrThrow(subtaskId).description, append);
        const subtask = domain.updateSubtask(subtaskId, { title, description: nextDescription, status });

        return okResult({
          command: "subtask.update",
          human: `Updated subtask ${formatSubtask(subtask)}`,
          data: { subtask },
        });
      }
      case "delete": {
        const subtaskId: string = parsed.positional[1] ?? "";
        domain.deleteSubtask(subtaskId);

        return okResult({
          command: "subtask.delete",
          human: `Deleted subtask ${subtaskId}`,
          data: { id: subtaskId },
        });
      }
      default:
        return failResult({
          command: "subtask",
          human: "Usage: trekoon subtask <create|list|update|delete>",
          data: {
            args: context.args,
          },
          error: {
            code: "invalid_subcommand",
            message: "Invalid subtask subcommand",
          },
        });
    }
  } catch (error: unknown) {
    return failFromError(error);
  } finally {
    database.close();
  }
}
