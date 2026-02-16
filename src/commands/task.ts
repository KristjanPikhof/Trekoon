import { hasFlag, parseArgs, readEnumOption, readOption } from "./arg-parser";

import { DomainError, type TaskRecord } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatTask(task: TaskRecord): string {
  return `${task.id} | epic=${task.epicId} | ${task.title} | ${task.status}`;
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

function formatTaskListTable(tasks: readonly TaskRecord[]): string {
  const rows = tasks.map((task) => [task.id, task.epicId, task.title, task.status]);
  return formatTable(["ID", "EPIC", "TITLE", "STATUS"], rows);
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
    formatTable(["ID", "EPIC", "TITLE", "STATUS", "DESCRIPTION"], [[taskTree.id, taskTree.epicId, taskTree.title, taskTree.status, taskTree.description]]),
  );

  if (taskTree.subtasks.length === 0) {
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nSUBTASKS");
  sections.push(
    formatTable(
      ["ID", "TITLE", "STATUS", "DESCRIPTION"],
      taskTree.subtasks.map((subtask) => [subtask.id, subtask.title, subtask.status, subtask.description]),
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

export async function runTask(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);

    switch (subcommand) {
      case "create": {
        const epicId: string | undefined = readOption(parsed.options, "epic", "e");
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const task = domain.createTask({
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
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
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

        const epicId: string | undefined = readOption(parsed.options, "epic", "e");
        const tasks = domain.listTasks(epicId);
        const listView = view ?? "table";
        const human = tasks.length === 0 ? "No tasks found." : listView === "compact" ? tasks.map(formatTask).join("\n") : formatTaskListTable(tasks);

        return okResult({
          command: "task.list",
          human,
          data: { tasks },
        });
      }
      case "show": {
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

        const effectiveView = view ?? (context.mode === "human" ? "table" : includeAll ? "detail" : "compact");

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
        const taskId: string = parsed.positional[1] ?? "";
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const task = domain.updateTask(taskId, { title, description, status });

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
