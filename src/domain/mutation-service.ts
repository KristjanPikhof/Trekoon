import { type Database } from "bun:sqlite";

import { writeTransaction } from "../storage/database";
import { appendEventWithGitContext, withTransactionEventContext } from "../sync/event-writes";
import { resolveGitContext } from "../sync/git-context";
import { ENTITY_OPERATIONS } from "./mutation-operations";
import {
  buildMatchSnippet,
  buildReplacementSnippet,
  countMatches,
  replaceMatches,
  summarizeMatches,
} from "./search";
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

/**
 * Local mirror of `assertNonEmpty` from tracker-domain (which is
 * file-local). Used by the *WithIfMatch CAS variants which build their
 * UPDATE row directly rather than going through `domain.updateX`, so they
 * must enforce the same non-empty-string contract on caller-provided
 * fields.
 */
function assertNonEmptyField(field: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new DomainError({
      code: "invalid_input",
      message: `${field} must be a non-empty string`,
      details: { field },
    });
  }
  return normalized;
}

/**
 * Local mirror of `normalizeOwner` from tracker-domain. `undefined`
 * preserves the existing owner; `null` or blank-after-trim clears it;
 * any other string is trimmed and stored.
 */
function normalizeOwnerInput(owner: string | null | undefined): string | null | undefined {
  if (owner === undefined) {
    return undefined;
  }
  if (owner === null) {
    return null;
  }
  const trimmed = owner.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const assertEpicFieldNonEmpty = assertNonEmptyField;
const assertTaskFieldNonEmpty = assertNonEmptyField;
const assertSubtaskFieldNonEmpty = assertNonEmptyField;

/**
 * Thrown by the *WithIfMatch CAS variants when the supplied `If-Match`
 * `updatedAt` does not match the row currently in the database.
 *
 * The error is **not** a `DomainError` so the generic `toBoardRouteError`
 * fall-through doesn't accidentally surface it as a 400 — route handlers
 * catch it explicitly and emit the canonical 409 `precondition_failed`
 * payload (with `currentUpdatedAt` fetched inside the same transaction
 * that observed the mismatch).
 */
export class PreconditionFailedError extends Error {
  readonly entityKind: "epic" | "task" | "subtask";
  readonly entityId: string;
  readonly currentUpdatedAt: number;
  readonly providedUpdatedAt: number;

  constructor(input: {
    entityKind: "epic" | "task" | "subtask";
    entityId: string;
    currentUpdatedAt: number;
    providedUpdatedAt: number;
  }) {
    super("If-Match version does not match current updatedAt");
    this.name = "PreconditionFailedError";
    this.entityKind = input.entityKind;
    this.entityId = input.entityId;
    this.currentUpdatedAt = input.currentUpdatedAt;
    this.providedUpdatedAt = input.providedUpdatedAt;
  }
}

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
    // Resolve git context BEFORE acquiring the SQLite write lock. Cold-cache
    // resolution spawns `git branch` / `git rev-parse` subprocesses; doing
    // that inside BEGIN IMMEDIATE would serialize concurrent writers behind
    // git invocations rather than just the lock-promotion itself.
    //
    // withTransactionEventContext still computes the event timestamp lazily
    // AFTER BEGIN IMMEDIATE is issued by writeTransaction so concurrent
    // writers cannot collide on (created_at, id).
    const git = resolveGitContext(this.#cwd);
    return writeTransaction(this.#db, (): T => withTransactionEventContext(this.#db, git, fn));
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
      this.#emitEpicCreated(epic);
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

      this.#emitEpicCreated(epic);

      for (const task of created.tasks) {
        this.#emitTaskCreated(task);
      }

      for (const subtask of created.subtasks) {
        this.#emitSubtaskCreated(subtask);
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
      this.#emitEpicUpdated(epic);
      return epic;
    });
  }

  /**
   * Atomic If-Match CAS variant of {@link updateEpic}.
   *
   * The `If-Match` precondition is enforced INSIDE the write transaction
   * via a SQL compare-and-swap (`UPDATE ... WHERE id = ? AND updated_at = ?`).
   * If zero rows are affected we determine whether the row is missing
   * (→ `DomainError(not_found)`) or merely stale (→ {@link PreconditionFailedError}
   * with the freshly-fetched `currentUpdatedAt`).
   *
   * This eliminates the read-check-then-write race the previous route-level
   * check had: a concurrent writer could land between `parseIfMatchHeader`'s
   * read and `mutations.updateEpic`'s BEGIN IMMEDIATE, allowing the second
   * PATCH to silently overwrite the first.
   *
   * Input validation (non-empty / status transition) mirrors
   * `domain.updateEpic` — it runs inside the same transaction so a
   * malformed PATCH never observes the CAS branch.
   */
  updateEpicWithIfMatch(
    id: string,
    ifMatchUpdatedAt: number,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined },
  ): EpicRecord {
    return this.#writeTransaction((): EpicRecord => {
      // Resolve the current row first inside the tx so we can (1) surface
      // `not_found` before the CAS and (2) materialise the per-field
      // defaults that domain.updateEpic computes from the current row.
      // Holding the BEGIN IMMEDIATE write lock guarantees no other writer
      // mutates the row between this read and the CAS UPDATE.
      const existing = this.#domain.getEpicOrThrow(id);

      const nextTitle = input.title !== undefined
        ? assertEpicFieldNonEmpty("title", input.title)
        : existing.title;
      const nextDescription = input.description !== undefined
        ? assertEpicFieldNonEmpty("description", input.description)
        : existing.description;
      const nextStatus = input.status !== undefined
        ? assertEpicFieldNonEmpty("status", input.status)
        : existing.status;

      if (input.status !== undefined) {
        validateStatusTransition(existing.status, nextStatus, "epic", id);
      }

      const now: number = Date.now();
      const result = this.#db
        .query(
          `UPDATE epics
              SET title = ?, description = ?, status = ?, updated_at = ?, version = version + 1
            WHERE id = ?
              AND updated_at = ?
           RETURNING id`,
        )
        .get(nextTitle, nextDescription, nextStatus, now, id, ifMatchUpdatedAt) as { id: string } | null;

      if (result === null) {
        // Zero rows changed. We already proved the row exists via
        // getEpicOrThrow, so the only remaining failure mode is a stale
        // precondition. Re-fetch updatedAt inside the same tx so the
        // caller's 409 carries the freshest value.
        const current = this.#domain.getEpicOrThrow(id);
        throw new PreconditionFailedError({
          entityKind: "epic",
          entityId: id,
          currentUpdatedAt: current.updatedAt,
          providedUpdatedAt: ifMatchUpdatedAt,
        });
      }

      const epic = this.#domain.getEpicOrThrow(id);
      this.#emitEpicUpdated(epic);
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
      const tasks = this.#domain.listTasks(id);
      const taskIds = tasks.map((task) => task.id);
      const subtasksByTaskId = taskIds.length > 0
        ? this.#domain.listSubtasksByTaskIds(taskIds)
        : new Map<string, readonly SubtaskRecord[]>();

      this.#domain.deleteEpic(id);

      const epicDeleteEventId = this.#emitEpicDeleted(id);

      for (const task of tasks) {
        // Stamp cascaded task.deleted events with the parent epic-delete event
        // id so peer worktrees can suppress the per-task __delete__ conflict
        // when an epic-level conflict is already pending. Without this, a peer
        // with edits on the epic's tasks gets N+1 conflicts (epic + one per
        // task) instead of the single epic-level conflict.
        const taskDeleteEventId = this.#emitTaskDeleted(task.id, { sourceEventId: epicDeleteEventId });
        const subtasks = subtasksByTaskId.get(task.id) ?? [];
        for (const subtask of subtasks) {
          this.#emitSubtaskDeleted(subtask.id, { taskId: task.id, sourceEventId: taskDeleteEventId });
        }
      }
    });
  }

  createTask(input: { epicId: string; title: string; description: string; status?: string | undefined }): TaskRecord {
    return this.#writeTransaction((): TaskRecord => {
      const task = this.#domain.createTask(input);
      this.#emitTaskCreated(task);
      return task;
    });
  }

  createTaskBatch(input: { epicId: string; specs: readonly CompactTaskSpec[] }): CompactTaskBatchCreateResult {
    return this.#writeTransaction((): CompactTaskBatchCreateResult => {
      const created = this.#domain.createTaskBatch(input);
      for (const task of created.tasks) {
        this.#emitTaskCreated(task);
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
        this.#emitTaskCreated(task);
      }

      for (const subtask of created.subtasks) {
        this.#emitSubtaskCreated(subtask);
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
      this.#emitTaskUpdated(task);
      return task;
    });
  }

  /**
   * Atomic If-Match CAS variant of {@link updateTask}.  See
   * {@link updateEpicWithIfMatch} for the rationale; the key difference is
   * that tasks also enforce dependency-gating via
   * `assertNoUnresolvedDependenciesForStatusTransition` for status
   * transitions and may set/clear `owner`.
   */
  updateTaskWithIfMatch(
    id: string,
    ifMatchUpdatedAt: number,
    input: { title?: string | undefined; description?: string | undefined; status?: string | undefined; owner?: string | null | undefined },
  ): TaskRecord {
    return this.#writeTransaction((): TaskRecord => {
      const existing = this.#domain.getTaskOrThrow(id);

      const nextTitle = input.title !== undefined
        ? assertTaskFieldNonEmpty("title", input.title)
        : existing.title;
      const nextDescription = input.description !== undefined
        ? assertTaskFieldNonEmpty("description", input.description)
        : existing.description;
      const nextStatus = input.status !== undefined
        ? assertTaskFieldNonEmpty("status", input.status)
        : existing.status;
      const normalizedOwner = normalizeOwnerInput(input.owner);
      const nextOwner = normalizedOwner === undefined ? existing.owner : normalizedOwner;

      if (input.status !== undefined) {
        validateStatusTransition(existing.status, nextStatus, "task", id);
      }
      // Dependency gating mirrors domain.updateTask. Even when the status
      // is unchanged this is a no-op because
      // assertNoUnresolvedDependenciesForStatusTransition short-circuits
      // when from === to.
      this.#domain.assertNoUnresolvedDependenciesForStatusTransition(id, "task", existing.status, nextStatus);

      const now: number = Date.now();
      const result = this.#db
        .query(
          `UPDATE tasks
              SET title = ?, description = ?, status = ?, owner = ?, updated_at = ?, version = version + 1
            WHERE id = ?
              AND updated_at = ?
           RETURNING id`,
        )
        .get(nextTitle, nextDescription, nextStatus, nextOwner, now, id, ifMatchUpdatedAt) as { id: string } | null;

      if (result === null) {
        const current = this.#domain.getTaskOrThrow(id);
        throw new PreconditionFailedError({
          entityKind: "task",
          entityId: id,
          currentUpdatedAt: current.updatedAt,
          providedUpdatedAt: ifMatchUpdatedAt,
        });
      }

      const task = this.#domain.getTaskOrThrow(id);
      this.#emitTaskUpdated(task);
      return task;
    });
  }

  /**
   * Atomically append text to a task's description using a single SQL
   * `description = description || ?` expression inside a write transaction.
   *
   * This eliminates the read-modify-write TOCTOU race that existed when
   * callers read the description, computed the new value in application code,
   * then issued a separate update write.  Two concurrent appends targeting
   * the same task will each hold their own BEGIN IMMEDIATE lock in turn and
   * see the other's text already committed, so neither write is lost.
   *
   * The separator matches the `appendLine` helper used across the CLI:
   * an empty description gets the text directly, a non-empty description
   * gets a `\n` prefix on the appended text.
   *
   * Optional `status` is validated through the normal status-machine checker
   * and applied atomically in the same statement so combined
   * `--append --status` flows remain a single write.
   */
  appendToTaskDescription(input: {
    taskId: string;
    append: string;
    status?: string | undefined;
    owner?: string | null | undefined;
  }): TaskRecord {
    return this.#writeTransaction((): TaskRecord => {
      const existing = this.#domain.getTaskOrThrow(input.taskId);
      if (input.status !== undefined) {
        validateStatusTransition(existing.status, input.status, "task", input.taskId);
        // Enforce dependency gating BEFORE the direct UPDATE bypass below.
        // The combined append+status path issues its own SQL UPDATE rather
        // than going through `domain.updateTask`, so without this call a
        // blocked task with unresolved upstream deps could be flipped into
        // a gated status (in_progress/done) — defeating the
        // dependency_blocked contract. Symmetric with claimTask /
        // markTaskDoneAtomically gating sites.
        this.#domain.assertNoUnresolvedDependenciesForStatusTransition(
          input.taskId,
          "task",
          existing.status,
          input.status,
        );
      }
      const separator = existing.description.length > 0 ? "\n" : "";
      const now = Date.now();
      const nextStatus = input.status ?? existing.status;
      const nextOwner = input.owner !== undefined
        ? (input.owner ?? null)
        : existing.owner;
      this.#db
        .query(
          "UPDATE tasks SET description = description || ?, status = ?, owner = ?, updated_at = ?, version = version + 1 WHERE id = ?;",
        )
        .run(separator + input.append, nextStatus, nextOwner, now, input.taskId);
      const task = this.#domain.getTaskOrThrow(input.taskId);
      this.#emitTaskUpdated(task);
      return task;
    });
  }

  /**
   * Atomically append text to a subtask's description.
   * Same semantics as `appendToTaskDescription`.
   */
  appendToSubtaskDescription(input: {
    subtaskId: string;
    append: string;
    status?: string | undefined;
    owner?: string | null | undefined;
  }): SubtaskRecord {
    return this.#writeTransaction((): SubtaskRecord => {
      const existing = this.#domain.getSubtaskOrThrow(input.subtaskId);
      if (input.status !== undefined) {
        validateStatusTransition(existing.status, input.status, "subtask", input.subtaskId);
        // Mirror of appendToTaskDescription: gate the combined
        // append+status path through assertNoUnresolvedDependenciesForStatusTransition
        // so subtasks cannot bypass dependency resolution via the bypass UPDATE.
        this.#domain.assertNoUnresolvedDependenciesForStatusTransition(
          input.subtaskId,
          "subtask",
          existing.status,
          input.status,
        );
      }
      const separator = existing.description.length > 0 ? "\n" : "";
      const now = Date.now();
      const nextStatus = input.status ?? existing.status;
      const nextOwner = input.owner !== undefined
        ? (input.owner ?? null)
        : existing.owner;
      this.#db
        .query(
          "UPDATE subtasks SET description = description || ?, status = ?, owner = ?, updated_at = ?, version = version + 1 WHERE id = ?;",
        )
        .run(separator + input.append, nextStatus, nextOwner, now, input.subtaskId);
      const subtask = this.#domain.getSubtaskOrThrow(input.subtaskId);
      this.#emitSubtaskUpdated(subtask);
      return subtask;
    });
  }

  /**
   * Atomically append text to an epic's description.
   * Same semantics as `appendToTaskDescription`.
   */
  appendToEpicDescription(input: {
    epicId: string;
    append: string;
    status?: string | undefined;
  }): EpicRecord {
    return this.#writeTransaction((): EpicRecord => {
      const existing = this.#domain.getEpicOrThrow(input.epicId);
      if (input.status !== undefined) {
        validateStatusTransition(existing.status, input.status, "epic", input.epicId);
      }
      const separator = existing.description.length > 0 ? "\n" : "";
      const now = Date.now();
      const nextStatus = input.status ?? existing.status;
      this.#db
        .query(
          "UPDATE epics SET description = description || ?, status = ?, updated_at = ? WHERE id = ?;",
        )
        .run(separator + input.append, nextStatus, now, input.epicId);
      const epic = this.#domain.getEpicOrThrow(input.epicId);
      this.#emitEpicUpdated(epic);
      return epic;
    });
  }

  /**
   * Mark a task `done` atomically in a single write transaction.
   *
   * Background (Trekoon task 4a0111c4-6400-4a77-b4f3-d9ad863e47db / system
   * hardening): the legacy `task done` handler issued two separate
   * `updateTask` mutations whenever the task was in `todo` or `blocked`
   * (auto-stepping through `in_progress` to satisfy the public status-machine
   * checker). Each `updateTask` ran in its own `BEGIN IMMEDIATE` transaction,
   * so a crash, kill, or thrown exception between the two writes could leave
   * the task wedged in `in_progress` forever — even though the user had
   * asked to mark it done.
   *
   * This method consolidates the operation into one transaction and bypasses
   * `validateStatusTransition`. THIS IS THE ONE INTENTIONAL DIRECT-STATUS-WRITE
   * EXCEPTION in the codebase: every other status mutation MUST go through the
   * public transition checker. The bypass is safe here because the resulting
   * status (`done`) is a documented terminal target reachable from every
   * non-`done` status (`todo`, `blocked`, `in_progress`) in the status
   * machine. See docs/machine-contracts.md for the canonical exceptions list.
   *
   * Contract:
   *  - On success: task row is `done`; exactly one `task.updated` event is
   *    emitted (no intermediate `in_progress` event); pre-blocked reverse
   *    deps are captured inside the same transaction so the unblocked-array
   *    computed by the caller is consistent with the post-COMMIT snapshot.
   *  - On failure (throw): `ROLLBACK` restores the original status — task is
   *    NEVER observable in `in_progress` due to a partial done.
   *
   * The caller supplies `computeSnapshot` which runs inside the transaction
   * AFTER the row has been flipped to `done`. This is where the command
   * layer computes readiness / unblocked / next without leaking
   * `buildTaskReadiness` into the domain layer.
   */
  markTaskDoneAtomically<T>(input: {
    taskId: string;
    computeSnapshot: (params: {
      domain: TrackerDomain;
      completed: TaskRecord;
      preBlockedReverseDepIds: readonly string[];
    }) => T;
  }): T {
    return this.#writeTransaction((): T => {
      const existing = this.#domain.getTaskOrThrow(input.taskId);

      // Positive allowlist of acceptable source statuses for the atomic done
      // bypass. Any future terminal status (e.g. `cancelled`, `archived`) MUST
      // be explicitly added here before it can be auto-flipped to `done`;
      // otherwise it falls through to this guard and surfaces as
      // `already_done`. This is safer than the legacy
      // `existing.status === "done"` negative check, which silently accepted
      // any new terminal status as "still allowed to transition to done".
      if (existing.status !== "todo" && existing.status !== "blocked" && existing.status !== "in_progress") {
        throw new DomainError({
          code: "already_done",
          message: "Task is already done",
          details: { id: input.taskId },
        });
      }

      // Enforce dependency gating BEFORE the direct UPDATE bypass. The atomic
      // done flow skips `validateStatusTransition`, so without this call a
      // blocked task with unresolved upstream deps would be silently flipped
      // to `done` — defeating the dependency_blocked contract.
      this.#domain.assertNoUnresolvedDependenciesForStatusTransition(
        input.taskId,
        "task",
        existing.status,
        "done",
      );

      // Snapshot direct task-level reverse-dep blockers BEFORE the status
      // flip so the post-write snapshot can diff "newly-unblocked" tasks.
      const reverseDeps = this.#domain.listReverseDependencies(input.taskId);
      const directRevDepTaskIds = reverseDeps
        .filter((rd) => rd.isDirect && rd.kind === "task")
        .map((rd) => rd.id);
      const preDepStatuses = this.#domain.batchResolveDependencyStatuses(directRevDepTaskIds);
      const preBlockedReverseDepIds = directRevDepTaskIds.filter((id) => {
        const resolved = preDepStatuses.get(id);
        return resolved !== undefined && resolved.blockers.length > 0;
      });

      // Direct UPDATE bypassing validateStatusTransition. See method-doc
      // comment above for the rationale: this is the ONLY allowed direct
      // status write in the codebase; do not copy this pattern elsewhere.
      const now: number = Date.now();
      this.#db
        .query("UPDATE tasks SET status = ?, updated_at = ?, version = version + 1 WHERE id = ?;")
        .run("done", now, input.taskId);

      const completed = this.#domain.getTaskOrThrow(input.taskId);

      // Emit exactly one task.updated event. Payload shape matches the
      // canonical #emitTaskUpdated contract — sync consumers see a single
      // logical "task became done" transition, never a phantom intermediate
      // in_progress step.
      this.#emitTaskUpdated(completed);

      return input.computeSnapshot({
        domain: this.#domain,
        completed,
        preBlockedReverseDepIds,
      });
    });
  }

  /**
   * Atomically claim a task for an owner using a SQL compare-and-swap.
   *
   * The UPDATE predicate ensures:
   *   - Only `todo` or `blocked` tasks can be claimed (not `done` or
   *     already-in_progress tasks owned by someone else).
   *   - An owner can re-claim their own in-progress task (idempotent).
   *   - Exactly one caller gets `claimed: true` when two concurrent calls race.
   *
   * Returns `{ claimed, currentOwner, currentStatus }`.
   * When `claimed` is true the returned `task` is the post-update record.
   */
  claimTask(input: { taskId: string; owner: string }): {
    claimed: boolean;
    currentOwner: string | null;
    currentStatus: string;
    task?: TaskRecord;
  } {
    return this.#writeTransaction(() => {
      // Enforce dependency gating BEFORE the CAS so a blocked-by-unresolved-dep
      // task cannot be silently flipped into `in_progress`. Symmetric with
      // markTaskDoneAtomically: both "forward-progress" terminal/active
      // transitions go through the same gating call. A pre-existing in_progress
      // or done row is short-circuited because its existing status equals the
      // next status (or is non-gated terminal) and the gating helper returns
      // early.
      const existing = this.#domain.getTask(input.taskId);
      if (existing && (existing.status === "todo" || existing.status === "blocked")) {
        this.#domain.assertNoUnresolvedDependenciesForStatusTransition(
          input.taskId,
          "task",
          existing.status,
          "in_progress",
        );
      }

      const now = Date.now();
      const result = this.#db
        .query(
          `UPDATE tasks
              SET status = 'in_progress', owner = ?, updated_at = ?, version = version + 1
            WHERE id = ?
              AND status IN ('todo', 'blocked')
              AND (owner IS NULL OR owner = ?)
           RETURNING id`,
        )
        .get(input.owner, now, input.taskId, input.owner) as { id: string } | null;

      if (result !== null) {
        const task = this.#domain.getTaskOrThrow(input.taskId);
        this.#emitTaskUpdated(task);
        return {
          claimed: true,
          currentOwner: input.owner,
          currentStatus: "in_progress",
          task,
        };
      }

      // CAS failed — fetch current state for the caller
      const current = this.#domain.getTaskOrThrow(input.taskId);
      return {
        claimed: false,
        currentOwner: current.owner,
        currentStatus: current.status,
      };
    });
  }

  /**
   * Atomically claim a subtask for an owner using a SQL compare-and-swap.
   * Same semantics as `claimTask`.
   */
  claimSubtask(input: { subtaskId: string; owner: string }): {
    claimed: boolean;
    currentOwner: string | null;
    currentStatus: string;
    subtask?: SubtaskRecord;
  } {
    return this.#writeTransaction(() => {
      // Mirror of claimTask: gate the todo/blocked → in_progress transition
      // through assertNoUnresolvedDependenciesForStatusTransition so subtask
      // claims cannot bypass dependency resolution.
      const existing = this.#domain.getSubtask(input.subtaskId);
      if (existing && (existing.status === "todo" || existing.status === "blocked")) {
        this.#domain.assertNoUnresolvedDependenciesForStatusTransition(
          input.subtaskId,
          "subtask",
          existing.status,
          "in_progress",
        );
      }

      const now = Date.now();
      const result = this.#db
        .query(
          `UPDATE subtasks
              SET status = 'in_progress', owner = ?, updated_at = ?, version = version + 1
            WHERE id = ?
              AND status IN ('todo', 'blocked')
              AND (owner IS NULL OR owner = ?)
           RETURNING id`,
        )
        .get(input.owner, now, input.subtaskId, input.owner) as { id: string } | null;

      if (result !== null) {
        const subtask = this.#domain.getSubtaskOrThrow(input.subtaskId);
        this.#emitSubtaskUpdated(subtask);
        return {
          claimed: true,
          currentOwner: input.owner,
          currentStatus: "in_progress",
          subtask,
        };
      }

      const current = this.#domain.getSubtaskOrThrow(input.subtaskId);
      return {
        claimed: false,
        currentOwner: current.owner,
        currentStatus: current.status,
      };
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
      const taskDeleteEventId = this.#emitTaskDeleted(id);

      for (const subtaskId of plan.subtaskIds) {
        this.#emitSubtaskDeleted(subtaskId, { taskId: id, sourceEventId: taskDeleteEventId });
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
      this.#emitSubtaskCreated(subtask);
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
      this.#emitSubtaskCreated(subtask);
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
        this.#emitSubtaskCreated(subtask);
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
      this.#emitSubtaskUpdated(subtask);
      return subtask;
    });
  }

  deleteSubtask(id: string): { deletedDependencyIds: string[] } {
    return this.#writeTransaction((): { deletedDependencyIds: string[] } => {
      const touchingDependencies = this.#domain.listDependenciesTouchingNode(id);
      this.#domain.deleteSubtask(id);
      const subtaskDeleteEventId = this.#emitSubtaskDeleted(id);
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
      const subtaskDeleteEventId = this.#emitSubtaskDeleted(input.id);
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

  // -- Centralized event-emission helpers ------------------------------------
  // Each helper builds the payload for a single (entity, op) pair from the
  // entity record. Payload shapes here MUST match the historical inline
  // construction byte-for-byte: sync correctness depends on it.

  #emitEpicCreated(epic: EpicRecord): string {
    return this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.created, {
      title: epic.title,
      description: epic.description,
      status: epic.status,
    });
  }

  #emitEpicUpdated(epic: EpicRecord): string {
    return this.#appendEntityEvent("epic", epic.id, ENTITY_OPERATIONS.epic.updated, {
      title: epic.title,
      description: epic.description,
      status: epic.status,
    });
  }

  #emitEpicDeleted(epicId: string): string {
    return this.#appendEntityEvent("epic", epicId, ENTITY_OPERATIONS.epic.deleted, {});
  }

  #emitTaskCreated(task: TaskRecord): string {
    return this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.created, {
      epic_id: task.epicId,
      title: task.title,
      description: task.description,
      status: task.status,
    });
  }

  #emitTaskUpdated(task: TaskRecord): string {
    return this.#appendEntityEvent("task", task.id, ENTITY_OPERATIONS.task.updated, {
      epic_id: task.epicId,
      title: task.title,
      description: task.description,
      status: task.status,
      owner: task.owner,
    });
  }

  #emitTaskDeleted(
    taskId: string,
    cascade?: { sourceEventId: string } | undefined,
  ): string {
    const fields: Record<string, unknown> = cascade ? { source_event_id: cascade.sourceEventId } : {};
    return this.#appendEntityEvent("task", taskId, ENTITY_OPERATIONS.task.deleted, fields);
  }

  #emitSubtaskCreated(subtask: SubtaskRecord): string {
    return this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.created, {
      task_id: subtask.taskId,
      title: subtask.title,
      description: subtask.description,
      status: subtask.status,
    });
  }

  #emitSubtaskUpdated(subtask: SubtaskRecord): string {
    return this.#appendEntityEvent("subtask", subtask.id, ENTITY_OPERATIONS.subtask.updated, {
      task_id: subtask.taskId,
      title: subtask.title,
      description: subtask.description,
      status: subtask.status,
      owner: subtask.owner,
    });
  }

  #emitSubtaskDeleted(
    subtaskId: string,
    cascade?: { taskId: string; sourceEventId: string } | undefined,
  ): string {
    const fields: Record<string, unknown> = cascade
      ? { task_id: cascade.taskId, source_event_id: cascade.sourceEventId }
      : {};
    return this.#appendEntityEvent("subtask", subtaskId, ENTITY_OPERATIONS.subtask.deleted, fields);
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
        this.#emitEpicUpdated(epic);
        continue;
      }

      if (change.kind === "task") {
        const task = this.#domain.updateTask(change.id, { status: change.nextStatus });
        this.#emitTaskUpdated(task);
        continue;
      }

      const subtask = this.#domain.updateSubtask(change.id, { status: change.nextStatus });
      this.#emitSubtaskUpdated(subtask);
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
          this.#emitEpicUpdated(epic);
          continue;
        }

        if (node.kind === "task") {
          const task = this.#domain.updateTask(node.id, { title: nextTitle, description: nextDescription });
          this.#emitTaskUpdated(task);
          continue;
        }

        const subtask = this.#domain.updateSubtask(node.id, { title: nextTitle, description: nextDescription });
        this.#emitSubtaskUpdated(subtask);
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
