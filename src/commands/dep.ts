import { parseArgs } from "./arg-parser";

import { DomainError } from "../domain/types";
import { TrackerDomain } from "../domain/tracker-domain";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase } from "../storage/database";

function failFromError(error: unknown): CliResult {
  if (error instanceof DomainError) {
    return failResult({
      command: "dep",
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
    command: "dep",
    human: "Unexpected dep command failure",
    data: {},
    error: {
      code: "internal_error",
      message: "Unexpected dep command failure",
    },
  });
}

export async function runDep(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const sourceId: string = parsed.positional[1] ?? "";
    const dependsOnId: string = parsed.positional[2] ?? "";
    const domain = new TrackerDomain(database.db);

    switch (subcommand) {
      case "add": {
        const dependency = domain.addDependency(sourceId, dependsOnId);

        return okResult({
          command: "dep.add",
          human: `Added dependency ${dependency.sourceId} -> ${dependency.dependsOnId}`,
          data: { dependency },
        });
      }
      case "remove": {
        const removed: number = domain.removeDependency(sourceId, dependsOnId);

        return okResult({
          command: "dep.remove",
          human:
            removed > 0
              ? `Removed dependency ${sourceId} -> ${dependsOnId}`
              : `No dependency found for ${sourceId} -> ${dependsOnId}`,
          data: {
            sourceId,
            dependsOnId,
            removed,
          },
        });
      }
      case "list": {
        const dependencies = domain.listDependencies(sourceId);

        return okResult({
          command: "dep.list",
          human:
            dependencies.length === 0
              ? `No dependencies for ${sourceId}`
              : dependencies.map((item) => `${item.sourceId} -> ${item.dependsOnId}`).join("\n"),
          data: {
            sourceId,
            dependencies,
          },
        });
      }
      default:
        return failResult({
          command: "dep",
          human: "Usage: trekoon dep <add|remove|list>",
          data: {
            args: context.args,
          },
          error: {
            code: "invalid_subcommand",
            message: "Invalid dep subcommand",
          },
        });
    }
  } catch (error: unknown) {
    return failFromError(error);
  } finally {
    database.close();
  }
}
