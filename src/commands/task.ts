import { hasFlag, parseArgs, parseStrictPositiveInt, readEnumOption, readMissingOptionValue, readOption } from "./arg-parser";

import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError, type TaskRecord } from "../domain/types";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatTask(task: TaskRecord): string {
  return `${task.id} | epic=${task.epicId} | ${task.title} | ${task.status}`;
}

const VIEW_MODES = ["table", "compact", "tree", "detail"] as const;
const LIST_VIEW_MODES = ["table", "compact"] as const;
const DEFAULT_TASK_LIST_LIMIT = 10;
const DEFAULT_OPEN_TASK_STATUSES = ["in_progress", "in-progress", "todo"] as const;

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

function taskStatusPriority(status: string): number {
  if (status === "in_progress" || status === "in-progress") {
    return 0;
  }

  if (status === "todo") {
    return 1;
  }

  return 2;
}

function filterSortAndLimitTasks(
  tasks: readonly TaskRecord[],
  statuses: readonly string[] | undefined,
  limit: number | undefined,
): TaskRecord[] {
  const allowedStatuses = statuses === undefined ? undefined : new Set(statuses);
  const filtered = allowedStatuses === undefined ? [...tasks] : tasks.filter((task) => allowedStatuses.has(task.status));
  const sorted = [...filtered].sort((left, right) => taskStatusPriority(left.status) - taskStatusPriority(right.status));

  if (limit === undefined) {
    return sorted;
  }

  return sorted.slice(0, limit);
}

function appendLine(existing: string, line: string): string {
  return existing.length > 0 ? `${existing}\n${line}` : line;
}

function formatTaskListTable(tasks: readonly TaskRecord[]): string {
  const rows = tasks.map((task) => [task.id, task.epicId, task.title, task.status]);
  return formatHumanTable(["ID", "EPIC", "TITLE", "STATUS"], rows, { wrapColumns: [2] });
}

function formatTaskShowDetail(taskTree: {
  id: string;
  epicId: string;
  title: string;
  description: string;
  status: string;
  subtasks: ReadonlyArray<{ id: string; title: string; description: string; status: string }>;
}): string {
  const humanLines: string[] = [
    `${taskTree.id} | epic=${taskTree.epicId} | ${taskTree.title} | ${taskTree.status} | desc=${taskTree.description}`,
  ];

  for (const subtask of taskTree.subtasks) {
    humanLines.push(`  subtask ${subtask.id} | ${subtask.title} | ${subtask.status} | desc=${subtask.description}`);
  }

  return humanLines.join("\n");
}

function formatTaskShowTree(taskTree: {
  id: string;
  epicId: string;
  title: string;
  status: string;
  subtasks: ReadonlyArray<{ id: string; title: string; status: string }>;
}): string {
  const humanLines: string[] = [`${taskTree.id} | epic=${taskTree.epicId} | ${taskTree.title} | ${taskTree.status}`];
  for (const subtask of taskTree.subtasks) {
    humanLines.push(`  subtask ${subtask.id} | ${subtask.title} | ${subtask.status}`);
  }

  return humanLines.join("\n");
}

function formatTaskShowTable(taskTree: {
  id: string;
  epicId: string;
  title: string;
  description: string;
  status: string;
  subtasks: ReadonlyArray<{ id: string; title: string; description: string; status: string }>;
}): string {
  const sections: string[] = [];
  sections.push("TASK");
  sections.push(
    formatHumanTable(
      ["ID", "EPIC", "TITLE", "STATUS", "DESCRIPTION"],
      [[taskTree.id, taskTree.epicId, taskTree.title, taskTree.status, taskTree.description]],
      { wrapColumns: [2, 4] },
    ),
  );

  if (taskTree.subtasks.length === 0) {
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nSUBTASKS");
  sections.push(
    formatHumanTable(
      ["ID", "TITLE", "STATUS", "DESCRIPTION"],
      taskTree.subtasks.map((subtask) => [subtask.id, subtask.title, subtask.status, subtask.description]),
      { wrapColumns: [1, 3] },
    ),
  );
  return sections.join("\n");
}

function failFromError(error: unknown): CliResult {
  if (error instanceof DomainError) {
    return failResult({
      command: "task",
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
    command: "task",
    human: "Unexpected task command failure",
    data: {},
    error: {
      code: "internal_error",
      message: "Unexpected task command failure",
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

export async function runTask(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);
    const mutations = new MutationService(database.db, context.cwd);

    switch (subcommand) {
      case "create": {
        const missingCreateOption =
          readMissingOptionValue(parsed.missingOptionValues, "epic", "e") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s");
        if (missingCreateOption !== undefined) {
          return failMissingOptionValue("task.create", missingCreateOption);
        }

        const epicId: string | undefined = readOption(parsed.options, "epic", "e");
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const task = mutations.createTask({
          epicId: epicId ?? "",
          title: title ?? "",
          description: description ?? "",
          status,
        });

        return okResult({
          command: "task.create",
          human: `Created task ${formatTask(task)}`,
          data: { task },
        });
      }
      case "list": {
        const missingListOption =
          readMissingOptionValue(parsed.missingOptionValues, "view") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "epic", "e");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("task.list", missingListOption);
        }

        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        const includeAll = hasFlag(parsed.flags, "all");
        const rawStatuses = readOption(parsed.options, "status", "s");
        const rawLimit = readOption(parsed.options, "limit", "l");

        if (rawView !== undefined && view === undefined) {
          return failResult({
            command: "task.list",
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
            command: "task.list",
            human: "Invalid --view for task list. Use: table, compact",
            data: { view, allowedViews: LIST_VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view for task list",
            },
          });
        }

        if (includeAll && rawStatuses !== undefined) {
          return failResult({
            command: "task.list",
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
            command: "task.list",
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
            command: "task.list",
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
            command: "task.list",
            human: "Invalid --limit value. Use an integer >= 1.",
            data: { code: "invalid_input", limit: rawLimit },
            error: {
              code: "invalid_input",
              message: "Invalid --limit value",
            },
          });
        }

        const epicId: string | undefined = readOption(parsed.options, "epic", "e");
        const selectedStatuses = includeAll
          ? undefined
          : statuses ?? [...DEFAULT_OPEN_TASK_STATUSES];
        const selectedLimit = includeAll
          ? undefined
          : parsedLimit ?? DEFAULT_TASK_LIST_LIMIT;
        const tasks = filterSortAndLimitTasks(domain.listTasks(epicId), selectedStatuses, selectedLimit);
        const listView = view ?? "table";
        const human = tasks.length === 0 ? "No tasks found." : listView === "compact" ? tasks.map(formatTask).join("\n") : formatTaskListTable(tasks);

        return okResult({
          command: "task.list",
          human,
          data: { tasks },
        });
      }
      case "show": {
        const missingShowOption = readMissingOptionValue(parsed.missingOptionValues, "view");
        if (missingShowOption !== undefined) {
          return failMissingOptionValue("task.show", missingShowOption);
        }

        const taskId: string = parsed.positional[1] ?? "";
        const includeAll: boolean = hasFlag(parsed.flags, "all");
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        if (rawView !== undefined && view === undefined) {
          return failResult({
            command: "task.show",
            human: "Invalid --view value. Use: table, compact, tree, detail",
            data: { view: rawView, allowedViews: VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view value",
            },
          });
        }

        const existingTask = domain.getTask(taskId);
        if (!existingTask) {
          const matchingEpic = domain.getEpic(taskId);
          if (matchingEpic) {
            return failResult({
              command: "task.show",
              human: `ID belongs to an epic. Use: trekoon epic show ${taskId}`,
              data: {
                code: "wrong_entity_type",
                id: taskId,
                expected: "task",
                actual: "epic",
                hint: `trekoon epic show ${taskId}`,
              },
              error: {
                code: "wrong_entity_type",
                message: `ID belongs to epic '${taskId}', not a task`,
              },
            });
          }
        }

        const effectiveView = view ?? (context.mode === "human" ? "table" : includeAll ? "detail" : "tree");

        if (effectiveView === "compact") {
          const task = existingTask ?? domain.getTaskOrThrow(taskId);

          return okResult({
            command: "task.show",
            human: formatTask(task),
            data: { task, includeAll: false },
          });
        }

        const taskTree = domain.buildTaskTreeDetailed(taskId);

        if (effectiveView === "tree") {
          return okResult({
            command: "task.show",
            human: formatTaskShowTree(taskTree),
            data: { task: taskTree, includeAll: true, subtasksCount: taskTree.subtasks.length },
          });
        }

        return okResult({
          command: "task.show",
          human: effectiveView === "table" ? formatTaskShowTable(taskTree) : formatTaskShowDetail(taskTree),
          data: { task: taskTree, includeAll: true, subtasksCount: taskTree.subtasks.length },
        });
      }
      case "update": {
        const missingUpdateOption =
          readMissingOptionValue(parsed.missingOptionValues, "ids") ??
          readMissingOptionValue(parsed.missingOptionValues, "append") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s");
        if (missingUpdateOption !== undefined) {
          return failMissingOptionValue("task.update", missingUpdateOption);
        }

        const taskId: string = parsed.positional[1] ?? "";
        const updateAll: boolean = hasFlag(parsed.flags, "all");
        const rawIds: string | undefined = readOption(parsed.options, "ids");
        const ids = parseIdsOption(rawIds);
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const append: string | undefined = readOption(parsed.options, "append");
        const status: string | undefined = readOption(parsed.options, "status", "s");

        if (updateAll && ids.length > 0) {
          return failResult({
            command: "task.update",
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
            command: "task.update",
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
          if (taskId.length > 0) {
            return failResult({
              command: "task.update",
              human: "Do not pass a task id when using --all or --ids.",
              data: { code: "invalid_input", id: taskId },
              error: {
                code: "invalid_input",
                message: "Positional id is not allowed with --all/--ids",
              },
            });
          }

          if (title !== undefined || description !== undefined) {
            return failResult({
              command: "task.update",
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
              command: "task.update",
              human: "Bulk update requires --append and/or --status.",
              data: { code: "invalid_input" },
              error: {
                code: "invalid_input",
                message: "Missing bulk update fields",
              },
            });
          }

          const targets = updateAll ? [...domain.listTasks()] : ids.map((id) => domain.getTaskOrThrow(id));
          const tasks = targets.map((target) =>
            mutations.updateTask(target.id, {
              status,
              description: append === undefined ? undefined : appendLine(target.description, append),
            }),
          );

          return okResult({
            command: "task.update",
            human: `Updated ${tasks.length} task(s)`,
            data: {
              tasks,
              target: updateAll ? "all" : "ids",
              ids: tasks.map((task) => task.id),
            },
          });
        }

        if (taskId.length === 0) {
          return failResult({
            command: "task.update",
            human: "Provide a task id, or use --all/--ids for bulk update.",
            data: { code: "invalid_input" },
            error: {
              code: "invalid_input",
              message: "Missing task id",
            },
          });
        }

        const nextDescription =
          append === undefined
            ? description
            : appendLine(domain.getTaskOrThrow(taskId).description, append);
        const task = mutations.updateTask(taskId, { title, description: nextDescription, status });

        return okResult({
          command: "task.update",
          human: `Updated task ${formatTask(task)}`,
          data: { task },
        });
      }
      case "delete": {
        const taskId: string = parsed.positional[1] ?? "";
        domain.deleteTask(taskId);

        return okResult({
          command: "task.delete",
          human: `Deleted task ${taskId}`,
          data: { id: taskId },
        });
      }
      default:
        return failResult({
          command: "task",
          human: "Usage: trekoon task <create|list|show|update|delete>",
          data: {
            args: context.args,
          },
          error: {
            code: "invalid_subcommand",
            message: "Invalid task subcommand",
          },
        });
    }
  } catch (error: unknown) {
    return failFromError(error);
  } finally {
    database.close();
  }
}
