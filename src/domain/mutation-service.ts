import { type Database } from "bun:sqlite";

import { writeTransaction } from "../storage/database";
import { appendEventWithGitContext, prepareEventWriteContext, withTransactionEventContext } from "../sync/event-writes";
import { ENTITY_OPERATIONS } from "./mutation-operations";
import { TrackerDomain, validateStatusTransition } from "./tracker-domain";
import {
  type CompactEpicCreateResult,
  type CompactEpicExpandResult,
  type CompactDependencyBatchAddResult,
  type CompactDependencySpec,
  type CompactSubtaskBatchCreateResult,
  type CompactSubtaskSpec,
  type CompactTaskBatchCreateResult,
  type CompactTaskSpec,
  type DependencyRecord,
  type EpicRecord,
  type SearchEntityMatch,
  type SearchField,
  type SearchNode,
  type SearchSummary,
  type StatusCascadeBlocker,
  type StatusCascadePlan,
  type SubtaskRecord,
  type TaskRecord,
  DomainError,
} from "./types";

interface AtomicIdempotencyClaim {
  readonly scope: "subtask" | "dependency" | "deleted_subtask" | "deleted_dependency";
  readonly idempotencyKey: string;
  readonly requestFingerprint: string;
  readonly conflictMessage: string;
}

interface AtomicIdempotencyReplayResult {
  readonly state: "replay";
  readonly status: number;
  readonly responseData: Record<string, unknown>;
}

interface AtomicIdempotencyCompletedResult {
  readonly state: "completed";
  readonly status: number;
  readonly responseData: Record<string, unknown>;
}

type AtomicIdempotentMutationResult =
  | AtomicIdempotencyReplayResult
  | AtomicIdempotencyCompletedResult;

const BOARD_IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function countMatches(value: string, searchText: string): number {
  if (searchText.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset <= value.length - searchText.length) {
    const nextIndex = value.indexOf(searchText, offset);
    if (nextIndex === -1) {
      return count;
    }

    count += 1;
    offset = nextIndex + searchText.length;
  }

  return count;
}

function replaceMatches(value: string, searchText: string, replacement: string): string {
  return searchText.length === 0 ? value : value.split(searchText).join(replacement);
}

function buildMatchSnippet(value: string, searchText: string, contextSize = 24): string {
  if (searchText.length === 0) {
    return "";
  }

  const matchIndex = value.indexOf(searchText);
  if (matchIndex === -1) {
    return "";
  }

  const start = Math.max(0, matchIndex - contextSize);
  const end = Math.min(value.length, matchIndex + searchText.length + contextSize);
  const rawSnippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${rawSnippet}${suffix}`;
}

function buildReplacementSnippet(value: string, replacementIndex: number, replacementLength: number, contextSize = 24): string {
  const start = Math.max(0, replacementIndex - contextSize);
  const end = Math.min(value.length, replacementIndex + replacementLength + contextSize);
  const rawSnippet = value.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < value.length ? "…" : "";
  return `${prefix}${rawSnippet}${suffix}`;
}

function summarizeMatches(matches: readonly SearchEntityMatch[]): SearchSummary {
  return {
    matchedEntities: matches.length,
    matchedFields: matches.reduce((total, match) => total + match.fields.length, 0),
    totalMatches: matches.reduce(
      (total, match) => total + match.fields.reduce((fieldTotal, field) => fieldTotal + field.count, 0),
      0,
    ),
  };
}

interface ScopeReplacementResult {
  readonly matches: readonly SearchEntityMatch[];
  readonly summary: SearchSummary;
}

export class MutationService {
  readonly #db: Database;
  readonly #cwd: string;
  readonly #domain: TrackerDomain;

  constructor(db: Database, cwd: string) {
    this.#db = db;
    this.#cwd = cwd;
    this.#domain = new TrackerDomain(db);
  }

  #writeTransaction<T>(fn: () => T): T {
    const eventContext = prepareEventWriteContext(this.#db, this.#cwd);
    return writeTransaction(this.#db, (): T => withTransactionEventContext(this.#db, eventContext, fn));
  }

  #dependencyEventEntityId(input: {
    sourceId: string;
    sourceKind: string;
    dependsOnId: string;
    dependsOnKind: string;
  }): string {
    return `${input.sourceKind}:${input.sourceId}->${input.dependsOnKind}:${input.dependsOnId}`;
  }

  #dependencyEventFields(input: {
    dependencyId?: string | undefined;
    sourceId: string;
    sourceKind?: string | undefined;
    dependsOnId: string;
    dependsOnKind?: string | undefined;
    sourceEventId?: string | undefined;
  }): Record<string, string> {
    const fields: Record<string, string> = {
      source_id: input.sourceId,
      depends_on_id: input.dependsOnId,
    };

    if (input.dependencyId) {
      fields.dependency_id = input.dependencyId;
    }

    if (input.sourceKind) {
      fields.source_kind = input.sourceKind;
    }

    if (input.dependsOnKind) {
      fields.depends_on_kind = input.dependsOnKind;
    }

    if (input.sourceEventId) {
      fields.source_event_id = input.sourceEventId;
    }

    return fields;
  }

  createEpic(input: { title: string; description: string; status?: string | undefined }): EpicRecord {
    return this.#writeTransaction((): EpicRecord => {
      const epic = this.#domain.createEpic(input);
      this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.created, {
        title: epic.title,
        description: epic.description,
        status: epic.status,
      });
      return epic;
    });
  }

  createEpicGraph(input: {
    title: string;
    description: string;
    status?: string | undefined;
    taskSpecs: readonly CompactTaskSpec[];
    subtaskSpecs: readonly CompactSubtaskSpec[];
    dependencySpecs: readonly CompactDependencySpec[];
  }): CompactEpicCreateResult {
    return this.#writeTransaction((): CompactEpicCreateResult => {
      const epic = this.#domain.createEpic(input);
      const created = this.#domain.expandEpic({
        epicId: epic.id,
        taskSpecs: input.taskSpecs,
        subtaskSpecs: input.subtaskSpecs,
        dependencySpecs: input.dependencySpecs,
      });

      this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.created, {
        title: epic.title,
        description: epic.description,
        status: epic.status,
      });

      for (const task of created.tasks) {
        this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.created, {
          epic_id: task.epicId,
          title: task.title,
          description: task.description,
          status: task.status,
        });
      }

      for (const subtask of created.subtasks) {
        this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
          task_id: subtask.taskId,
          title: subtask.title,
          description: subtask.description,
          status: subtask.status,
        });
      }

      for (const dependency of created.dependencies) {
        this.#appendEntityEvent(
          "dependency",
          this.#dependencyEventEntityId(dependency),
          ENTITY_OPERATIONS.dependency.added,
          this.#dependencyEventFields({
            dependencyId: dependency.id,
            sourceId: dependency.sourceId,
            sourceKind: dependency.sourceKind,
            dependsOnId: dependency.dependsOnId,
            dependsOnKind: dependency.dependsOnKind,
          }),
        );
      }

      return {
        epic,
        tasks: created.tasks,
        subtasks: created.subtasks,
        dependencies: created.dependencies,
        result: created.result,
      };
    });
  }

  updateEpic(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): EpicRecord {
    return this.#writeTransaction((): EpicRecord => {
      if (input.status !== undefined) {
        const existing = this.#domain.getEpicOrThrow(id);
        validateStatusTransition(existing.status, input.status, "epic", id);
      }
      const epic = this.#domain.updateEpic(id, input);
      this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.updated, {
        title: epic.title,
        description: epic.description,
        status: epic.status,
      });
      return epic;
    });
  }

  updateEpicStatusCascade(id: string, status: string): StatusCascadePlan {
    return this.#writeTransaction((): StatusCascadePlan => {
      const plan = this.#domain.planStatusCascade("epic", id, status);
      this.#assertCascadeNotBlocked(plan);
      this.#applyStatusCascadePlan(plan);
      return plan;
    });
  }

  deleteEpic(id: string): void {
    this.#writeTransaction((): void => {
      this.#domain.deleteEpic(id);
      this.#appendEntityEvent("epic", id, ENTITY_OPERATIONS.epic.deleted, {});
    });
  }

  createTask(input: { epicId: string; title: string; description: string; status?: string | undefined }): TaskRecord {
    return this.#writeTransaction((): TaskRecord => {
      const task = this.#domain.createTask(input);
      this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.created, {
        epic_id: task.epicId,
        title: task.title,
        description: task.description,
        status: task.status,
      });
      return task;
    });
  }

  createTaskBatch(input: { epicId: string; specs: readonly CompactTaskSpec[] }): CompactTaskBatchCreateResult {
    return this.#writeTransaction((): CompactTaskBatchCreateResult => {
      const created = this.#domain.createTaskBatch(input);
      for (const task of created.tasks) {
        this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.created, {
          epic_id: task.epicId,
          title: task.title,
          description: task.description,
          status: task.status,
        });
      }
      return created;
    });
  }

  expandEpic(input: {
    epicId: string;
    taskSpecs: readonly CompactTaskSpec[];
    subtaskSpecs: readonly CompactSubtaskSpec[];
    dependencySpecs: readonly CompactDependencySpec[];
  }): CompactEpicExpandResult {
    return this.#writeTransaction((): CompactEpicExpandResult => {
      const created = this.#domain.expandEpic(input);
      for (const task of created.tasks) {
        this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.created, {
          epic_id: task.epicId,
          title: task.title,
          description: task.description,
          status: task.status,
        });
      }

      for (const subtask of created.subtasks) {
        this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
          task_id: subtask.taskId,
          title: subtask.title,
          description: subtask.description,
          status: subtask.status,
        });
      }

      for (const dependency of created.dependencies) {
        this.#appendEntityEvent(
          "dependency",
          this.#dependencyEventEntityId(dependency),
          ENTITY_OPERATIONS.dependency.added,
          this.#dependencyEventFields({
            dependencyId: dependency.id,
            sourceId: dependency.sourceId,
            sourceKind: dependency.sourceKind,
            dependsOnId: dependency.dependsOnId,
            dependsOnKind: dependency.dependsOnKind,
          }),
        );
      }

      return created;
    });
  }

  updateTask(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined; owner?: string | null | undefined },
  ): TaskRecord {
    return this.#writeTransaction((): TaskRecord => {
      if (input.status !== undefined) {
        const existing = this.#domain.getTaskOrThrow(id);
        validateStatusTransition(existing.status, input.status, "task", id);
      }
      const task = this.#domain.updateTask(id, input);
      this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.updated, {
        epic_id: task.epicId,
        title: task.title,
        description: task.description,
        status: task.status,
        owner: task.owner,
      });
      return task;
    });
  }

  updateTaskStatusCascade(id: string, status: string): StatusCascadePlan {
    return this.#writeTransaction((): StatusCascadePlan => {
      const plan = this.#domain.planStatusCascade("task", id, status);
      this.#assertCascadeNotBlocked(plan);
      this.#applyStatusCascadePlan(plan);
      return plan;
    });
  }

  deleteTask(id: string): { deletedSubtaskIds: string[]; deletedDependencyIds: string[] } {
    return this.#writeTransaction((): { deletedSubtaskIds: string[]; deletedDependencyIds: string[] } => {
      const plan = this.#domain.planTaskDeletion(id);
      this.#domain.deleteTask(id);
      const taskDeleteEventId = this.#appendEntityEvent("task", id, ENTITY_OPERATIONS.task.deleted, {});

      for (const subtaskId of plan.subtaskIds) {
        this.#appendEntityEvent("subtask", subtaskId, ENTITY_OPERATIONS.subtask.deleted, {
          task_id: id,
          source_event_id: taskDeleteEventId,
        });
      }

      for (const dependency of plan.touchingDependencies) {
          this.#appendEntityEvent(
            "dependency",
            this.#dependencyEventEntityId(dependency),
            ENTITY_OPERATIONS.dependency.removed,
            this.#dependencyEventFields({
              dependencyId: dependency.id,
              sourceId: dependency.sourceId,
              sourceKind: dependency.sourceKind,
              dependsOnId: dependency.dependsOnId,
              dependsOnKind: dependency.dependsOnKind,
              sourceEventId: taskDeleteEventId,
            }),
          );
      }

      return {
        deletedSubtaskIds: [...plan.subtaskIds],
        deletedDependencyIds: plan.touchingDependencies.map((dependency) => dependency.id),
      };
    });
  }

  createSubtask(input: {
    taskId: string;
    title: string;
    description?: string | undefined;
    status?: string | undefined;
  }): SubtaskRecord {
    return this.#writeTransaction((): SubtaskRecord => {
      const subtask = this.#domain.createSubtask(input);
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
      });
      return subtask;
    });
  }

  createSubtaskAtomicallyWithIdempotency(input: {
    taskId: string;
    title: string;
    description?: string | undefined;
    status?: string | undefined;
    claim: AtomicIdempotencyClaim;
    buildResponseData: (result: { subtask: SubtaskRecord; domain: TrackerDomain }) => Record<string, unknown>;
  }): AtomicIdempotentMutationResult {
    return this.#completeAtomicIdempotentMutation(input.claim, (): AtomicIdempotencyCompletedResult => {
      const subtask = this.#domain.createSubtask(input);
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
      });
      return {
        state: "completed",
        status: 201,
        responseData: input.buildResponseData({ subtask, domain: this.#domain }),
      };
    });
  }

  createSubtaskBatch(input: { taskId: string; specs: readonly CompactSubtaskSpec[] }): CompactSubtaskBatchCreateResult {
    return this.#writeTransaction((): CompactSubtaskBatchCreateResult => {
      const created = this.#domain.createSubtaskBatch(input);
      for (const subtask of created.subtasks) {
        this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
          task_id: subtask.taskId,
          title: subtask.title,
          description: subtask.description,
          status: subtask.status,
        });
      }
      return created;
    });
  }

  updateSubtask(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined; owner?: string | null | undefined },
  ): SubtaskRecord {
    return this.#writeTransaction((): SubtaskRecord => {
      if (input.status !== undefined) {
        const existing = this.#domain.getSubtaskOrThrow(id);
        validateStatusTransition(existing.status, input.status, "subtask", id);
      }
      const subtask = this.#domain.updateSubtask(id, input);
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
        owner: subtask.owner,
      });
      return subtask;
    });
  }

  deleteSubtask(id: string): { deletedDependencyIds: string[] } {
    return this.#writeTransaction((): { deletedDependencyIds: string[] } => {
      const touchingDependencies = this.#domain.listDependenciesTouchingNode(id);
      this.#domain.deleteSubtask(id);
      const subtaskDeleteEventId = this.#appendEntityEvent("subtask", id, ENTITY_OPERATIONS.subtask.deleted, {});
      for (const dependency of touchingDependencies) {
        this.#appendEntityEvent(
          "dependency",
          this.#dependencyEventEntityId(dependency),
          ENTITY_OPERATIONS.dependency.removed,
          this.#dependencyEventFields({
            dependencyId: dependency.id,
            sourceId: dependency.sourceId,
            sourceKind: dependency.sourceKind,
            dependsOnId: dependency.dependsOnId,
            dependsOnKind: dependency.dependsOnKind,
            sourceEventId: subtaskDeleteEventId,
          }),
        );
      }
      return {
        deletedDependencyIds: touchingDependencies.map((dependency) => dependency.id),
      };
    });
  }

  deleteSubtaskAtomicallyWithIdempotency(input: {
    id: string;
    claim: AtomicIdempotencyClaim;
    buildResponseData: (result: {
      subtaskId: string;
      deletedDependencyIds: string[];
      domain: TrackerDomain;
      taskId: string;
      epicId: string;
    }) => Record<string, unknown>;
  }): AtomicIdempotentMutationResult {
    return this.#completeAtomicIdempotentMutation(input.claim, (): AtomicIdempotencyCompletedResult => {
      const existingSubtask = this.#domain.getSubtaskOrThrow(input.id);
      const task = this.#domain.getTaskOrThrow(existingSubtask.taskId);
      const touchingDependencies = this.#domain.listDependenciesTouchingNode(input.id);
      this.#domain.deleteSubtask(input.id);
      const subtaskDeleteEventId = this.#appendEntityEvent("subtask", input.id, ENTITY_OPERATIONS.subtask.deleted, {});
      for (const dependency of touchingDependencies) {
        this.#appendEntityEvent(
          "dependency",
          this.#dependencyEventEntityId(dependency),
          ENTITY_OPERATIONS.dependency.removed,
          this.#dependencyEventFields({
            dependencyId: dependency.id,
            sourceId: dependency.sourceId,
            sourceKind: dependency.sourceKind,
            dependsOnId: dependency.dependsOnId,
            dependsOnKind: dependency.dependsOnKind,
            sourceEventId: subtaskDeleteEventId,
          }),
        );
      }

      return {
        state: "completed",
        status: 200,
        responseData: input.buildResponseData({
          subtaskId: input.id,
          deletedDependencyIds: touchingDependencies.map((dependency) => dependency.id),
          domain: this.#domain,
          taskId: task.id,
          epicId: task.epicId,
        }),
      };
    });
  }

  addDependency(sourceId: string, dependsOnId: string): DependencyRecord {
    return this.#writeTransaction((): DependencyRecord => {
      const dependency = this.#domain.addDependency(sourceId, dependsOnId);
      this.#appendEntityEvent(
        "dependency",
        this.#dependencyEventEntityId(dependency),
        ENTITY_OPERATIONS.dependency.added,
        this.#dependencyEventFields({
          dependencyId: dependency.id,
          sourceId: dependency.sourceId,
          sourceKind: dependency.sourceKind,
          dependsOnId: dependency.dependsOnId,
          dependsOnKind: dependency.dependsOnKind,
        }),
      );
      return dependency;
    });
  }

  addDependencyAtomicallyWithIdempotency(input: {
    sourceId: string;
    dependsOnId: string;
    claim: AtomicIdempotencyClaim;
    buildResponseData: (result: { dependency: DependencyRecord; domain: TrackerDomain }) => Record<string, unknown>;
  }): AtomicIdempotentMutationResult {
    return this.#completeAtomicIdempotentMutation(input.claim, (): AtomicIdempotencyCompletedResult => {
      const dependency = this.#domain.addDependency(input.sourceId, input.dependsOnId);
      this.#appendEntityEvent(
        "dependency",
        this.#dependencyEventEntityId(dependency),
        ENTITY_OPERATIONS.dependency.added,
        this.#dependencyEventFields({
          dependencyId: dependency.id,
          sourceId: dependency.sourceId,
          sourceKind: dependency.sourceKind,
          dependsOnId: dependency.dependsOnId,
          dependsOnKind: dependency.dependsOnKind,
        }),
      );
      return {
        state: "completed",
        status: 201,
        responseData: input.buildResponseData({ dependency, domain: this.#domain }),
      };
    });
  }

  addDependencyBatch(input: { specs: readonly CompactDependencySpec[] }): CompactDependencyBatchAddResult {
    return this.#writeTransaction((): CompactDependencyBatchAddResult => {
      const created = this.#domain.addDependencyBatch(input);
      for (const dependency of created.dependencies) {
        this.#appendEntityEvent(
          "dependency",
          this.#dependencyEventEntityId(dependency),
          ENTITY_OPERATIONS.dependency.added,
          this.#dependencyEventFields({
            dependencyId: dependency.id,
            sourceId: dependency.sourceId,
            sourceKind: dependency.sourceKind,
            dependsOnId: dependency.dependsOnId,
            dependsOnKind: dependency.dependsOnKind,
          }),
        );
      }
      return created;
    });
  }

  removeDependency(sourceId: string, dependsOnId: string): number {
    return this.#writeTransaction((): number => {
      const existingDependency = this.#domain.listDependencies(sourceId)
        .find((dependency) => dependency.dependsOnId === dependsOnId);
      const removed = this.#domain.removeDependency(sourceId, dependsOnId);
      if (removed > 0) {
        this.#appendEntityEvent("dependency", this.#dependencyEventEntityId({
          sourceId,
          sourceKind: existingDependency?.sourceKind ?? "task",
          dependsOnId,
          dependsOnKind: existingDependency?.dependsOnKind ?? "task",
        }), ENTITY_OPERATIONS.dependency.removed, this.#dependencyEventFields({
          dependencyId: existingDependency?.id,
          sourceId,
          sourceKind: existingDependency?.sourceKind,
          dependsOnId,
          dependsOnKind: existingDependency?.dependsOnKind,
        }));
      }
      return removed;
    });
  }

  removeDependencyAtomicallyWithIdempotency(input: {
    sourceId: string;
    dependsOnId: string;
    claim: AtomicIdempotencyClaim;
    buildResponseData: (result: {
      sourceId: string;
      dependsOnId: string;
      removed: number;
      existingDependencyIds: string[];
      domain: TrackerDomain;
    }) => Record<string, unknown>;
  }): AtomicIdempotentMutationResult {
    return this.#completeAtomicIdempotentMutation(input.claim, (): AtomicIdempotencyCompletedResult => {
      const existingDependencies = this.#domain.listDependencies(input.sourceId)
        .filter((dependency) => dependency.dependsOnId === input.dependsOnId);
      const existingDependencyIds = existingDependencies.map((dependency) => dependency.id);
      const existingDependency = existingDependencies[0];
      const removed = this.#domain.removeDependency(input.sourceId, input.dependsOnId);
      if (removed === 0) {
        throw new DomainError({
          code: "not_found",
          message: "Dependency edge not found",
          details: {
            sourceId: input.sourceId,
            dependsOnId: input.dependsOnId,
          },
        });
      }
      this.#appendEntityEvent("dependency", this.#dependencyEventEntityId({
        sourceId: input.sourceId,
        sourceKind: existingDependency?.sourceKind ?? "task",
        dependsOnId: input.dependsOnId,
        dependsOnKind: existingDependency?.dependsOnKind ?? "task",
      }), ENTITY_OPERATIONS.dependency.removed, this.#dependencyEventFields({
        dependencyId: existingDependency?.id,
        sourceId: input.sourceId,
        sourceKind: existingDependency?.sourceKind,
        dependsOnId: input.dependsOnId,
        dependsOnKind: existingDependency?.dependsOnKind,
      }));
      return {
        state: "completed",
        status: 200,
        responseData: input.buildResponseData({
          sourceId: input.sourceId,
          dependsOnId: input.dependsOnId,
          removed,
          existingDependencyIds,
          domain: this.#domain,
        }),
      };
    });
  }

  describeError(error: unknown): string | undefined {
    if (!(error instanceof DomainError)) {
      return undefined;
    }

    if (error.code === "status_transition_invalid") {
      return error.message;
    }

    if (error.code !== "dependency_blocked") {
      return undefined;
    }

    const details = error.details as Record<string, unknown> | undefined;
    const unresolvedDependencies = Array.isArray(details?.unresolvedDependencies)
      ? details.unresolvedDependencies
      : [];
    if (unresolvedDependencies.length > 0) {
      const blockers = unresolvedDependencies
        .map((dependency) => {
          if (!dependency || typeof dependency !== "object") {
            return null;
          }

          const id = typeof dependency.id === "string" ? dependency.id : "unknown";
          const kind = typeof dependency.kind === "string" ? dependency.kind : "dependency";
          const status = typeof dependency.status === "string" ? dependency.status : "unknown";
          return `${kind} ${id} is still ${status}`;
        })
        .filter((value): value is string => value !== null);

      if (blockers.length > 0) {
        return `Resolve dependencies first: ${blockers.join("; ")}.`;
      }
    }

    const cascadeBlockers = Array.isArray(details?.blockers) ? details.blockers as StatusCascadeBlocker[] : [];
    if (cascadeBlockers.length > 0) {
      const blockers = cascadeBlockers.map((blocker) =>
        `${blocker.sourceKind} ${blocker.sourceId} is blocked by ${blocker.dependsOnKind} ${blocker.dependsOnId} (${blocker.dependsOnStatus})`
      );
      return `Resolve dependencies first: ${blockers.join("; ")}.`;
    }

    return undefined;
  }

  previewEpicReplacement(
    epicId: string,
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#previewScopeReplacement(this.#domain.collectEpicSearchScope(epicId), searchText, replacementText, fields);
  }

  applyEpicReplacement(
    epicId: string,
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#applyScopeReplacement(this.#domain.collectEpicSearchScope(epicId), searchText, replacementText, fields);
  }

  previewTaskReplacement(
    taskId: string,
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#previewScopeReplacement(this.#domain.collectTaskSearchScope(taskId), searchText, replacementText, fields);
  }

  applyTaskReplacement(
    taskId: string,
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#applyScopeReplacement(this.#domain.collectTaskSearchScope(taskId), searchText, replacementText, fields);
  }

  previewSubtaskReplacement(
    subtaskId: string,
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#previewScopeReplacement(this.#domain.collectSubtaskSearchScope(subtaskId), searchText, replacementText, fields);
  }

  applySubtaskReplacement(
    subtaskId: string,
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#applyScopeReplacement(this.#domain.collectSubtaskSearchScope(subtaskId), searchText, replacementText, fields);
  }

  #appendEntityEvent(
    entityKind: "epic" | "task" | "subtask" | "dependency",
    entityId: string,
    operation: string,
    fields: Record<string, unknown>,
  ): string {
    return appendEventWithGitContext(this.#db, this.#cwd, {
      entityKind,
      entityId,
      operation,
      fields,
    });
  }

  #completeAtomicIdempotentMutation(
    claim: AtomicIdempotencyClaim,
    mutate: () => AtomicIdempotencyCompletedResult,
  ): AtomicIdempotentMutationResult {
    return this.#writeTransaction((): AtomicIdempotentMutationResult => {
      this.#pruneExpiredIdempotencyKeys();
      const inserted = this.#db.query(
        `
        INSERT INTO board_idempotency_keys (
          scope,
          idempotency_key,
          request_fingerprint,
          state,
          response_status,
          response_body,
          created_at
        ) VALUES (?, ?, ?, 'pending', 0, '{}', ?)
        ON CONFLICT(scope, idempotency_key) DO NOTHING
        `,
      ).run(claim.scope, claim.idempotencyKey, claim.requestFingerprint, Date.now());

      if (inserted.changes === 0) {
        const row = this.#db.query(
          `
          SELECT request_fingerprint, response_status, response_body
          FROM board_idempotency_keys
          WHERE scope = ? AND idempotency_key = ?
          `,
        ).get(claim.scope, claim.idempotencyKey) as {
          request_fingerprint: string;
          response_status: number;
          response_body: string;
        } | null;

        if (!row) {
          throw new DomainError({
            code: "invalid_input",
            message: "Idempotency claim changed while processing request; retry the request",
          });
        }

        if (row.request_fingerprint !== claim.requestFingerprint) {
          throw new DomainError({
            code: "invalid_input",
            message: claim.conflictMessage,
            details: { field: "clientRequestId" },
          });
        }

        if (row.response_status === 0) {
          throw new DomainError({
            code: "invalid_input",
            message: "Idempotency record is incomplete; retry the request with a new idempotency key",
            details: { field: "clientRequestId" },
          });
        }

        return {
          state: "replay",
          status: row.response_status,
          responseData: JSON.parse(row.response_body) as Record<string, unknown>,
        };
      }

      const result = mutate();
      this.#db.query(
        `
        UPDATE board_idempotency_keys
        SET state = 'completed',
            response_status = ?,
            response_body = ?,
            created_at = ?
        WHERE scope = ?
          AND idempotency_key = ?
          AND request_fingerprint = ?
        `,
      ).run(result.status, JSON.stringify(result.responseData), Date.now(), claim.scope, claim.idempotencyKey, claim.requestFingerprint);
      return result;
    });
  }

  #pruneExpiredIdempotencyKeys(now: number = Date.now()): void {
    const cutoff: number = now - BOARD_IDEMPOTENCY_RETENTION_MS;
    this.#db.query(
      `
      DELETE FROM board_idempotency_keys
      WHERE state = 'completed'
        AND created_at < ?;
      `,
    ).run(cutoff);
  }

  #previewScopeReplacement(
    nodes: readonly SearchNode[],
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    return this.#buildScopeReplacementResult(nodes, searchText, replacementText, fields);
  }

  #assertCascadeNotBlocked(plan: StatusCascadePlan): void {
    if (plan.blockers.length === 0) {
      return;
    }

    throw new DomainError({
      code: "dependency_blocked",
      message: `${plan.rootKind} cascade cannot transition to ${plan.targetStatus} while dependencies are unresolved`,
      details: {
        entity: plan.rootKind,
        id: plan.rootId,
        status: plan.targetStatus,
        atomic: plan.atomic,
        changedIds: plan.changedIds,
        unchangedIds: plan.unchangedIds,
        blockerCount: plan.blockers.length,
        blockers: plan.blockers,
        blockedNodeIds: [...new Set(plan.blockers.map((blocker) => blocker.sourceId))],
        unresolvedDependencyIds: [...new Set(plan.blockers.map((blocker) => blocker.dependsOnId))],
      },
    });
  }

  #applyStatusCascadePlan(plan: StatusCascadePlan): void {
    for (const change of plan.orderedChanges) {
      if (change.kind === "epic") {
        const epic = this.#domain.updateEpic(change.id, { status: change.nextStatus });
        this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.updated, {
          title: epic.title,
          description: epic.description,
          status: epic.status,
        });
        continue;
      }

      if (change.kind === "task") {
        const task = this.#domain.updateTask(change.id, { status: change.nextStatus });
        this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.updated, {
          epic_id: task.epicId,
          title: task.title,
          description: task.description,
          status: task.status,
          owner: task.owner,
        });
        continue;
      }

      const subtask = this.#domain.updateSubtask(change.id, { status: change.nextStatus });
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
        owner: subtask.owner,
      });
    }
  }

  #applyScopeReplacement(
    nodes: readonly SearchNode[],
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    const result = this.#buildScopeReplacementResult(nodes, searchText, replacementText, fields, "apply");

    this.#writeTransaction((): void => {
      for (const node of nodes) {
        const nextTitle = fields.includes("title") ? replaceMatches(node.title, searchText, replacementText) : node.title;
        const nextDescription = fields.includes("description")
          ? replaceMatches(node.description, searchText, replacementText)
          : node.description;

        if (nextTitle === node.title && nextDescription === node.description) {
          continue;
        }

        if (node.kind === "epic") {
          const epic = this.#domain.updateEpic(node.id, { title: nextTitle, description: nextDescription });
          this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.updated, {
            title: epic.title,
            description: epic.description,
            status: epic.status,
          });
          continue;
        }

        if (node.kind === "task") {
          const task = this.#domain.updateTask(node.id, { title: nextTitle, description: nextDescription });
          this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.updated, {
            epic_id: task.epicId,
            title: task.title,
            description: task.description,
            status: task.status,
            owner: task.owner,
          });
          continue;
        }

        const subtask = this.#domain.updateSubtask(node.id, { title: nextTitle, description: nextDescription });
        this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
          task_id: subtask.taskId,
          title: subtask.title,
          description: subtask.description,
          status: subtask.status,
          owner: subtask.owner,
        });
      }
    });

    return result;
  }

  #buildScopeReplacementResult(
    nodes: readonly SearchNode[],
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
    mode: "preview" | "apply" = "preview",
  ): ScopeReplacementResult {
    const matches: SearchEntityMatch[] = [];

    for (const node of nodes) {
      const fieldMatches = fields
        .map((field) => {
          const value = field === "title" ? node.title : node.description;
          const matchIndex = value.indexOf(searchText);
          const nextValue = replaceMatches(value, searchText, replacementText);
          const count = nextValue === value ? 0 : countMatches(value, searchText);

          if (count === 0) {
            return null;
          }

          return {
            field,
            count,
            snippet:
              mode === "apply"
                ? buildReplacementSnippet(nextValue, matchIndex, replacementText.length)
                : buildMatchSnippet(value, searchText),
          };
        })
        .filter((fieldMatch) => fieldMatch !== null);

      if (fieldMatches.length === 0) {
        continue;
      }

      matches.push({
        kind: node.kind,
        id: node.id,
        fields: fieldMatches,
      });
    }

    return {
      matches,
      summary: summarizeMatches(matches),
    };
  }
}
