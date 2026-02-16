import { hasFlag, parseArgs, readOption } from "./arg-parser";

import { DomainError, type TaskRecord } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatTask(task: TaskRecord): string {
  return `${task.id} | epic=${task.epicId} | ${task.title} | ${task.status}`;
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
        const epicId: string | undefined = readOption(parsed.options, "epic", "e");
        const tasks = domain.listTasks(epicId);
        const human = tasks.length === 0 ? "No tasks found." : tasks.map(formatTask).join("\n");

        return okResult({
          command: "task.list",
          human,
          data: { tasks },
        });
      }
      case "show": {
        const taskId: string = parsed.positional[1] ?? "";
        const includeAll: boolean = hasFlag(parsed.flags, "all");

        if (!includeAll) {
          const task = domain.getTaskOrThrow(taskId);

          return okResult({
            command: "task.show",
            human: formatTask(task),
            data: { task, includeAll: false },
          });
        }

        const taskTree = domain.buildTaskTreeDetailed(taskId);
        const humanLines: string[] = [
          `${taskTree.id} | epic=${taskTree.epicId} | ${taskTree.title} | ${taskTree.status} | desc=${taskTree.description}`,
        ];

        for (const subtask of taskTree.subtasks) {
          humanLines.push(
            `  subtask ${subtask.id} | ${subtask.title} | ${subtask.status} | desc=${subtask.description}`,
          );
        }

        return okResult({
          command: "task.show",
          human: humanLines.join("\n"),
          data: { task: taskTree, includeAll: true },
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
