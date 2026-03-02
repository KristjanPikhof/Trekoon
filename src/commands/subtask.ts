import { hasFlag, parseArgs, readEnumOption, readMissingOptionValue, readOption } from "./arg-parser";

import { DomainError, type SubtaskRecord } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatSubtask(subtask: SubtaskRecord): string {
  return `${subtask.id} | task=${subtask.taskId} | ${subtask.title} | ${subtask.status}`;
}

const VIEW_MODES = ["table", "compact"] as const;

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
        const subtask = domain.createSubtask({
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
          readMissingOptionValue(parsed.missingOptionValues, "task", "t");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("subtask.list", missingListOption);
        }

        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
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

        const taskId: string | undefined = readOption(parsed.options, "task", "t") ?? parsed.positional[1];
        const subtasks = domain.listSubtasks(taskId);
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
