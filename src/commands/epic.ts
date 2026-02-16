import { parseArgs, readOption } from "./arg-parser";

import { DomainError, type EpicRecord } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function formatEpic(epic: EpicRecord): string {
  return `${epic.id} | ${epic.title} | ${epic.status}`;
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
        const epics = domain.listEpics();
        const human = epics.length === 0 ? "No epics found." : epics.map(formatEpic).join("\n");

        return okResult({
          command: "epic.list",
          human,
          data: { epics },
        });
      }
      case "show": {
        const epicId: string = parsed.positional[1] ?? "";
        const tree = domain.buildEpicTree(epicId);
        const humanLines: string[] = [`${tree.id} | ${tree.title} | ${tree.status}`];

        for (const task of tree.tasks) {
          humanLines.push(`  task ${task.id} | ${task.title} | ${task.status}`);
          for (const subtask of task.subtasks) {
            humanLines.push(`    subtask ${subtask.id} | ${subtask.title} | ${subtask.status}`);
          }
        }

        return okResult({
          command: "epic.show",
          human: humanLines.join("\n"),
          data: { tree },
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
