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
import {
  buildTaskReadiness,
  DEFAULT_OPEN_TASK_STATUSES,
  type DependencyBlocker,
  READY_REASON_BLOCKED,
  READY_REASON_READY,
  type ReadyReason,
  taskStatusPriority,
  type TaskReadinessResult,
  type TaskReadinessSummary,
  type TaskReadyCandidate,
} from "./task-readiness";

import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { type CompactBatchResultContract, type CompactTaskSpec, type SearchEntityMatch, type TaskRecord } from "../domain/types";
import { formatHumanTable } from "../io/human-table";
import { failResult, okResult } from "../io/output";
import { type CliContext, type CliResult } from "../runtime/command-types";
import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";

function formatTask(task: TaskRecord): string {
  return `${task.id} | epic=${task.epicId} | ${task.title} | ${task.status}`;
}

const VIEW_MODES = ["table", "compact", "tree", "detail"] as const;
const LIST_VIEW_MODES = ["table", "compact"] as const;
const DEFAULT_TASK_LIST_LIMIT = 10;
const SEARCH_OPTIONS = ["fields", "preview"] as const;
const REPLACE_OPTIONS = ["search", "replace", "fields", "preview", "apply"] as const;
const CREATE_MANY_OPTIONS = ["epic", "e", "task"] as const;

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

function taskStatusPriority(status: string): number {
  if (status === "in_progress" || status === "in-progress") {
    return 0;
  }

  if (status === "todo") {
    return 1;
  }

  return 2;
}

function buildTaskReadiness(domain: TrackerDomain, epicId: string | undefined): TaskReadinessResult {
  const openStatuses = new Set<string>(DEFAULT_OPEN_TASK_STATUSES);
  const openTasks = domain.listTasks(epicId).filter((task) => openStatuses.has(task.status));
  const assessed = openTasks
    .map((task) => {
      const blockers: DependencyBlocker[] = [];
      const dependencies = domain.listDependencies(task.id);
      for (const dependency of dependencies) {
        const dependencyStatus =
          dependency.dependsOnKind === "task"
            ? domain.getTaskOrThrow(dependency.dependsOnId).status
            : domain.getSubtaskOrThrow(dependency.dependsOnId).status;

        if (dependencyStatus !== "done") {
          blockers.push({
            id: dependency.dependsOnId,
            kind: dependency.dependsOnKind,
            status: dependencyStatus,
          });
        }
      }

      const blockerCount = blockers.length;
      const readinessReason: ReadyReason = blockerCount === 0 ? READY_REASON_READY : READY_REASON_BLOCKED;
      return {
        task,
        readiness: {
          isReady: blockerCount === 0,
          reason: readinessReason,
        },
        blockerSummary: {
          totalDependencies: dependencies.length,
          blockedByCount: blockerCount,
          blockedBy: blockers,
        },
        ranking: {
          statusPriority: taskStatusPriority(task.status),
          blockerCount,
          createdAt: task.createdAt,
          id: task.id,
        },
      };
    })
    .sort((left, right) => {
      const byStatus = left.ranking.statusPriority - right.ranking.statusPriority;
      if (byStatus !== 0) {
        return byStatus;
      }

      const byBlockers = left.ranking.blockerCount - right.ranking.blockerCount;
      if (byBlockers !== 0) {
        return byBlockers;
      }

      const byCreatedAt = left.ranking.createdAt - right.ranking.createdAt;
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }

      return left.ranking.id.localeCompare(right.ranking.id);
    })
    .map((item, index) => ({
      ...item,
      ranking: {
        ...item.ranking,
        rank: index + 1,
      },
    }));

  const candidates = assessed.filter((item) => item.readiness.isReady);
  const blocked = assessed.filter((item) => !item.readiness.isReady);
  return {
    candidates,
    blocked,
    summary: {
      totalOpenTasks: assessed.length,
      readyCount: candidates.length,
      returnedCount: candidates.length,
      appliedLimit: null,
      blockedCount: blocked.length,
      unresolvedDependencyCount: blocked.reduce((total, item) => total + item.blockerSummary.blockedByCount, 0),
    },
  };
}

function formatTaskReadyCandidateLine(candidate: TaskReadyCandidate): string {
  return `${candidate.ranking.rank}. ${formatTask(candidate.task)} | reason=${candidate.readiness.reason} | blockers=${candidate.blockerSummary.blockedByCount}/${candidate.blockerSummary.totalDependencies}`;
}

function formatTaskReadyHumanOutput(result: TaskReadinessResult): string {
  if (result.candidates.length === 0) {
    return `No ready tasks found. Open=${result.summary.totalOpenTasks}, ready=${result.summary.readyCount}, returned=${result.summary.returnedCount}, blocked=${result.summary.blockedCount}, unresolvedDependencies=${result.summary.unresolvedDependencyCount}.`;
  }

  const lines = result.candidates.map(formatTaskReadyCandidateLine);
  lines.push(
    `Summary: ready=${result.summary.readyCount}, returned=${result.summary.returnedCount}, blocked=${result.summary.blockedCount}, unresolvedDependencies=${result.summary.unresolvedDependencyCount}.`,
  );
  return lines.join("\n");
}

function filterSortAndLimitTasks(
  tasks: readonly TaskRecord[],
  statuses: readonly string[] | undefined,
  limit: number | undefined,
  cursor: number,
): { tasks: TaskRecord[]; pagination: { hasMore: boolean; nextCursor: string | null } } {
  const allowedStatuses = statuses === undefined ? undefined : new Set(statuses);
  const filtered = allowedStatuses === undefined ? [...tasks] : tasks.filter((task) => allowedStatuses.has(task.status));
  const sorted = [...filtered].sort((left, right) => {
    const byStatus = taskStatusPriority(left.status) - taskStatusPriority(right.status);
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
      tasks: sorted,
      pagination: {
        hasMore: false,
        nextCursor: null,
      },
    };
  }

  const pagedTasks = sorted.slice(cursor, cursor + limit);
  const nextIndex = cursor + pagedTasks.length;
  const hasMore = nextIndex < sorted.length;
  return {
    tasks: pagedTasks,
    pagination: {
      hasMore,
      nextCursor: hasMore ? `${nextIndex}` : null,
    },
  };
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
  return unexpectedFailureResult(error, {
    command: "task",
    human: "Unexpected task command failure",
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

function failEmptyCompactField(command: string, option: string, index: number, rawSpec: string, field: string): CliResult {
  return failBatchSpec(command, `${option === "task" ? "Task" : "Spec"} spec ${index + 1} is missing a ${field}.`, {
    option,
    index,
    rawSpec,
    field,
  });
}

function parseTaskCreateManySpecs(rawSpecs: readonly string[]): { specs: CompactTaskSpec[]; error?: CliResult } {
  const specs: CompactTaskSpec[] = [];
  const seenTempKeys = new Set<string>();

  for (const [index, rawSpec] of rawSpecs.entries()) {
    const parsed = parseCompactFields(rawSpec);
    if (parsed.invalidEscape !== null) {
      return {
        specs: [],
        error: failBatchSpec("task.create-many", `Invalid escape sequence ${parsed.invalidEscape} in --task spec ${index + 1}.`, {
          option: "task",
          index,
          rawSpec,
          invalidEscape: parsed.invalidEscape,
        }),
      };
    }

    if (parsed.hasDanglingEscape) {
      return {
        specs: [],
        error: failBatchSpec("task.create-many", `Trailing escape in --task spec ${index + 1}.`, {
          option: "task",
          index,
          rawSpec,
        }),
      };
    }

    if (parsed.fields.length !== 4) {
      return {
        specs: [],
        error: failBatchSpec("task.create-many", `Task specs must use <temp-key>|<title>|<description>|<status> in --task spec ${index + 1}.`, {
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
        error: failBatchSpec("task.create-many", `Task spec ${index + 1} must start with a temp key like seed-1.`, {
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
        error: failBatchSpec("task.create-many", `Duplicate temp key '${tempKey}' in --task specs.`, {
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
        error: failBatchSpec("task.create-many", `Task spec ${index + 1} is missing a title.`, {
          option: "task",
          index,
          rawSpec,
        }),
      };
    }

    if (description.trim().length === 0) {
      return {
        specs: [],
        error: failEmptyCompactField("task.create-many", "task", index, rawSpec, "description"),
      };
    }

    seenTempKeys.add(tempKey);
    const spec: CompactTaskSpec = status.length > 0
      ? {
          tempKey,
          title,
          description,
          status,
        }
      : {
          tempKey,
          title,
          description,
        };

    specs.push(spec);
  }

  return { specs };
}

export async function runTask(context: CliContext): Promise<CliResult> {
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
      case "create-many": {
        const createManyUnknownOption = findUnknownOption(parsed, CREATE_MANY_OPTIONS);
        if (createManyUnknownOption !== undefined) {
          return unknownOption("task.create-many", createManyUnknownOption, CREATE_MANY_OPTIONS);
        }

        const missingCreateManyOption = readMissingOptionValue(parsed.missingOptionValues, "epic", "e", "task");
        if (missingCreateManyOption !== undefined) {
          return failMissingOptionValue("task.create-many", missingCreateManyOption);
        }

        const unexpectedPositionals = readUnexpectedPositionals(parsed, 1);
        if (unexpectedPositionals.length > 0) {
          return failUnexpectedPositionals("task.create-many", unexpectedPositionals);
        }

        const epicId = readOption(parsed.options, "epic", "e");
        if (epicId === undefined || epicId.trim().length === 0) {
          return failBatchSpec("task.create-many", "Provide --epic for task create-many.", {
            option: "epic",
          });
        }

        const rawSpecs = readOptions(parsed.optionEntries, "task");
        if (rawSpecs.length === 0) {
          return failBatchSpec("task.create-many", "Provide at least one --task spec.", {
            option: "task",
          });
        }

        const specResult = parseTaskCreateManySpecs(rawSpecs);
        if (specResult.error !== undefined) {
          return specResult.error;
        }

        const created = mutations.createTaskBatch({
          epicId,
          specs: specResult.specs,
        });
        const result: CompactBatchResultContract = created.result;
        return okResult({
          command: "task.create-many",
          human: `Created ${created.tasks.length} task(s): ${created.tasks.map(formatTask).join("\n")}`,
          data: {
            epicId,
            tasks: created.tasks,
            result,
          },
        });
      }
      case "list": {
        const missingListOption =
          readMissingOptionValue(parsed.missingOptionValues, "view") ??
          readMissingOptionValue(parsed.missingOptionValues, "status", "s") ??
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "cursor") ??
          readMissingOptionValue(parsed.missingOptionValues, "epic", "e");
        if (missingListOption !== undefined) {
          return failMissingOptionValue("task.list", missingListOption);
        }

        const rawView: string | undefined = readOption(parsed.options, "view");
        const view = readEnumOption(parsed.options, VIEW_MODES, "view");
        const includeAll = hasFlag(parsed.flags, "all");
        const rawStatuses = readOption(parsed.options, "status", "s");
        const rawLimit = readOption(parsed.options, "limit", "l");
        const rawCursor = readOption(parsed.options, "cursor");

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

        if (includeAll && rawCursor !== undefined) {
          return failResult({
            command: "task.list",
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

        const parsedCursor = parseStrictNonNegativeInt(rawCursor);
        if (Number.isNaN(parsedCursor)) {
          return failResult({
            command: "task.list",
            human: "Invalid --cursor value. Use an integer >= 0.",
            data: { code: "invalid_input", cursor: rawCursor },
            error: {
              code: "invalid_input",
              message: "Invalid --cursor value",
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
        const listed = filterSortAndLimitTasks(domain.listTasks(epicId), selectedStatuses, selectedLimit, parsedCursor ?? 0);
        const tasks = listed.tasks;
        const listView = view ?? "table";
        const human = tasks.length === 0 ? "No tasks found." : listView === "compact" ? tasks.map(formatTask).join("\n") : formatTaskListTable(tasks);

        return okResult({
          command: "task.list",
          human,
          data: { tasks },
          ...(context.mode === "human"
            ? {}
            : {
                meta: {
                  pagination: listed.pagination,
                  defaults: {
                    statuses: !includeAll && statuses === undefined ? [...DEFAULT_OPEN_TASK_STATUSES] : null,
                    limit: !includeAll && parsedLimit === undefined ? DEFAULT_TASK_LIST_LIMIT : null,
                    cursor: parsedCursor === undefined ? 0 : null,
                    view: view === undefined ? "table" : null,
                  },
                  filters: {
                    epicId: epicId ?? null,
                    statuses: selectedStatuses ?? null,
                    includeAll,
                  },
                  truncation: {
                    applied: listed.pagination.hasMore,
                    returned: tasks.length,
                    limit: selectedLimit ?? null,
                  },
                },
              }),
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

        const taskTree = domain.buildTaskTreeDetailed(taskId);

        if (effectiveView === "tree") {
          return okResult({
            command: "task.show",
            human: formatTaskShowTree(taskTree),
            data: { task: taskTree, includeAll: true, subtasksCount: taskTree.subtasks.length },
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
                      applied: effectiveView === "tree",
                      scope: "tree",
                    },
                  },
                }),
          });
        }

        return okResult({
          command: "task.show",
          human: effectiveView === "table" ? formatTaskShowTable(taskTree) : formatTaskShowDetail(taskTree),
          data: { task: taskTree, includeAll: true, subtasksCount: taskTree.subtasks.length },
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
      case "ready": {
        const missingReadyOption =
          readMissingOptionValue(parsed.missingOptionValues, "limit", "l") ??
          readMissingOptionValue(parsed.missingOptionValues, "epic", "e");
        if (missingReadyOption !== undefined) {
          return failMissingOptionValue("task.ready", missingReadyOption);
        }

        const rawLimit = readOption(parsed.options, "limit", "l");
        const parsedLimit = parseStrictPositiveInt(rawLimit);
        if (Number.isNaN(parsedLimit)) {
          return failResult({
            command: "task.ready",
            human: "Invalid --limit value. Use an integer >= 1.",
            data: { code: "invalid_input", limit: rawLimit },
            error: {
              code: "invalid_input",
              message: "Invalid --limit value",
            },
          });
        }

        const epicId = readOption(parsed.options, "epic", "e");
        const readiness = buildTaskReadiness(domain, epicId);
        const limit = parsedLimit ?? readiness.candidates.length;
        const candidates = readiness.candidates.slice(0, limit);
        const summary = {
          ...readiness.summary,
          returnedCount: candidates.length,
          appliedLimit: parsedLimit ?? null,
        };

        return okResult({
          command: "task.ready",
          human: formatTaskReadyHumanOutput({
            ...readiness,
            candidates,
            summary,
          }),
          data: {
            candidates,
            blocked: readiness.blocked.map((item) => ({
              task: item.task,
              readiness: item.readiness,
              blockerSummary: item.blockerSummary,
              ranking: item.ranking,
            })),
            summary: {
              ...summary,
            },
          },
        });
      }
      case "next": {
        const missingNextOption = readMissingOptionValue(parsed.missingOptionValues, "epic", "e");
        if (missingNextOption !== undefined) {
          return failMissingOptionValue("task.next", missingNextOption);
        }

        const epicId = readOption(parsed.options, "epic", "e");
        const readiness = buildTaskReadiness(domain, epicId);
        const candidate = readiness.candidates[0] ?? null;

        return okResult({
          command: "task.next",
          human:
            candidate === null
              ? formatTaskReadyHumanOutput(readiness)
              : `${formatTaskReadyCandidateLine(candidate)}\nSummary: ready=${readiness.summary.readyCount}, blocked=${readiness.summary.blockedCount}, unresolvedDependencies=${readiness.summary.unresolvedDependencyCount}.`,
          data: {
            candidate,
            summary: readiness.summary,
            blocked: readiness.blocked.map((item) => ({
              task: item.task,
              readiness: item.readiness,
              blockerSummary: item.blockerSummary,
              ranking: item.ranking,
            })),
          },
        });
      }
      case "search": {
        const searchUnknownOption = findUnknownOption(parsed, SEARCH_OPTIONS);
        if (searchUnknownOption !== undefined) {
          return unknownOption("task.search", searchUnknownOption, SEARCH_OPTIONS);
        }

        const missingSearchOption = readMissingOptionValue(parsed.missingOptionValues, "fields");
        if (missingSearchOption !== undefined) {
          return failMissingOptionValue("task.search", missingSearchOption);
        }

        const taskId: string = parsed.positional[1] ?? "";
        const searchText: string = parsed.positional[2] ?? "";
        if (taskId.length === 0 || searchText.trim().length === 0) {
          return invalidSearchInput(
            "task.search",
            "Usage: trekoon task search <task-id> \"search text\" [--fields <csv>] [--preview]",
            "Missing search target",
            {
              taskId,
            },
          );
        }

        const parsedFields = parseCsvEnumOption(readOption(parsed.options, "fields"), SEARCH_REPLACE_FIELDS);
        if (parsedFields.empty || parsedFields.invalidValues.length > 0) {
          return invalidSearchInput("task.search", "Invalid --fields value. Use title, description, or title,description.", "Invalid --fields value", {
            fields: readOption(parsed.options, "fields"),
            invalidFields: parsedFields.invalidValues,
            allowedFields: [...SEARCH_REPLACE_FIELDS],
          });
        }

        const { matches, summary } = domain.searchTaskScope(taskId, searchText, parsedFields.values);

        return okResult({
          command: "task.search",
          human: formatSearchHuman(matches, "No matches found."),
          data: {
            scope: {
              kind: "task",
              id: taskId,
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
          return unknownOption("task.replace", replaceUnknownOption, REPLACE_OPTIONS);
        }

        const missingReplaceOption =
          readMissingOptionValue(parsed.missingOptionValues, "search") ??
          readMissingOptionValue(parsed.missingOptionValues, "replace") ??
          readMissingOptionValue(parsed.missingOptionValues, "fields");
        if (missingReplaceOption !== undefined) {
          return failMissingOptionValue("task.replace", missingReplaceOption);
        }

        const taskId: string = parsed.positional[1] ?? "";
        const searchText = readOption(parsed.options, "search") ?? "";
        const replacementText = readOption(parsed.options, "replace") ?? "";
        if (taskId.length === 0 || searchText.trim().length === 0) {
          return invalidSearchInput(
            "task.replace",
            "Usage: trekoon task replace <task-id> --search \"text\" --replace \"text\" [--fields <csv>] [--preview|--apply]",
            "Missing replace target",
            {
              taskId,
              search: searchText,
            },
          );
        }

        const rawFields = readOption(parsed.options, "fields");
        const parsedFields = parseCsvEnumOption(rawFields, SEARCH_REPLACE_FIELDS);
        if (parsedFields.empty || parsedFields.invalidValues.length > 0) {
          return invalidSearchInput("task.replace", "Invalid --fields value. Use title, description, or title,description.", "Invalid --fields value", {
            fields: rawFields,
            invalidFields: parsedFields.invalidValues,
            allowedFields: [...SEARCH_REPLACE_FIELDS],
          });
        }

        const previewMode = resolvePreviewApplyMode(parsed.flags);
        if (previewMode.conflict) {
          return invalidSearchInput("task.replace", "Use either --preview or --apply, not both.", "Conflicting mode flags", {
            flags: ["preview", "apply"],
          });
        }

        const replacementSummary = previewMode.mode === "apply"
          ? mutations.applyTaskReplacement(taskId, searchText, replacementText, parsedFields.values)
          : mutations.previewTaskReplacement(taskId, searchText, replacementText, parsedFields.values);
        const { matches, summary: matchSummary } = replacementSummary;

        const summary = {
          ...matchSummary,
          mode: previewMode.mode,
        };

        return okResult({
          command: "task.replace",
          human: formatSearchHuman(matches, `No ${previewMode.mode === "apply" ? "replacements" : "matches"} found.`),
          data: {
            scope: {
              kind: "task",
              id: taskId,
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
      case "done": {
        const taskId: string = parsed.positional[1] ?? "";
        if (taskId.length === 0) {
          return failResult({
            command: "task.done",
            human: "Provide a task id. Usage: trekoon task done <id>",
            data: { code: "invalid_input" },
            error: {
              code: "invalid_input",
              message: "Missing task id",
            },
          });
        }

        const existingTask = domain.getTask(taskId);
        if (!existingTask) {
          return failResult({
            command: "task.done",
            human: `Task not found: ${taskId}`,
            data: { code: "not_found", id: taskId },
            error: {
              code: "not_found",
              message: `Task not found: ${taskId}`,
            },
          });
        }

        if (existingTask.status === "done") {
          return failResult({
            command: "task.done",
            human: "Task is already done",
            data: { code: "already_done", id: taskId },
            error: {
              code: "already_done",
              message: "Task is already done",
            },
          });
        }

        const completed = mutations.updateTask(taskId, { status: "done" });
        const readiness = buildTaskReadiness(domain, completed.epicId);
        const nextCandidate = readiness.candidates[0] ?? null;

        const nextTree = nextCandidate !== null ? domain.buildTaskTreeDetailed(nextCandidate.task.id) : null;
        const nextDeps = nextCandidate !== null ? domain.listDependencies(nextCandidate.task.id) : null;

        const readinessStats = {
          readyCount: readiness.summary.readyCount,
          blockedCount: readiness.summary.blockedCount,
        };

        let human = `Task ${completed.title} marked done.`;
        if (nextTree !== null && nextCandidate !== null) {
          human += `\nNext: ${formatTask(nextCandidate.task)}`;
        }
        human += `\nReadiness: ready=${readinessStats.readyCount}, blocked=${readinessStats.blockedCount}.`;

        return okResult({
          command: "task.done",
          human,
          data: {
            completed,
            next: nextTree,
            nextDeps,
            readiness: readinessStats,
          },
        });
      }
      case "delete": {
        const taskId: string = parsed.positional[1] ?? "";
        mutations.deleteTask(taskId);

        return okResult({
          command: "task.delete",
          human: `Deleted task ${taskId}`,
          data: { id: taskId },
        });
      }
      default:
        return failResult({
          command: "task",
          human: "Usage: trekoon task <create|create-many|list|show|ready|next|done|search|replace|update|delete>",
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
    database?.close();
  }
}
