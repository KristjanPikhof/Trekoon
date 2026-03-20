import { type Database } from "bun:sqlite";

import { writeTransaction } from "../storage/database";
import { appendEventWithGitContext } from "../sync/event-writes";
import { ENTITY_OPERATIONS } from "./mutation-operations";
import { TrackerDomain } from "./tracker-domain";
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

  createEpic(input: { title: string; description: string; status?: string | undefined }): EpicRecord {
    return this.#db.transaction((): EpicRecord => {
      const epic = this.#domain.createEpic(input);
      this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.created, {
        title: epic.title,
        description: epic.description,
        status: epic.status,
      });
      return epic;
    })();
  }

  createEpicGraph(input: {
    title: string;
    description: string;
    status?: string | undefined;
    taskSpecs: readonly CompactTaskSpec[];
    subtaskSpecs: readonly CompactSubtaskSpec[];
    dependencySpecs: readonly CompactDependencySpec[];
  }): CompactEpicCreateResult {
    return this.#db.transaction((): CompactEpicCreateResult => {
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
        this.#appendEntityEvent("dependency", dependency.id, ENTITY_OPERATIONS.dependency.added, {
          source_id: dependency.sourceId,
          source_kind: dependency.sourceKind,
          depends_on_id: dependency.dependsOnId,
          depends_on_kind: dependency.dependsOnKind,
        });
      }

      return {
        epic,
        tasks: created.tasks,
        subtasks: created.subtasks,
        dependencies: created.dependencies,
        result: created.result,
      };
    })();
  }

  updateEpic(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): EpicRecord {
    return this.#db.transaction((): EpicRecord => {
      const epic = this.#domain.updateEpic(id, input);
      this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.updated, {
        title: epic.title,
        description: epic.description,
        status: epic.status,
      });
      return epic;
    })();
  }

  updateEpicStatusCascade(id: string, status: string): StatusCascadePlan {
    return this.#db.transaction((): StatusCascadePlan => {
      const plan = this.#domain.planStatusCascade("epic", id, status);
      this.#assertCascadeNotBlocked(plan);
      this.#applyStatusCascadePlan(plan);
      return plan;
    })();
  }

  deleteEpic(id: string): void {
    this.#db.transaction((): void => {
      this.#domain.deleteEpic(id);
      this.#appendEntityEvent("epic", id, ENTITY_OPERATIONS.epic.deleted, {});
    })();
  }

  createTask(input: { epicId: string; title: string; description: string; status?: string | undefined }): TaskRecord {
    return this.#db.transaction((): TaskRecord => {
      const task = this.#domain.createTask(input);
      this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.created, {
        epic_id: task.epicId,
        title: task.title,
        description: task.description,
        status: task.status,
      });
      return task;
    })();
  }

  createTaskBatch(input: { epicId: string; specs: readonly CompactTaskSpec[] }): CompactTaskBatchCreateResult {
    return this.#db.transaction((): CompactTaskBatchCreateResult => {
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
    })();
  }

  expandEpic(input: {
    epicId: string;
    taskSpecs: readonly CompactTaskSpec[];
    subtaskSpecs: readonly CompactSubtaskSpec[];
    dependencySpecs: readonly CompactDependencySpec[];
  }): CompactEpicExpandResult {
    return this.#db.transaction((): CompactEpicExpandResult => {
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
        this.#appendEntityEvent("dependency", dependency.id, ENTITY_OPERATIONS.dependency.added, {
          source_id: dependency.sourceId,
          source_kind: dependency.sourceKind,
          depends_on_id: dependency.dependsOnId,
          depends_on_kind: dependency.dependsOnKind,
        });
      }

      return created;
    })();
  }

  updateTask(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): TaskRecord {
    return this.#db.transaction((): TaskRecord => {
      const task = this.#domain.updateTask(id, input);
      this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.updated, {
        epic_id: task.epicId,
        title: task.title,
        description: task.description,
        status: task.status,
      });
      return task;
    })();
  }

  updateTaskStatusCascade(id: string, status: string): StatusCascadePlan {
    return this.#db.transaction((): StatusCascadePlan => {
      const plan = this.#domain.planStatusCascade("task", id, status);
      this.#assertCascadeNotBlocked(plan);
      this.#applyStatusCascadePlan(plan);
      return plan;
    })();
  }

  deleteTask(id: string): void {
    this.#db.transaction((): void => {
      this.#domain.deleteTask(id);
      this.#appendEntityEvent("task", id, ENTITY_OPERATIONS.task.deleted, {});
    })();
  }

  createSubtask(input: {
    taskId: string;
    title: string;
    description?: string | undefined;
    status?: string | undefined;
  }): SubtaskRecord {
    return this.#db.transaction((): SubtaskRecord => {
      const subtask = this.#domain.createSubtask(input);
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
      });
      return subtask;
    })();
  }

  createSubtaskBatch(input: { taskId: string; specs: readonly CompactSubtaskSpec[] }): CompactSubtaskBatchCreateResult {
    return this.#db.transaction((): CompactSubtaskBatchCreateResult => {
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
    })();
  }

  updateSubtask(
    id: string,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): SubtaskRecord {
    return this.#db.transaction((): SubtaskRecord => {
      const subtask = this.#domain.updateSubtask(id, input);
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
      });
      return subtask;
    })();
  }

  deleteSubtask(id: string): void {
    this.#db.transaction((): void => {
      this.#domain.deleteSubtask(id);
      this.#appendEntityEvent("subtask", id, ENTITY_OPERATIONS.subtask.deleted, {});
    })();
  }

  addDependency(sourceId: string, dependsOnId: string): DependencyRecord {
    return this.#db.transaction((): DependencyRecord => {
      const dependency = this.#domain.addDependency(sourceId, dependsOnId);
      this.#appendEntityEvent("dependency", dependency.id, ENTITY_OPERATIONS.dependency.added, {
        source_id: dependency.sourceId,
        source_kind: dependency.sourceKind,
        depends_on_id: dependency.dependsOnId,
        depends_on_kind: dependency.dependsOnKind,
      });
      return dependency;
    })();
  }

  addDependencyBatch(input: { specs: readonly CompactDependencySpec[] }): CompactDependencyBatchAddResult {
    return this.#db.transaction((): CompactDependencyBatchAddResult => {
      const created = this.#domain.addDependencyBatch(input);
      for (const dependency of created.dependencies) {
        this.#appendEntityEvent("dependency", dependency.id, ENTITY_OPERATIONS.dependency.added, {
          source_id: dependency.sourceId,
          source_kind: dependency.sourceKind,
          depends_on_id: dependency.dependsOnId,
          depends_on_kind: dependency.dependsOnKind,
        });
      }
      return created;
    })();
  }

  removeDependency(sourceId: string, dependsOnId: string): number {
    return this.#db.transaction((): number => {
      const removed = this.#domain.removeDependency(sourceId, dependsOnId);
      if (removed > 0) {
        this.#appendEntityEvent("dependency", `${sourceId}->${dependsOnId}`, ENTITY_OPERATIONS.dependency.removed, {
          source_id: sourceId,
          depends_on_id: dependsOnId,
        });
      }
      return removed;
    })();
  }

  describeError(error: unknown): string | undefined {
    if (!(error instanceof DomainError) || error.code !== "dependency_blocked") {
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
  ): void {
    appendEventWithGitContext(this.#db, this.#cwd, {
      entityKind,
      entityId,
      operation,
      fields,
    });
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
        });
        continue;
      }

      const subtask = this.#domain.updateSubtask(change.id, { status: change.nextStatus });
      this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
        task_id: subtask.taskId,
        title: subtask.title,
        description: subtask.description,
        status: subtask.status,
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

    this.#db.transaction((): void => {
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
          });
          continue;
        }

        const subtask = this.#domain.updateSubtask(node.id, { title: nextTitle, description: nextDescription });
        this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
          task_id: subtask.taskId,
          title: subtask.title,
          description: subtask.description,
          status: subtask.status,
        });
      }
    })();

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
