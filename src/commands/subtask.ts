import { parseArgs, readOption } from "./arg-parser";

import { DomainError, type SubtaskRecord } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatSubtask(subtask: SubtaskRecord): string {
  return `${subtask.id} | task=${subtask.taskId} | ${subtask.title} | ${subtask.status}`;
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

export async function runSubtask(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);

    switch (subcommand) {
      case "create": {
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
        const taskId: string | undefined = readOption(parsed.options, "task", "t") ?? parsed.positional[1];
        const subtasks = domain.listSubtasks(taskId);
        const human = subtasks.length === 0 ? "No subtasks found." : subtasks.map(formatSubtask).join("\n");

        return okResult({
          command: "subtask.list",
          human,
          data: { subtasks },
        });
      }
      case "update": {
        const subtaskId: string = parsed.positional[1] ?? "";
        const title: string | undefined = readOption(parsed.options, "title");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");
        const subtask = domain.updateSubtask(subtaskId, { title, description, status });

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
