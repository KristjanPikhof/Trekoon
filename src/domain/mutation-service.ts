import { type Database } from "bun:sqlite";

import { appendEventWithGitContext } from "../sync/event-writes";
import { ENTITY_OPERATIONS } from "./mutation-operations";
import { TrackerDomain } from "./tracker-domain";
import {
  type DependencyRecord,
  type EpicRecord,
  type SearchEntityMatch,
  type SearchField,
  type SearchNode,
  type SearchSummary,
  type SubtaskRecord,
  type TaskRecord,
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

  #applyScopeReplacement(
    nodes: readonly SearchNode[],
    searchText: string,
    replacementText: string,
    fields: readonly SearchField[],
  ): ScopeReplacementResult {
    const result = this.#buildScopeReplacementResult(nodes, searchText, replacementText, fields);

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
  ): ScopeReplacementResult {
    const matches: SearchEntityMatch[] = [];

    for (const node of nodes) {
      const fieldMatches = fields
        .map((field) => {
          const value = field === "title" ? node.title : node.description;
          const nextValue = replaceMatches(value, searchText, replacementText);
          const count = nextValue === value ? 0 : countMatches(value, searchText);

          if (count === 0) {
            return null;
          }

          return {
            field,
            count,
            snippet: buildMatchSnippet(value, searchText),
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
