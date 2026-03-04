import { type Database } from "bun:sqlite";

import { appendEventWithGitContext } from "../sync/event-writes";
import { ENTITY_OPERATIONS } from "./mutation-operations";
import { TrackerDomain } from "./tracker-domain";
import { type DependencyRecord, type EpicRecord, type SubtaskRecord, type TaskRecord } from "./types";

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
}
