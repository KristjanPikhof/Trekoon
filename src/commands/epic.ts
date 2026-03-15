import {
  SEARCH_REPLACE_FIELDS,
  findUnknownOption,
  hasFlag,
  isValidCompactTempKey,
  parseArgs,
  parseCompactEntityRef,
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
import {
  COMPACT_TEMP_KEY_PREFIX,
  type CompactBatchResultContract,
  type CompactDependencySpec,
  type CompactEntityRef,
  type CompactSubtaskSpec,
  type CompactTaskSpec,
  type EpicRecord,
  type SearchEntityMatch,
  type StatusCascadePlan,
} from "../domain/types";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";

function formatEpic(epic: EpicRecord): string {
  return `${epic.id} | ${epic.title} | ${epic.status}`;
}

const VIEW_MODES = ["table", "compact", "tree", "detail"] as const;
const LIST_VIEW_MODES = ["table", "compact"] as const;
const DEFAULT_LIST_LIMIT = 10;
const DEFAULT_OPEN_STATUSES = ["in_progress", "in-progress", "todo"] as const;
const CREATE_OPTIONS = ["title", "t", "description", "d", "status", "s", "task", "subtask", "dep"] as const;
const LIST_OPTIONS = ["status", "s", "limit", "l", "cursor", "all", "view"] as const;
const SHOW_OPTIONS = ["view", "all"] as const;
const SEARCH_OPTIONS = ["fields", "preview"] as const;
const REPLACE_OPTIONS = ["search", "replace", "fields", "preview", "apply"] as const;
const EXPAND_OPTIONS = ["task", "subtask", "dep"] as const;
const UPDATE_OPTIONS = ["all", "ids", "append", "description", "d", "status", "s", "title", "t"] as const;
const STATUS_CASCADE_UPDATE_STATUSES = ["done", "todo"] as const;

function parseStatusCsv(rawStatuses: string | undefined): string[] | undefined {
  if (rawStatuses === undefined) {
    return undefined;
  }

  return rawStatuses
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

function getStatusPriority(status: string): number {
  if (status === "in_progress" || status === "in-progress") {
    return 0;
  }

  if (status === "todo") {
    return 1;
  }

  return 2;
}

function sortByStatusPriority(epics: readonly EpicRecord[]): EpicRecord[] {
  return [...epics].sort((left, right) => {
    const byStatus = getStatusPriority(left.status) - getStatusPriority(right.status);
    if (byStatus !== 0) {
      return byStatus;
    }

    const byCreatedAt = left.createdAt - right.createdAt;
    if (byCreatedAt !== 0) {
      return byCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

interface PaginationMeta {
  readonly hasMore: boolean;
  readonly nextCursor: string | null;
}

function filterSortAndLimitEpics(epics: readonly EpicRecord[], options: {
  includeAll: boolean;
  statuses: readonly string[] | undefined;
  limit: number | undefined;
  cursor: number;
}): { epics: EpicRecord[]; pagination: PaginationMeta } {
  const { includeAll, statuses, limit, cursor } = options;
  const selectedStatuses = includeAll ? undefined : (statuses ?? DEFAULT_OPEN_STATUSES);
  const selectedEpics = selectedStatuses === undefined ? [...epics] : epics.filter((epic) => selectedStatuses.includes(epic.status));
  const sortedEpics = sortByStatusPriority(selectedEpics);

  if (includeAll) {
    return {
      epics: sortedEpics,
      pagination: {
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  const effectiveLimit = limit ?? DEFAULT_LIST_LIMIT;
  const pagedEpics = sortedEpics.slice(cursor, cursor + effectiveLimit);
  const nextIndex = cursor + pagedEpics.length;
  const hasMore = nextIndex < sortedEpics.length;
  return {
    epics: pagedEpics,
    pagination: {
      hasMore,
      nextCursor: hasMore ? `${nextIndex}` : null,
    },
  };
}

function invalidEpicListInput(human: string, message: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command: "epic.list",
    human,
    data,
    error: {
      code: "invalid_input",
      message,
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

function isStatusCascadeUpdateStatus(status: string | undefined): status is (typeof STATUS_CASCADE_UPDATE_STATUSES)[number] {
  return status === "done" || status === "todo";
}

function buildStatusCascadeData(plan: StatusCascadePlan): Record<string, unknown> {
  return {
    mode: "descendants",
    root: {
      kind: plan.rootKind,
      id: plan.rootId,
    },
    targetStatus: plan.targetStatus,
    atomic: plan.atomic,
    changedIds: plan.changedIds,
    unchangedIds: plan.unchangedIds,
    counts: plan.counts,
  };
}

function formatStatusCascadeHuman(entityLabel: string, plan: StatusCascadePlan): string {
  return `Cascade updated ${entityLabel} ${plan.rootId} to ${plan.targetStatus} (${plan.counts.changed} changed, ${plan.counts.unchanged} unchanged; epics=${plan.counts.changedEpics}, tasks=${plan.counts.changedTasks}, subtasks=${plan.counts.changedSubtasks})`;
}

function failCascadeStatusUpdate(command: string, entityLabel: string, data: Record<string, unknown>): CliResult {
  return failResult({
    command,
    human: `${entityLabel} descendant cascade requires --status done or --status todo and does not support --append, --description, or --title.`,
    data: {
      code: "invalid_input",
      ...data,
    },
    error: {
      code: "invalid_input",
      message: `${entityLabel} descendant cascade requires status-only done/todo mode`,
    },
  });
}

function formatEpicListTable(epics: readonly EpicRecord[]): string {
  const rows = epics.map((epic) => [epic.id, epic.title, epic.status]);
  return formatHumanTable(["ID", "TITLE", "STATUS"], rows, { wrapColumns: [1] });
}

function formatEpicShowCompact(tree: {
  id: string;
  title: string;
  status: string;
  tasks: ReadonlyArray<{
    id: string;
    title: string;
    status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; status: string }>;
  }>;
}): string {
  const humanLines: string[] = [`${tree.id} | ${tree.title} | ${tree.status}`];

  for (const task of tree.tasks) {
    humanLines.push(`  task ${task.id} | ${task.title} | ${task.status}`);
    for (const subtask of task.subtasks) {
      humanLines.push(`    subtask ${subtask.id} | ${subtask.title} | ${subtask.status}`);
    }
  }

  return humanLines.join("\n");
}

function formatEpicShowDetailed(tree: {
  id: string;
  title: string;
  description: string;
  status: string;
  tasks: ReadonlyArray<{
    id: string;
    title: string;
    description: string;
    status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; description: string; status: string }>;
  }>;
}): string {
  const humanLines: string[] = [`${tree.id} | ${tree.title} | ${tree.status} | desc=${tree.description}`];

  for (const task of tree.tasks) {
    humanLines.push(`  task ${task.id} | ${task.title} | ${task.status} | desc=${task.description}`);
    for (const subtask of task.subtasks) {
      humanLines.push(`    subtask ${subtask.id} | ${subtask.title} | ${subtask.status} | desc=${subtask.description}`);
    }
  }

  return humanLines.join("\n");
}

function formatEpicShowTable(tree: {
  id: string;
  title: string;
  description: string;
  status: string;
  tasks: ReadonlyArray<{
    id: string;
    title: string;
    description: string;
    status: string;
    subtasks: ReadonlyArray<{ id: string; title: string; description: string; status: string }>;
  }>;
}): string {
  const sections: string[] = [];
  sections.push("EPIC");
  sections.push(
    formatHumanTable(["ID", "TITLE", "STATUS", "DESCRIPTION"], [[tree.id, tree.title, tree.status, tree.description]], {
      wrapColumns: [1, 3],
    }),
  );

  if (tree.tasks.length === 0) {
    sections.push("\nTASKS\nNo tasks found.");
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nTASKS");
  sections.push(
    formatHumanTable(
      ["ID", "TITLE", "STATUS", "DESCRIPTION"],
      tree.tasks.map((task) => [task.id, task.title, task.status, task.description]),
      { wrapColumns: [1, 3] },
    ),
  );

  const subtaskRows = tree.tasks.flatMap((task) =>
    task.subtasks.map((subtask) => [subtask.id, task.id, subtask.title, subtask.status, subtask.description]),
  );
  if (subtaskRows.length === 0) {
    sections.push("\nSUBTASKS\nNo subtasks found.");
    return sections.join("\n");
  }

  sections.push("\nSUBTASKS");
  sections.push(formatHumanTable(["ID", "TASK", "TITLE", "STATUS", "DESCRIPTION"], subtaskRows, { wrapColumns: [2, 4] }));
  return sections.join("\n");
}

function failFromError(error: unknown, command: string): CliResult {
  return unexpectedFailureResult(error, {
    command,
    human: "Unexpected epic command failure",
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

function failEmptyCompactField(command: string, option: string, index: number, rawSpec: string, field: string): CliResult {
  const label = option === "task" ? "Task" : "Subtask";
  return failBatchSpec(command, `${label} spec ${index + 1} is missing a ${field}.`, {
    option,
    index,
    rawSpec,
    field,
  });
}

function validateCompactEntityRef(
  command: string,
  option: string,
  index: number,
  rawSpec: string,
  label: string,
  reference: CompactEntityRef,
): CliResult | undefined {
  if (reference.kind === "temp_key" && !isValidCompactTempKey(reference.tempKey)) {
    return failBatchSpec(command, `${label} in --${option} spec ${index + 1} must use ${COMPACT_TEMP_KEY_PREFIX}<temp-key> with letters, numbers, dot, dash, or underscore.`, {
      option,
      index,
      rawSpec,
      reference,
    });
  }

  if (reference.kind === "id" && reference.id.trim().length === 0) {
    return failBatchSpec(command, `${label} in --${option} spec ${index + 1} is required.`, {
      option,
      index,
      rawSpec,
      reference,
    });
  }

  return undefined;
}

function parseExpandTaskSpecs(rawSpecs: readonly string[]): { specs: CompactTaskSpec[]; error?: CliResult } {
  const specs: CompactTaskSpec[] = [];
  const seenTempKeys = new Set<string>();

  for (const [index, rawSpec] of rawSpecs.entries()) {
    const parsed = parseCompactFields(rawSpec);
    if (parsed.invalidEscape !== null) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Invalid escape sequence ${parsed.invalidEscape} in --task spec ${index + 1}.`, {
          option: "task",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.hasDanglingEscape) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Trailing escape in --task spec ${index + 1}.`, {
          option: "task",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.fields.length !== 4) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Task specs must use <temp-key>|<title>|<description>|<status> in --task spec ${index + 1}.`, {
          option: "task",
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
        error: failBatchSpec("epic.expand", `Task spec ${index + 1} must start with a temp key like seed-1.`, {
          option: "task",
          index,
          rawSpec,
          tempKey,
        }),
      };
    }

    if (seenTempKeys.has(tempKey)) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Duplicate temp key '${tempKey}' across --task specs.`, {
          option: "task",
          index,
          rawSpec,
          tempKey,
        }),
      };
    }

    if (!title || title.trim().length === 0) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Task spec ${index + 1} is missing a title.`, {
          option: "task",
          index,
          rawSpec,
        }),
      };
    }

    if (description.trim().length === 0) {
      return {
        specs: [],
        error: failEmptyCompactField("epic.expand", "task", index, rawSpec, "description"),
      };
    }

    seenTempKeys.add(tempKey);
    const spec: CompactTaskSpec = status.length > 0
      ? { tempKey, title, description, status }
      : { tempKey, title, description };
    specs.push(spec);
  }

  return { specs };
}

function parseExpandSubtaskSpecs(rawSpecs: readonly string[]): { specs: CompactSubtaskSpec[]; error?: CliResult } {
  const specs: CompactSubtaskSpec[] = [];
  const seenTempKeys = new Set<string>();

  for (const [index, rawSpec] of rawSpecs.entries()) {
    const parsed = parseCompactFields(rawSpec);
    if (parsed.invalidEscape !== null) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Invalid escape sequence ${parsed.invalidEscape} in --subtask spec ${index + 1}.`, {
          option: "subtask",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.hasDanglingEscape) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Trailing escape in --subtask spec ${index + 1}.`, {
          option: "subtask",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.fields.length !== 5) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Subtask specs must use <parent-ref>|<temp-key>|<title>|<description>|<status> in --subtask spec ${index + 1}.`, {
          option: "subtask",
          index,
          rawSpec,
          fields: parsed.fields,
        }),
      };
    }

    const parent = parseCompactEntityRef(parsed.fields[0] ?? "");
    const parentError = validateCompactEntityRef("epic.expand", "subtask", index, rawSpec, "Parent ref", parent);
    if (parentError !== undefined) {
      return { specs: [], error: parentError };
    }

    const tempKey = parsed.fields[1] ?? "";
    const title = parsed.fields[2] ?? "";
    const description = parsed.fields[3] ?? "";
    const status = parsed.fields[4] ?? "";
    if (!tempKey || !isValidCompactTempKey(tempKey)) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Subtask spec ${index + 1} must include a valid temp key.`, {
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
        error: failBatchSpec("epic.expand", `Duplicate temp key '${tempKey}' across --subtask specs.`, {
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
        error: failBatchSpec("epic.expand", `Subtask spec ${index + 1} is missing a title.`, {
          option: "subtask",
          index,
          rawSpec,
        }),
      };
    }

    if (description.trim().length === 0) {
      return {
        specs: [],
        error: failEmptyCompactField("epic.expand", "subtask", index, rawSpec, "description"),
      };
    }

    seenTempKeys.add(tempKey);
    const spec: CompactSubtaskSpec = status.length > 0
      ? { parent, tempKey, title, description, status }
      : { parent, tempKey, title, description };
    specs.push(spec);
  }

  return { specs };
}

function parseExpandDependencySpecs(rawSpecs: readonly string[]): { specs: CompactDependencySpec[]; error?: CliResult } {
  const specs: CompactDependencySpec[] = [];

  for (const [index, rawSpec] of rawSpecs.entries()) {
    const parsed = parseCompactFields(rawSpec);
    if (parsed.invalidEscape !== null) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Invalid escape sequence ${parsed.invalidEscape} in --dep spec ${index + 1}.`, {
          option: "dep",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.hasDanglingEscape) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Trailing escape in --dep spec ${index + 1}.`, {
          option: "dep",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.fields.length !== 2) {
      return {
        specs: [],
        error: failBatchSpec("epic.expand", `Dependency specs must use <source-ref>|<depends-on-ref> in --dep spec ${index + 1}.`, {
          option: "dep",
          index,
          rawSpec,
          fields: parsed.fields,
        }),
      };
    }

    const source = parseCompactEntityRef(parsed.fields[0] ?? "");
    const sourceError = validateCompactEntityRef("epic.expand", "dep", index, rawSpec, "Source ref", source);
    if (sourceError !== undefined) {
      return { specs: [], error: sourceError };
    }

    const dependsOn = parseCompactEntityRef(parsed.fields[1] ?? "");
    const dependsOnError = validateCompactEntityRef("epic.expand", "dep", index, rawSpec, "Depends-on ref", dependsOn);
    if (dependsOnError !== undefined) {
      return { specs: [], error: dependsOnError };
    }

    specs.push({ source, dependsOn });
  }

  return { specs };
}

function findDuplicateExpandTempKey(tasks: readonly CompactTaskSpec[], subtasks: readonly CompactSubtaskSpec[]): string | null {
  const seen = new Set<string>();
  for (const task of tasks) {
    seen.add(task.tempKey);
  }

  for (const subtask of subtasks) {
    if (seen.has(subtask.tempKey)) {
      return subtask.tempKey;
    }

    seen.add(subtask.tempKey);
  }

  return null;
}

export async function runEpic(context: CliContext): Promise<CliResult> {
  let database: TrekoonDatabase | undefined;

  try {
    database = openTrekoonDatabase(context.cwd);
    const parsed = parseArgs(context.args);
    const subcommand: string | undefined = parsed.positional[0];
    const domain = new TrackerDomain(database.db);
    const mutations = new MutationService(database.db, context.cwd);

    switch (subcommand) {
      case "create": {
      const missingCreateOption =
          readMissingOptionValue(parsed.missingOptionValues, "title", "t") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "task", "subtask", "dep");
        if (missingCreateOption !== undefined) {
          return failMissingOptionValue("epic.create", missingCreateOption);
        }

        const createUnknownOption = findUnknownOption(parsed, CREATE_OPTIONS);
        if (createUnknownOption !== undefined) {
          return unknownOption("epic.create", createUnknownOption, CREATE_OPTIONS);
        }

        const unexpectedPositionals = readUnexpectedPositionals(parsed, 1);
        if (unexpectedPositionals.length > 0) {
          return failUnexpectedPositionals("epic.create", unexpectedPositionals);
        }

        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const status: string | undefined = readOption(parsed.options, "status", "s");

        const taskSpecs = readOptions(parsed.optionEntries, "task");
        const subtaskSpecs = readOptions(parsed.optionEntries, "subtask");
        const dependencySpecs = readOptions(parsed.optionEntries, "dep");

        if (taskSpecs.length === 0 && subtaskSpecs.length === 0 && dependencySpecs.length === 0) {
          const epic = mutations.createEpic({
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

        const parsedTasks = parseExpandTaskSpecs(taskSpecs);
        if (parsedTasks.error !== undefined) {
          return parsedTasks.error;
        }

        const parsedSubtasks = parseExpandSubtaskSpecs(subtaskSpecs);
        if (parsedSubtasks.error !== undefined) {
          return parsedSubtasks.error;
        }

        const parsedDeps = parseExpandDependencySpecs(dependencySpecs);
        if (parsedDeps.error !== undefined) {
          return parsedDeps.error;
        }

        const duplicateTempKey = findDuplicateExpandTempKey(parsedTasks.specs, parsedSubtasks.specs);
        if (duplicateTempKey !== null) {
          return failBatchSpec("epic.create", `Duplicate temp key '${duplicateTempKey}' across --task and --subtask specs.`, {
            tempKey: duplicateTempKey,
          });
        }

        const created = mutations.createEpicGraph({
          title: title ?? "",
          description: description ?? "",
          status,
          taskSpecs: parsedTasks.specs,
          subtaskSpecs: parsedSubtasks.specs,
          dependencySpecs: parsedDeps.specs,
        });

        return okResult({
          command: "epic.create",
          human: `Created epic ${formatEpic(created.epic)} with ${created.tasks.length} task(s), ${created.subtasks.length} subtask(s), and ${created.dependencies.length} dependenc${created.dependencies.length === 1 ? "y" : "ies"}.`,
          data: {
            epic: created.epic,
            tasks: created.tasks,
            subtasks: created.subtasks,
            dependencies: created.dependencies,
            result: created.result,
          },
        });
      }
      case "expand": {
        const expandUnknownOption = findUnknownOption(parsed, EXPAND_OPTIONS);
        if (expandUnknownOption !== undefined) {
          return unknownOption("epic.expand", expandUnknownOption, EXPAND_OPTIONS);
        }

        const missingExpandOption = readMissingOptionValue(parsed.missingOptionValues, "task", "subtask", "dep");
        if (missingExpandOption !== undefined) {
          return failMissingOptionValue("epic.expand", missingExpandOption);
        }

        const unexpectedPositionals = readUnexpectedPositionals(parsed, 2);
        if (unexpectedPositionals.length > 0) {
          return failUnexpectedPositionals("epic.expand", unexpectedPositionals);
        }

        const epicId: string = parsed.positional[1] ?? "";
        if (epicId.trim().length === 0) {
          return failBatchSpec("epic.expand", "Provide an epic id for epic expand.", {
            id: epicId,
          });
        }

        const taskSpecs = readOptions(parsed.optionEntries, "task");
        const subtaskSpecs = readOptions(parsed.optionEntries, "subtask");
        const dependencySpecs = readOptions(parsed.optionEntries, "dep");
        if (taskSpecs.length === 0 && subtaskSpecs.length === 0 && dependencySpecs.length === 0) {
          return failBatchSpec("epic.expand", "Provide at least one --task, --subtask, or --dep spec.", {});
        }

        const parsedTasks = parseExpandTaskSpecs(taskSpecs);
        if (parsedTasks.error !== undefined) {
          return parsedTasks.error;
        }

        const parsedSubtasks = parseExpandSubtaskSpecs(subtaskSpecs);
        if (parsedSubtasks.error !== undefined) {
          return parsedSubtasks.error;
        }

        const parsedDeps = parseExpandDependencySpecs(dependencySpecs);
        if (parsedDeps.error !== undefined) {
          return parsedDeps.error;
        }

        const duplicateTempKey = findDuplicateExpandTempKey(parsedTasks.specs, parsedSubtasks.specs);
        if (duplicateTempKey !== null) {
          return failBatchSpec("epic.expand", `Duplicate temp key '${duplicateTempKey}' across --task and --subtask specs.`, {
            tempKey: duplicateTempKey,
          });
        }

        const created = mutations.expandEpic({
          epicId,
          taskSpecs: parsedTasks.specs,
          subtaskSpecs: parsedSubtasks.specs,
          dependencySpecs: parsedDeps.specs,
        });
        const result: CompactBatchResultContract & {
          counts: { tasks: number; subtasks: number; dependencies: number };
        } = created.result;
        return okResult({
          command: "epic.expand",
          human: `Expanded epic ${epicId} with ${created.tasks.length} task(s), ${created.subtasks.length} subtask(s), and ${created.dependencies.length} dependenc${created.dependencies.length === 1 ? "y" : "ies"}.`,
          data: {
            epicId,
            tasks: created.tasks,
            subtasks: created.subtasks,
            dependencies: created.dependencies,
            result,
          },
        });
      }
      case "list": {
        const listUnknownOption = findUnknownOption(parsed, LIST_OPTIONS);
        if (listUnknownOption !== undefined) {
          return unknownOption("epic.list", listUnknownOption, LIST_OPTIONS);
        }

        const unexpectedListPositionals = readUnexpectedPositionals(parsed, 1);
        if (unexpectedListPositionals.length > 0) {
          return failUnexpectedPositionals("epic.list", unexpectedListPositionals);
        }

        const missingListOption =
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "cursor") ??
          readMissingOptionValue(parsed.missingOptionValues, "view");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("epic.list", missingListOption);
        }

        const includeAll: boolean = hasFlag(parsed.flags, "all");
        const rawStatuses: string | undefined = readOption(parsed.options, "status");
        const rawLimit: string | undefined = readOption(parsed.options, "limit");
        const rawCursor: string | undefined = readOption(parsed.options, "cursor");
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        if (rawView !== undefined && view === undefined) {
          return invalidEpicListInput("Invalid --view value. Use: table, compact", "Invalid --view value", {
            view: rawView,
            allowedViews: LIST_VIEW_MODES,
          });
        }

        if (view !== undefined && view !== "table" && view !== "compact") {
          return invalidEpicListInput("Invalid --view for epic list. Use: table, compact", "Invalid --view for epic list", {
            view,
            allowedViews: LIST_VIEW_MODES,
          });
        }

        if (includeAll && rawStatuses !== undefined) {
          return invalidEpicListInput("Use either --all or --status, not both.", "--all and --status are mutually exclusive", {
            code: "invalid_input",
            flags: ["all", "status"],
          });
        }

        if (includeAll && rawLimit !== undefined) {
          return invalidEpicListInput("Use either --all or --limit, not both.", "--all and --limit are mutually exclusive", {
            code: "invalid_input",
            flags: ["all", "limit"],
          });
        }

        const statuses = parseStatusCsv(rawStatuses);
        if (rawStatuses !== undefined && statuses !== undefined && statuses.length === 0) {
          return invalidEpicListInput("Invalid --status value. Provide at least one status.", "Invalid --status value", {
            code: "invalid_input",
            status: rawStatuses,
          });
        }

        const limit = parseStrictPositiveInt(rawLimit);
        if (Number.isNaN(limit)) {
          return invalidEpicListInput("Invalid --limit value. Use an integer >= 1.", "Invalid --limit value", {
            code: "invalid_input",
            limit: rawLimit,
          });
        }

        const cursor = parseStrictNonNegativeInt(rawCursor) ?? 0;
        if (Number.isNaN(cursor)) {
          return invalidEpicListInput("Invalid --cursor value. Use an integer >= 0.", "Invalid --cursor value", {
            code: "invalid_input",
            cursor: rawCursor,
          });
        }

        if (includeAll && rawCursor !== undefined) {
          return invalidEpicListInput("Use either --all or --cursor, not both.", "--all and --cursor are mutually exclusive", {
            code: "invalid_input",
            flags: ["all", "cursor"],
          });
        }

        const listed = filterSortAndLimitEpics(domain.listEpics(), {
          includeAll,
          statuses,
          limit,
          cursor,
        });
        const epics = listed.epics;
        const listView = view ?? "table";
        const human = epics.length === 0 ? "No epics found." : listView === "compact" ? epics.map(formatEpic).join("\n") : formatEpicListTable(epics);

        return okResult({
          command: "epic.list",
          human,
          data: { epics },
          ...(context.mode === "human"
            ? {}
            : {
                meta: {
                  pagination: listed.pagination,
                  defaults: {
                    statuses: !includeAll && statuses === undefined ? [...DEFAULT_OPEN_STATUSES] : null,
                    limit: !includeAll && limit === undefined ? DEFAULT_LIST_LIMIT : null,
                    cursor: rawCursor === undefined ? 0 : null,
                    view: view === undefined ? "table" : null,
                  },
                  filters: {
                    statuses: includeAll ? null : (statuses ?? [...DEFAULT_OPEN_STATUSES]),
                    includeAll,
                  },
                  truncation: {
                    applied: listed.pagination.hasMore,
                    returned: epics.length,
                    limit: includeAll ? null : (limit ?? DEFAULT_LIST_LIMIT),
                  },
                },
              }),
        });
      }
      case "show": {
        const showUnknownOption = findUnknownOption(parsed, SHOW_OPTIONS);
        if (showUnknownOption !== undefined) {
          return unknownOption("epic.show", showUnknownOption, SHOW_OPTIONS);
        }

        const unexpectedShowPositionals = readUnexpectedPositionals(parsed, 2);
        if (unexpectedShowPositionals.length > 0) {
          return failUnexpectedPositionals("epic.show", unexpectedShowPositionals);
        }

        const missingShowOption = readMissingOptionValue(parsed.missingOptionValues, "view");
        if (missingShowOption !== undefined) {
          return failMissingOptionValue("epic.show", missingShowOption);
        }

        const epicId: string = parsed.positional[1] ?? "";
        const includeAll: boolean = hasFlag(parsed.flags, "all");
        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        if (rawView !== undefined && view === undefined) {
          return failResult({
            command: "epic.show",
            human: "Invalid --view value. Use: table, compact, tree, detail",
            data: { view: rawView, allowedViews: VIEW_MODES },
            error: {
              code: "invalid_input",
              message: "Invalid --view value",
            },
          });
        }

        const effectiveView = view ?? (context.mode === "human" ? "table" : includeAll ? "detail" : "tree");

        if (effectiveView === "compact") {
          const epic = domain.getEpicOrThrow(epicId);

          return okResult({
            command: "epic.show",
            human: formatEpic(epic),
            data: { epic, includeAll: false },
            ...(context.mode === "human"
              ? {}
              : {
                  meta: {
                    defaults: {
                      view: view === undefined ? effectiveView : null,
                    },
                    filters: {
                      includeAll: false,
                    },
                    truncation: {
                      applied: true,
                      scope: "compact",
                    },
                  },
                }),
          });
        }

        if (effectiveView === "tree") {
          const tree = domain.buildEpicTree(epicId);

          return okResult({
            command: "epic.show",
            human: formatEpicShowCompact(tree),
            data: { tree, includeAll: false },
            ...(context.mode === "human"
              ? {}
              : {
                  meta: {
                    defaults: {
                      view: view === undefined ? effectiveView : null,
                    },
                    filters: {
                      includeAll: false,
                    },
                    truncation: {
                      applied: true,
                      scope: "tree",
                    },
                  },
                }),
          });
        }

        const tree = domain.buildEpicTreeDetailed(epicId);

        return okResult({
          command: "epic.show",
          human: effectiveView === "table" ? formatEpicShowTable(tree) : formatEpicShowDetailed(tree),
          data: { tree, includeAll: true },
          ...(context.mode === "human"
            ? {}
            : {
                meta: {
                  defaults: {
                    view: view === undefined ? effectiveView : null,
                  },
                  filters: {
                    includeAll: true,
                  },
                  truncation: {
                    applied: false,
                    scope: "full",
                  },
                },
              }),
        });
      }
      case "search": {
        const searchUnknownOption = findUnknownOption(parsed, SEARCH_OPTIONS);
        if (searchUnknownOption !== undefined) {
          return unknownOption("epic.search", searchUnknownOption, SEARCH_OPTIONS);
        }

        const missingSearchOption = readMissingOptionValue(parsed.missingOptionValues, "fields");
        if (missingSearchOption !== undefined) {
          return failMissingOptionValue("epic.search", missingSearchOption);
        }

        const epicId: string = parsed.positional[1] ?? "";
        const searchText: string = parsed.positional[2] ?? "";
        if (epicId.length === 0 || searchText.trim().length === 0) {
          return invalidSearchInput(
            "epic.search",
            "Usage: trekoon epic search <epic-id> \"search text\" [--fields <csv>] [--preview]",
            "Missing search target",
            {
              epicId,
            },
          );
        }

        const parsedFields = parseCsvEnumOption(readOption(parsed.options, "fields"), SEARCH_REPLACE_FIELDS);
        if (parsedFields.empty || parsedFields.invalidValues.length > 0) {
          return invalidSearchInput("epic.search", "Invalid --fields value. Use title, description, or title,description.", "Invalid --fields value", {
            fields: readOption(parsed.options, "fields"),
            invalidFields: parsedFields.invalidValues,
            allowedFields: [...SEARCH_REPLACE_FIELDS],
          });
        }

        const { matches, summary } = domain.searchEpicScope(epicId, searchText, parsedFields.values);

        return okResult({
          command: "epic.search",
          human: formatSearchHuman(matches, "No matches found."),
          data: {
            scope: {
              kind: "epic",
              id: epicId,
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
          return unknownOption("epic.replace", replaceUnknownOption, REPLACE_OPTIONS);
        }

        const missingReplaceOption =
          readMissingOptionValue(parsed.missingOptionValues, "search") ??
          readMissingOptionValue(parsed.missingOptionValues, "replace") ??
          readMissingOptionValue(parsed.missingOptionValues, "fields");
        if (missingReplaceOption !== undefined) {
          return failMissingOptionValue("epic.replace", missingReplaceOption);
        }

        const epicId: string = parsed.positional[1] ?? "";
        const searchText = readOption(parsed.options, "search") ?? "";
        const replacementText = readOption(parsed.options, "replace") ?? "";
        if (epicId.length === 0 || searchText.trim().length === 0) {
          return invalidSearchInput(
            "epic.replace",
            "Usage: trekoon epic replace <epic-id> --search \"text\" --replace \"text\" [--fields <csv>] [--preview|--apply]",
            "Missing replace target",
            {
              epicId,
              search: searchText,
            },
          );
        }

        const rawFields = readOption(parsed.options, "fields");
        const parsedFields = parseCsvEnumOption(rawFields, SEARCH_REPLACE_FIELDS);
        if (parsedFields.empty || parsedFields.invalidValues.length > 0) {
          return invalidSearchInput("epic.replace", "Invalid --fields value. Use title, description, or title,description.", "Invalid --fields value", {
            fields: rawFields,
            invalidFields: parsedFields.invalidValues,
            allowedFields: [...SEARCH_REPLACE_FIELDS],
          });
        }

        const previewMode = resolvePreviewApplyMode(parsed.flags);
        if (previewMode.conflict) {
          return invalidSearchInput("epic.replace", "Use either --preview or --apply, not both.", "Conflicting mode flags", {
            flags: ["preview", "apply"],
          });
        }

        const replacementSummary = previewMode.mode === "apply"
          ? mutations.applyEpicReplacement(epicId, searchText, replacementText, parsedFields.values)
          : mutations.previewEpicReplacement(epicId, searchText, replacementText, parsedFields.values);
        const { matches, summary: matchSummary } = replacementSummary;

        const summary = {
          ...matchSummary,
          mode: previewMode.mode,
        };

        return okResult({
          command: "epic.replace",
          human: formatSearchHuman(matches, `No ${previewMode.mode === "apply" ? "replacements" : "matches"} found.`),
          data: {
            scope: {
              kind: "epic",
              id: epicId,
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
          return unknownOption("epic.update", updateUnknownOption, UPDATE_OPTIONS);
        }

        const unexpectedUpdatePositionals = readUnexpectedPositionals(parsed, 2);
        if (unexpectedUpdatePositionals.length > 0) {
          return failUnexpectedPositionals("epic.update", unexpectedUpdatePositionals);
        }

        const missingUpdateOption =
          readMissingOptionValue(parsed.missingOptionValues, "ids") ??
          readMissingOptionValue(parsed.missingOptionValues, "append") ??
          readMissingOptionValue(parsed.missingOptionValues, "description", "d") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s");
        if (missingUpdateOption !== undefined) {
          return failMissingOptionValue("epic.update", missingUpdateOption);
        }

        const epicId: string = parsed.positional[1] ?? "";
        const updateAll: boolean = hasFlag(parsed.flags, "all");
        const rawIds: string | undefined = readOption(parsed.options, "ids");
        const ids = parseIdsOption(rawIds);
        const title: string | undefined = readOption(parsed.options, "title", "t");
        const description: string | undefined = readOption(parsed.options, "description", "d");
        const append: string | undefined = readOption(parsed.options, "append");
        const status: string | undefined = readOption(parsed.options, "status", "s");

        if (updateAll && ids.length > 0) {
          return failResult({
            command: "epic.update",
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
            command: "epic.update",
            human: "Use either --append or --description, not both.",
            data: { code: "invalid_input", fields: ["append", "description"] },
            error: {
              code: "invalid_input",
              message: "--append and --description are mutually exclusive",
            },
          });
        }

        const cascadeMode = updateAll && epicId.length > 0;
        if (cascadeMode) {
          if (title !== undefined || description !== undefined || append !== undefined || !isStatusCascadeUpdateStatus(status)) {
            return failCascadeStatusUpdate("epic.update", "Epic", {
              id: epicId,
              status,
              allowedStatuses: [...STATUS_CASCADE_UPDATE_STATUSES],
              fields: {
                title: title !== undefined,
                description: description !== undefined,
                append: append !== undefined,
              },
            });
          }

          const cascade = mutations.updateEpicStatusCascade(epicId, status);
          const epic = domain.getEpicOrThrow(epicId);

          return okResult({
            command: "epic.update",
            human: formatStatusCascadeHuman("epic", cascade),
            data: {
              epic,
              cascade: buildStatusCascadeData(cascade),
            },
          });
        }

        const hasBulkTarget = (updateAll && epicId.length === 0) || ids.length > 0;
        if (hasBulkTarget) {
          if (epicId.length > 0) {
            return failResult({
              command: "epic.update",
              human: "Do not pass an epic id when using --all or --ids.",
              data: { code: "invalid_input", id: epicId },
              error: {
                code: "invalid_input",
                message: "Positional id is not allowed with --all/--ids",
              },
            });
          }

          if (title !== undefined || description !== undefined) {
            return failResult({
              command: "epic.update",
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
              command: "epic.update",
              human: "Bulk update requires --append and/or --status.",
              data: { code: "invalid_input" },
              error: {
                code: "invalid_input",
                message: "Missing bulk update fields",
              },
            });
          }

          const targets = updateAll ? [...domain.listEpics()] : ids.map((id) => domain.getEpicOrThrow(id));
          const epics = targets.map((target) =>
            mutations.updateEpic(target.id, {
              status,
              description: append === undefined ? undefined : appendLine(target.description, append),
            }),
          );

          return okResult({
            command: "epic.update",
            human: `Updated ${epics.length} epic(s)`,
            data: {
              epics,
              target: updateAll ? "all" : "ids",
              ids: epics.map((epic) => epic.id),
            },
          });
        }

        if (epicId.length === 0) {
          return failResult({
            command: "epic.update",
            human: "Provide an epic id, or use --all/--ids for bulk update.",
            data: { code: "invalid_input" },
            error: {
              code: "invalid_input",
              message: "Missing epic id",
            },
          });
        }

        const nextDescription =
          append === undefined
            ? description
            : appendLine(domain.getEpicOrThrow(epicId).description, append);
        const epic = mutations.updateEpic(epicId, { title, description: nextDescription, status });

        return okResult({
          command: "epic.update",
          human: `Updated epic ${formatEpic(epic)}`,
          data: { epic },
        });
      }
      case "delete": {
        const epicId: string = parsed.positional[1] ?? "";
        mutations.deleteEpic(epicId);

        return okResult({
          command: "epic.delete",
          human: `Deleted epic ${epicId}`,
          data: { id: epicId },
        });
      }
      default:
        return failResult({
          command: "epic",
          human: "Usage: trekoon epic <create|expand|list|show|search|replace|update|delete>",
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
    database?.close();
  }
}
