import {
  findUnknownOption,
  isValidCompactTempKey,
  parseArgs,
  parseCompactEntityRef,
  parseCompactFields,
  readMissingOptionValue,
  readOptions,
  readUnexpectedPositionals,
  suggestOptions,
} from "./arg-parser";

import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import {
  COMPACT_TEMP_KEY_PREFIX,
  DomainError,
  type CompactBatchResultContract,
  type CompactDependencySpec,
  type CompactEntityRef,
} from "../domain/types";
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

const ADD_MANY_OPTIONS = ["dep"] as const;

function unknownOption(command: string, option: string, allowedOptions: readonly string[]): CliResult {
  const suggestions = suggestOptions(option, allowedOptions).map((suggestion) => `--${suggestion}`);
  const suggestionMessage = suggestions.length > 0 ? ` Did you mean ${suggestions.join(" or ")}?` : "";
  return failResult({
    command,
    human: `Unknown option --${option}.${suggestionMessage}`,
    data: {
      option: `--${option}`,
      allowedOptions: allowedOptions.map((allowedOption) => `--${allowedOption}`),
      suggestions,
    },
    error: {
      code: "unknown_option",
      message: `Unknown option --${option}`,
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

function failBatchSpec(command: string, human: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command,
    human,
    data,
    error: {
      code: "invalid_input",
      message: human,
    },
  });
}

function failUnexpectedPositionals(command: string, unexpected: readonly string[]): CliResult {
  return failBatchSpec(command, `Unexpected positional arguments: ${unexpected.join(", ")}.`, {
    unexpectedPositionals: unexpected,
  });
}

function validateCompactEntityRef(index: number, rawSpec: string, label: string, reference: CompactEntityRef): CliResult | undefined {
  if (reference.kind === "temp_key" && !isValidCompactTempKey(reference.tempKey)) {
    return failBatchSpec("dep.add-many", `${label} in --dep spec ${index + 1} must use ${COMPACT_TEMP_KEY_PREFIX}<temp-key> with letters, numbers, dot, dash, or underscore.`, {
      option: "dep",
      index,
      rawSpec,
      reference,
    });
  }

  if (reference.kind === "id" && reference.id.trim().length === 0) {
    return failBatchSpec("dep.add-many", `${label} in --dep spec ${index + 1} is required.`, {
      option: "dep",
      index,
      rawSpec,
      reference,
    });
  }

  return undefined;
}

function parseDependencySpecs(rawSpecs: readonly string[]): { specs: CompactDependencySpec[]; error?: CliResult } {
  const specs: CompactDependencySpec[] = [];

  for (const [index, rawSpec] of rawSpecs.entries()) {
    const parsed = parseCompactFields(rawSpec);
    if (parsed.invalidEscape !== null) {
      return {
        specs: [],
        error: failBatchSpec("dep.add-many", `Invalid escape sequence ${parsed.invalidEscape} in --dep spec ${index + 1}.`, {
          option: "dep",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.hasDanglingEscape) {
      return {
        specs: [],
        error: failBatchSpec("dep.add-many", `Trailing escape in --dep spec ${index + 1}.`, {
          option: "dep",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.fields.length !== 2) {
      return {
        specs: [],
        error: failBatchSpec("dep.add-many", `Dependency specs must use <source-ref>|<depends-on-ref> in --dep spec ${index + 1}.`, {
          option: "dep",
          index,
          rawSpec,
          fields: parsed.fields,
        }),
      };
    }

    const source = parseCompactEntityRef(parsed.fields[0] ?? "");
    const sourceError = validateCompactEntityRef(index, rawSpec, "Source ref", source);
    if (sourceError !== undefined) {
      return { specs: [], error: sourceError };
    }

    const dependsOn = parseCompactEntityRef(parsed.fields[1] ?? "");
    const dependsOnError = validateCompactEntityRef(index, rawSpec, "Depends-on ref", dependsOn);
    if (dependsOnError !== undefined) {
      return { specs: [], error: dependsOnError };
    }

    specs.push({ source, dependsOn });
  }

  return { specs };
}

export async function runDep(context: CliContext): Promise<CliResult> {
  const database = openTrekoonDatabase(context.cwd);

  try {
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const sourceId: string = parsed.positional[1] ?? "";
    const dependsOnId: string = parsed.positional[2] ?? "";
    const domain = new TrackerDomain(database.db);
    const mutations = new MutationService(database.db, context.cwd);

    switch (subcommand) {
      case "add": {
        const dependency = mutations.addDependency(sourceId, dependsOnId);

        return okResult({
          command: "dep.add",
          human: `Added dependency ${dependency.sourceId} -> ${dependency.dependsOnId}`,
          data: { dependency },
        });
      }
      case "add-many": {
        const addManyUnknownOption = findUnknownOption(parsed, ADD_MANY_OPTIONS);
        if (addManyUnknownOption !== undefined) {
          return unknownOption("dep.add-many", addManyUnknownOption, ADD_MANY_OPTIONS);
        }

        const missingAddManyOption = readMissingOptionValue(parsed.missingOptionValues, "dep");
        if (missingAddManyOption !== undefined) {
          return failMissingOptionValue("dep.add-many", missingAddManyOption);
        }

        const unexpectedPositionals = readUnexpectedPositionals(parsed, 1);
        if (unexpectedPositionals.length > 0) {
          return failUnexpectedPositionals("dep.add-many", unexpectedPositionals);
        }

        const rawSpecs = readOptions(parsed.optionEntries, "dep");
        if (rawSpecs.length === 0) {
          return failBatchSpec("dep.add-many", "Provide at least one --dep spec.", {
            option: "dep",
          });
        }

        const specResult = parseDependencySpecs(rawSpecs);
        if (specResult.error !== undefined) {
          return specResult.error;
        }

        const created = mutations.addDependencyBatch({
          specs: specResult.specs,
        });
        const result: CompactBatchResultContract = created.result;
        return okResult({
          command: "dep.add-many",
          human: `Added ${created.dependencies.length} dependenc${created.dependencies.length === 1 ? "y" : "ies"}: ${created.dependencies
            .map((dependency) => `${dependency.sourceId} -> ${dependency.dependsOnId}`)
            .join("\n")}`,
          data: {
            dependencies: created.dependencies,
            result,
          },
        });
      }
      case "remove": {
        const removed: number = mutations.removeDependency(sourceId, dependsOnId);

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
      case "reverse": {
        const targetKind = domain.resolveNodeKind(sourceId);
        const blockedNodes = domain.listReverseDependencies(sourceId);

        return okResult({
          command: "dep.reverse",
          human:
            blockedNodes.length === 0
              ? `No downstream blockers for ${sourceId}`
              : blockedNodes
                  .map((item) => `${item.id} (${item.kind}, distance=${item.distance})`)
                  .join("\n"),
          data: {
            targetId: sourceId,
            targetKind,
            blockedNodes,
          },
        });
      }
      default:
        return failResult({
          command: "dep",
          human: "Usage: trekoon dep <add|add-many|remove|list|reverse>",
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
