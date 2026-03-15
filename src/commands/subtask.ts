import {
  SEARCH_REPLACE_FIELDS,
  findUnknownOption,
  hasFlag,
  isValidCompactTempKey,
  parseArgs,
  parseCompactFields,
  parseCsvEnumOption,
  parseStrictNonNegativeInt,
  parseStrictPositiveInt,
  readEnumOption,
  readMissingOptionValue,
  readOption,
  readOptions,
  readUnexpectedPositionals,
  resolvePreviewApplyMode,
  suggestOptions,
} from "./arg-parser";
import { unexpectedFailureResult } from "./error-utils";

import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { type CompactBatchResultContract, type CompactSubtaskSpec, type SearchEntityMatch, type SubtaskRecord } from "../domain/types";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";

function formatSubtask(subtask: SubtaskRecord): string {
  return `${subtask.id} | task=${subtask.taskId} | ${subtask.title} | ${subtask.status}`;
}

const VIEW_MODES = ["table", "compact"] as const;
const DEFAULT_SUBTASK_LIST_LIMIT = 10;
const DEFAULT_OPEN_SUBTASK_STATUSES = ["in_progress", "in-progress", "todo"] as const;
const CREATE_OPTIONS = ["task", "t", "title", "description", "d", "status", "s"] as const;
const LIST_OPTIONS = ["task", "t", "status", "s", "limit", "l", "cursor", "all", "view"] as const;
const SEARCH_OPTIONS = ["fields", "preview"] as const;
const REPLACE_OPTIONS = ["search", "replace", "fields", "preview", "apply"] as const;
const CREATE_MANY_OPTIONS = ["task", "t", "subtask"] as const;
const UPDATE_OPTIONS = ["all", "ids", "append", "description", "d", "status", "s", "title"] as const;
const STATUS_CASCADE_UPDATE_STATUSES = ["done", "todo"] as const;

function parseIdsOption(rawIds: string | undefined): string[] {
  if (rawIds === undefined) {
    return [];
  }

  return rawIds
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function prefixedOptions(options: readonly string[]): string[] {
  return options.map((option) => `--${option}`);
}

function unknownOption(command: string, option: string, allowedOptions: readonly string[]): CliResult {
  const suggestions = suggestOptions(option, allowedOptions).map((suggestion) => `--${suggestion}`);
  const suggestionMessage = suggestions.length > 0 ? ` Did you mean ${suggestions.join(" or ")}?` : "";
  return failResult({
    command,
    human: `Unknown option --${option}.${suggestionMessage}`,
    data: {
      option: `--${option}`,
      allowedOptions: prefixedOptions(allowedOptions),
      suggestions,
    },
    error: {
      code: "unknown_option",
      message: `Unknown option --${option}`,
    },
  });
}

function invalidSearchInput(command: string, human: string, message: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command,
    human,
    data,
    error: {
      code: "invalid_input",
      message,
    },
  });
}

function formatSearchHuman(matches: readonly SearchEntityMatch[], emptyMessage: string): string {
  if (matches.length === 0) {
    return emptyMessage;
  }

  return matches
    .map(
      (match) =>
        `${match.kind} ${match.id}: ${match.fields
          .map((field) => `${field.field}(${field.count}) "${field.snippet}"`)
          .join(", ")}`,
    )
    .join("\n");
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
  cursor: number,
): { subtasks: SubtaskRecord[]; pagination: { hasMore: boolean; nextCursor: string | null } } {
  const allowedStatuses = statuses === undefined ? undefined : new Set(statuses);
  const filtered = allowedStatuses === undefined ? [...subtasks] : subtasks.filter((subtask) => allowedStatuses.has(subtask.status));
  const sorted = [...filtered].sort((left, right) => {
    const byStatus = subtaskStatusPriority(left.status) - subtaskStatusPriority(right.status);
    if (byStatus !== 0) {
      return byStatus;
    }

    const byCreatedAt = left.createdAt - right.createdAt;
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });

  if (limit === undefined) {
    return {
      subtasks: sorted,
      pagination: {
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  const pagedSubtasks = sorted.slice(cursor, cursor + limit);
  const nextIndex = cursor + pagedSubtasks.length;
  const hasMore = nextIndex < sorted.length;
  return {
    subtasks: pagedSubtasks,
    pagination: {
      hasMore,
      nextCursor: hasMore ? `${nextIndex}` : null,
    },
  };
}

function appendLine(existing: string, line: string): string {
  return existing.length > 0 ? `${existing}\n${line}` : line;
}

function isStatusCascadeUpdateStatus(status: string | undefined): status is (typeof STATUS_CASCADE_UPDATE_STATUSES)[number] {
  return status === "done" || status === "todo";
}

function failCascadeStatusUpdate(command: string, entityLabel: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command,
    human: `${entityLabel} cascade mode requires --status done or --status todo and does not support --append, --description, or --title.`,
    data: {
      code: "invalid_input",
      ...data,
    },
    error: {
      code: "invalid_input",
      message: `${entityLabel} cascade mode requires status-only done/todo input`,
    },
  });
}

function formatSubtaskListTable(subtasks: readonly SubtaskRecord[]): string {
  return formatHumanTable(
    ["ID", "TASK", "TITLE", "STATUS"],
    subtasks.map((subtask) => [subtask.id, subtask.taskId, subtask.title, subtask.status]),
    { wrapColumns: [2] },
  );
}

function failFromError(error: unknown): CliResult {
  return unexpectedFailureResult(error, {
    command: "subtask",
    human: "Unexpected subtask command failure",
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

function failConflictingTaskIds(optionTaskId: string, positionalTaskId: string): CliResult {
  return failBatchSpec("subtask.create-many", "Conflicting task ids for subtask create-many: positional task id must match --task.", {
    option: "task",
    optionTaskId,
    positionalTaskId,
  });
}

function failEmptyCompactField(command: string, option: string, index: number, rawSpec: string, field: string): CliResult {
  return failBatchSpec(command, `${option === "subtask" ? "Subtask" : "Spec"} spec ${index + 1} is missing a ${field}.`, {
    option,
    index,
    rawSpec,
    field,
  });
}

function parseSubtaskCreateManySpecs(parentTaskId: string, rawSpecs: readonly string[]): { specs: CompactSubtaskSpec[]; error?: CliResult } {
  const specs: CompactSubtaskSpec[] = [];
  const seenTempKeys = new Set<string>();

  for (const [index, rawSpec] of rawSpecs.entries()) {
    const parsed = parseCompactFields(rawSpec);
    if (parsed.invalidEscape !== null) {
      return {
        specs: [],
        error: failBatchSpec("subtask.create-many", `Invalid escape sequence ${parsed.invalidEscape} in --subtask spec ${index + 1}.`, {
          option: "subtask",
          index,
          rawSpec,
          invalidEscape: parsed.invalidEscape,
        }),
      };
    }

    if (parsed.hasDanglingEscape) {
      return {
        specs: [],
        error: failBatchSpec("subtask.create-many", `Trailing escape in --subtask spec ${index + 1}.`, {
          option: "subtask",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.fields.length !== 4) {
      return {
        specs: [],
        error: failBatchSpec("subtask.create-many", `Subtask specs must use <temp-key>|<title>|<description>|<status> in --subtask spec ${index + 1}.`, {
          option: "subtask",
          index,
          rawSpec,
          fields: parsed.fields,
        }),
      };
    }

    const tempKey = parsed.fields[0] ?? "";
    const title = parsed.fields[1] ?? "";
    const description = parsed.fields[2] ?? "";
    const status = parsed.fields[3] ?? "";
    if (!tempKey || !isValidCompactTempKey(tempKey)) {
      return {
        specs: [],
        error: failBatchSpec("subtask.create-many", `Subtask spec ${index + 1} must start with a temp key like seed-1.`, {
          option: "subtask",
          index,
          rawSpec,
          tempKey,
        }),
      };
    }

    if (seenTempKeys.has(tempKey)) {
      return {
        specs: [],
        error: failBatchSpec("subtask.create-many", `Duplicate temp key '${tempKey}' in --subtask specs.`, {
          option: "subtask",
          index,
          rawSpec,
          tempKey,
        }),
      };
    }

    if (!title || title.trim().length === 0) {
      return {
        specs: [],
        error: failBatchSpec("subtask.create-many", `Subtask spec ${index + 1} is missing a title.`, {
          option: "subtask",
          index,
          rawSpec,
        }),
      };
    }

    if (description.trim().length === 0) {
      return {
        specs: [],
        error: failEmptyCompactField("subtask.create-many", "subtask", index, rawSpec, "description"),
      };
    }

    seenTempKeys.add(tempKey);
    const spec: CompactSubtaskSpec = status.length > 0
      ? {
          parent: {
            kind: "id",
            id: parentTaskId,
          },
          tempKey,
          title,
          description,
          status,
        }
      : {
          parent: {
            kind: "id",
            id: parentTaskId,
          },
          tempKey,
          title,
          description,
        };
    specs.push(spec);
  }

  return { specs };
}

export async function runSubtask(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    database = openTrekoonDatabase(context.cwd);
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);
    const mutations = new MutationService(database.db, context.cwd);

    switch (subcommand) {
      case "create": {
        const createUnknownOption = findUnknownOption(parsed, CREATE_OPTIONS);
        if (createUnknownOption !== undefined) {
          return unknownOption("subtask.create", createUnknownOption, CREATE_OPTIONS);
        }

        const unexpectedCreatePositionals = readUnexpectedPositionals(parsed, 3);
        if (unexpectedCreatePositionals.length > 0) {
          return failUnexpectedPositionals("subtask.create", unexpectedCreatePositionals);
        }

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
      case "create-many": {
        const createManyUnknownOption = findUnknownOption(parsed, CREATE_MANY_OPTIONS);
        if (createManyUnknownOption !== undefined) {
          return unknownOption("subtask.create-many", createManyUnknownOption, CREATE_MANY_OPTIONS);
        }

        const missingCreateManyOption = readMissingOptionValue(parsed.missingOptionValues, "task", "t", "subtask");
        if (missingCreateManyOption !== undefined) {
          return failMissingOptionValue("subtask.create-many", missingCreateManyOption);
        }

        const optionTaskId = readOption(parsed.options, "task", "t");
        const positionalTaskId = parsed.positional[1];
        const unexpectedPositionals = readUnexpectedPositionals(parsed, positionalTaskId === undefined ? 1 : 2);
        if (unexpectedPositionals.length > 0) {
          return failUnexpectedPositionals("subtask.create-many", unexpectedPositionals);
        }

        if (
          optionTaskId !== undefined
          && positionalTaskId !== undefined
          && optionTaskId.trim().length > 0
          && positionalTaskId.trim().length > 0
          && optionTaskId !== positionalTaskId
        ) {
          return failConflictingTaskIds(optionTaskId, positionalTaskId);
        }

        const taskId = optionTaskId ?? positionalTaskId;
        if (taskId === undefined || taskId.trim().length === 0) {
          return failBatchSpec("subtask.create-many", "Provide --task (or positional task id) for subtask create-many.", {
            option: "task",
          });
        }

        const rawSpecs = readOptions(parsed.optionEntries, "subtask");
        if (rawSpecs.length === 0) {
          return failBatchSpec("subtask.create-many", "Provide at least one --subtask spec.", {
            option: "subtask",
          });
        }

        const specResult = parseSubtaskCreateManySpecs(taskId, rawSpecs);
        if (specResult.error !== undefined) {
          return specResult.error;
        }

        const created = mutations.createSubtaskBatch({
          taskId,
          specs: specResult.specs,
        });
        const result: CompactBatchResultContract = created.result;
        return okResult({
          command: "subtask.create-many",
          human: `Created ${created.subtasks.length} subtask(s): ${created.subtasks.map(formatSubtask).join("\n")}`,
          data: {
            taskId,
            subtasks: created.subtasks,
            result,
          },
        });
      }
      case "list": {
        const listUnknownOption = findUnknownOption(parsed, LIST_OPTIONS);
        if (listUnknownOption !== undefined) {
          return unknownOption("subtask.list", listUnknownOption, LIST_OPTIONS);
        }

        const unexpectedListPositionals = readUnexpectedPositionals(parsed, 2);
        if (unexpectedListPositionals.length > 0) {
          return failUnexpectedPositionals("subtask.list", unexpectedListPositionals);
        }

        const missingListOption =
          readMissingOptionValue(parsed.missingOptionValues, "view") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "cursor") ??
          readMissingOptionValue(parsed.missingOptionValues, "task", "t");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("subtask.list", missingListOption);
        }

        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        const includeAll = hasFlag(parsed.flags, "all");
        const rawStatuses = readOption(parsed.options, "status", "s");
        const rawLimit = readOption(parsed.options, "limit", "l");
        const rawCursor = readOption(parsed.options, "cursor");

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

        if (includeAll && rawCursor !== undefined) {
          return failResult({
            command: "subtask.list",
            human: "Use either --all or --cursor, not both.",
            data: { code: "invalid_input", flags: ["all", "cursor"] },
            error: {
              code: "invalid_input",
              message: "--all and --cursor are mutually exclusive",
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

        const parsedCursor = parseStrictNonNegativeInt(rawCursor);
        if (Number.isNaN(parsedCursor)) {
          return failResult({
            command: "subtask.list",
            human: "Invalid --cursor value. Use an integer >= 0.",
            data: { code: "invalid_input", cursor: rawCursor },
            error: {
              code: "invalid_input",
              message: "Invalid --cursor value",
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
        const listed = filterSortAndLimitSubtasks(
          domain.listSubtasks(taskId),
          selectedStatuses,
          selectedLimit,
          parsedCursor ?? 0,
        );
        const subtasks = listed.subtasks;
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
          ...(context.mode === "human"
            ? {}
            : {
                meta: {
                  pagination: listed.pagination,
                  defaults: {
                    statuses: !includeAll && statuses === undefined ? [...DEFAULT_OPEN_SUBTASK_STATUSES] : null,
                    limit: !includeAll && parsedLimit === undefined ? DEFAULT_SUBTASK_LIST_LIMIT : null,
                    cursor: parsedCursor === undefined ? 0 : null,
                    view: view === undefined ? "table" : null,
                  },
                  filters: {
                    taskId: taskId ?? null,
                    statuses: selectedStatuses ?? null,
                    includeAll,
                  },
                  truncation: {
                    applied: listed.pagination.hasMore,
                    returned: subtasks.length,
                    limit: selectedLimit ?? null,
                  },
                },
              }),
        });
      }
      case "search": {
        const searchUnknownOption = findUnknownOption(parsed, SEARCH_OPTIONS);
        if (searchUnknownOption !== undefined) {
          return unknownOption("subtask.search", searchUnknownOption, SEARCH_OPTIONS);
        }

        const missingSearchOption = readMissingOptionValue(parsed.missingOptionValues, "fields");
        if (missingSearchOption !== undefined) {
          return failMissingOptionValue("subtask.search", missingSearchOption);
        }

        const subtaskId: string = parsed.positional[1] ?? "";
        const searchText: string = parsed.positional[2] ?? "";
        if (subtaskId.length === 0 || searchText.trim().length === 0) {
          return invalidSearchInput(
            "subtask.search",
            "Usage: trekoon subtask search <subtask-id> \"search text\" [--fields <csv>] [--preview]",
            "Missing search target",
            {
              subtaskId,
            },
          );
        }

        const parsedFields = parseCsvEnumOption(readOption(parsed.options, "fields"), SEARCH_REPLACE_FIELDS);
        if (parsedFields.empty || parsedFields.invalidValues.length > 0) {
          return invalidSearchInput("subtask.search", "Invalid --fields value. Use title, description, or title,description.", "Invalid --fields value", {
            fields: readOption(parsed.options, "fields"),
            invalidFields: parsedFields.invalidValues,
            allowedFields: [...SEARCH_REPLACE_FIELDS],
          });
        }

        const { matches, summary } = domain.searchSubtaskScope(subtaskId, searchText, parsedFields.values);

        return okResult({
          command: "subtask.search",
          human: formatSearchHuman(matches, "No matches found."),
          data: {
            scope: {
              kind: "subtask",
              id: subtaskId,
            },
            query: {
              search: searchText,
              fields: parsedFields.values,
              mode: "preview",
            },
            summary,
            matches,
          },
        });
      }
      case "replace": {
        const replaceUnknownOption = findUnknownOption(parsed, REPLACE_OPTIONS);
        if (replaceUnknownOption !== undefined) {
          return unknownOption("subtask.replace", replaceUnknownOption, REPLACE_OPTIONS);
        }

        const missingReplaceOption =
          readMissingOptionValue(parsed.missingOptionValues, "search") ??
          readMissingOptionValue(parsed.missingOptionValues, "replace") ??
          readMissingOptionValue(parsed.missingOptionValues, "fields");
        if (missingReplaceOption !== undefined) {
          return failMissingOptionValue("subtask.replace", missingReplaceOption);
        }

        const subtaskId: string = parsed.positional[1] ?? "";
        const searchText = readOption(parsed.options, "search") ?? "";
        const replacementText = readOption(parsed.options, "replace") ?? "";
        if (subtaskId.length === 0 || searchText.trim().length === 0) {
          return invalidSearchInput(
            "subtask.replace",
            "Usage: trekoon subtask replace <subtask-id> --search \"text\" --replace \"text\" [--fields <csv>] [--preview|--apply]",
            "Missing replace target",
            {
              subtaskId,
              search: searchText,
            },
          );
        }

        const rawFields = readOption(parsed.options, "fields");
        const parsedFields = parseCsvEnumOption(rawFields, SEARCH_REPLACE_FIELDS);
        if (parsedFields.empty || parsedFields.invalidValues.length > 0) {
          return invalidSearchInput("subtask.replace", "Invalid --fields value. Use title, description, or title,description.", "Invalid --fields value", {
            fields: rawFields,
            invalidFields: parsedFields.invalidValues,
            allowedFields: [...SEARCH_REPLACE_FIELDS],
          });
        }

        const previewMode = resolvePreviewApplyMode(parsed.flags);
        if (previewMode.conflict) {
          return invalidSearchInput("subtask.replace", "Use either --preview or --apply, not both.", "Conflicting mode flags", {
            flags: ["preview", "apply"],
          });
        }

        const replacementSummary = previewMode.mode === "apply"
          ? mutations.applySubtaskReplacement(subtaskId, searchText, replacementText, parsedFields.values)
          : mutations.previewSubtaskReplacement(subtaskId, searchText, replacementText, parsedFields.values);
        const { matches, summary: matchSummary } = replacementSummary;

        const summary = {
          ...matchSummary,
          mode: previewMode.mode,
        };

        return okResult({
          command: "subtask.replace",
          human: formatSearchHuman(matches, `No ${previewMode.mode === "apply" ? "replacements" : "matches"} found.`),
          data: {
            scope: {
              kind: "subtask",
              id: subtaskId,
            },
            query: {
              search: searchText,
              replace: replacementText,
              fields: parsedFields.values,
              mode: previewMode.mode,
            },
            summary,
            matches,
          },
        });
      }
      case "update": {
        const updateUnknownOption = findUnknownOption(parsed, UPDATE_OPTIONS);
        if (updateUnknownOption !== undefined) {
          return unknownOption("subtask.update", updateUnknownOption, UPDATE_OPTIONS);
        }

        const unexpectedUpdatePositionals = readUnexpectedPositionals(parsed, 2);
        if (unexpectedUpdatePositionals.length > 0) {
          return failUnexpectedPositionals("subtask.update", unexpectedUpdatePositionals);
        }

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

        const cascadeMode = updateAll && subtaskId.length > 0;
        if (cascadeMode) {
          if (title !== undefined || description !== undefined || append !== undefined || !isStatusCascadeUpdateStatus(status)) {
            return failCascadeStatusUpdate("subtask.update", "Subtask", {
              id: subtaskId,
              status,
              allowedStatuses: [...STATUS_CASCADE_UPDATE_STATUSES],
              fields: {
                title: title !== undefined,
                description: description !== undefined,
                append: append !== undefined,
              },
            });
          }

          const subtask = mutations.updateSubtask(subtaskId, { status });

          return okResult({
            command: "subtask.update",
            human: `Updated subtask ${formatSubtask(subtask)}`,
            data: { subtask },
          });
        }

        const hasBulkTarget = (updateAll && subtaskId.length === 0) || ids.length > 0;
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
            mutations.updateSubtask(target.id, {
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
        const subtask = mutations.updateSubtask(subtaskId, { title, description: nextDescription, status });

        return okResult({
          command: "subtask.update",
          human: `Updated subtask ${formatSubtask(subtask)}`,
          data: { subtask },
        });
      }
      case "delete": {
        const subtaskId: string = parsed.positional[1] ?? "";
        mutations.deleteSubtask(subtaskId);

        return okResult({
          command: "subtask.delete",
          human: `Deleted subtask ${subtaskId}`,
          data: { id: subtaskId },
        });
      }
      default:
        return failResult({
          command: "subtask",
          human: "Usage: trekoon subtask <create|create-many|list|search|replace|update|delete>",
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
    database?.close();
  }
}
