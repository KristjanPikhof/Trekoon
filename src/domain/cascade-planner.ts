import { Database } from "bun:sqlite";

import { DEPENDENCY_GATED_STATUSES } from "./dependency-rules";
import {
  type DependencyNodeKind,
  type DependencyRecord,
  DomainError,
  type EpicTreeDetailed,
  type StatusCascadeBlocker,
  type StatusCascadeChange,
  type StatusCascadePlan,
  type StatusCascadeRootKind,
  type StatusCascadeScopeNode,
  type TaskTreeDetailed,
} from "./types";

const CASCADE_BLOCKER_SQLITE_MAX_VARIABLES = 999;

/**
 * Row shape returned by {@link CascadePlannerReader.loadDependencyTargetStatuses}.
 *
 * Mirrors the columns produced by the chunked
 * `dependencies LEFT JOIN tasks LEFT JOIN subtasks` query that previously
 * lived inline inside `tracker-domain.ts`.  The reader implementation is
 * responsible for ordering rows by `(created_at ASC, id ASC)` so blocker
 * sequencing remains stable across chunked fetches.
 */
export interface CascadeDependencyTargetStatusRow {
  readonly sourceId: string;
  readonly sourceKind: DependencyNodeKind;
  readonly dependsOnId: string;
  readonly dependsOnKind: DependencyNodeKind;
  /** `null` when the referenced node has been deleted (orphaned edge). */
  readonly dependsOnStatus: string | null;
}

/**
 * Read-only domain projection consumed by the cascade planner.
 *
 * The planner is pure: every database read is funnelled through this
 * interface.  The `tracker-domain.ts` adapter supplies the concrete
 * implementation that calls back into existing domain methods / SQL.
 */
export interface CascadePlannerReader {
  buildEpicTreeDetailed(epicId: string): EpicTreeDetailed;
  buildTaskTreeDetailed(taskId: string): TaskTreeDetailed;
  listDependenciesBySourceIds(sourceIds: readonly string[]): Map<string, readonly DependencyRecord[]>;
  loadDependencyTargetStatuses(sourceIds: readonly string[]): readonly CascadeDependencyTargetStatusRow[];
}

function assertNonEmpty(field: string, value: string | undefined | null): string {
  const normalized: string = (value ?? "").trim();
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
 * Pure cascade planner.  Given a reader projection of the domain and a
 * cascade root + target status, computes the deterministic plan that
 * `MutationService` consumes.
 *
 * Behaviour MUST remain byte-identical to the previous in-line
 * implementation: scope ordering, change ordering (topological for the
 * `done` target), blocker filtering, and counts feed directly into
 * cascade event payloads.
 */
export function planStatusCascade(
  reader: CascadePlannerReader,
  rootKind: StatusCascadeRootKind,
  rootId: string,
  targetStatus: string,
): StatusCascadePlan {
  const normalizedTargetStatus = assertNonEmpty("status", targetStatus);
  const scope = collectStatusCascadeScope(reader, rootKind, rootId);
  const scopeIdSet = new Set(scope.map((node) => node.id));
  const orderedChanges = orderStatusCascadeChanges(reader, scope, normalizedTargetStatus);
  const changedIds = orderedChanges.map((change) => change.id);
  const changedIdSet = new Set(changedIds);
  const unchangedIds = scope
    .filter((node) => !changedIdSet.has(node.id))
    .map((node) => node.id);
  const blockers = collectStatusCascadeBlockers(
    reader,
    orderedChanges,
    scopeIdSet,
    changedIdSet,
    normalizedTargetStatus,
  );

  return {
    rootKind,
    rootId,
    targetStatus: normalizedTargetStatus,
    atomic: true,
    scope,
    orderedChanges,
    changedIds,
    unchangedIds,
    blockers,
    counts: {
      scope: scope.length,
      changed: orderedChanges.length,
      unchanged: unchangedIds.length,
      blockers: blockers.length,
      changedEpics: orderedChanges.filter((change) => change.kind === "epic").length,
      changedTasks: orderedChanges.filter((change) => change.kind === "task").length,
      changedSubtasks: orderedChanges.filter((change) => change.kind === "subtask").length,
    },
  };
}

export function collectStatusCascadeScope(
  reader: CascadePlannerReader,
  rootKind: StatusCascadeRootKind,
  rootId: string,
): StatusCascadeScopeNode[] {
  if (rootKind === "task") {
    const tree = reader.buildTaskTreeDetailed(rootId);
    return [
      {
        kind: "task",
        id: tree.id,
        parentId: tree.epicId,
        status: tree.status,
      },
      ...tree.subtasks.map((subtask) => ({
        kind: "subtask" as const,
        id: subtask.id,
        parentId: subtask.taskId,
        status: subtask.status,
      })),
    ];
  }

  const tree = reader.buildEpicTreeDetailed(rootId);
  return [
    {
      kind: "epic",
      id: tree.id,
      status: tree.status,
    },
    ...tree.tasks.flatMap((task) => [
      {
        kind: "task" as const,
        id: task.id,
        parentId: task.epicId,
        status: task.status,
      },
      ...task.subtasks.map((subtask) => ({
        kind: "subtask" as const,
        id: subtask.id,
        parentId: subtask.taskId,
        status: subtask.status,
      })),
    ]),
  ];
}

export function orderStatusCascadeChanges(
  reader: CascadePlannerReader,
  scope: readonly StatusCascadeScopeNode[],
  targetStatus: string,
): StatusCascadeChange[] {
  const changes = scope
    .filter((node) => node.status !== targetStatus)
    .map((node) => {
      const change: StatusCascadeChange = {
        kind: node.kind,
        id: node.id,
        previousStatus: node.status,
        nextStatus: targetStatus,
        ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
      };
      return change;
    });

  if (targetStatus !== "done") {
    return changes;
  }

  return topologicallyOrderDoneCascadeChanges(reader, changes);
}

export function topologicallyOrderDoneCascadeChanges(
  reader: CascadePlannerReader,
  changes: readonly StatusCascadeChange[],
): StatusCascadeChange[] {
  const indexById = new Map<string, number>();
  const changeById = new Map<string, StatusCascadeChange>();
  const dependencyTargetsBySource = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  const dependencyMap = reader.listDependenciesBySourceIds(
    changes.filter((change) => change.kind === "task" || change.kind === "subtask").map((change) => change.id),
  );

  changes.forEach((change, index) => {
    indexById.set(change.id, index);
    changeById.set(change.id, change);
    indegree.set(change.id, 0);

    if (change.kind !== "task" && change.kind !== "subtask") {
      return;
    }

    const dependencyTargets = new Set((dependencyMap.get(change.id) ?? []).map((dependency) => dependency.dependsOnId));
    dependencyTargetsBySource.set(change.id, dependencyTargets);
  });

  const addEdge = (fromId: string, toId: string): void => {
    if (fromId === toId || !changeById.has(fromId) || !changeById.has(toId)) {
      return;
    }

    const neighbors = dependents.get(fromId) ?? new Set<string>();
    if (neighbors.has(toId)) {
      return;
    }

    neighbors.add(toId);
    dependents.set(fromId, neighbors);
    indegree.set(toId, (indegree.get(toId) ?? 0) + 1);
  };

  for (const change of changes) {
    const dependencyTargets = dependencyTargetsBySource.get(change.id);

    if (change.kind === "subtask" && change.parentId !== undefined && !dependencyTargets?.has(change.parentId)) {
      addEdge(change.id, change.parentId);
    }

    if (change.kind === "task" && change.parentId !== undefined && !dependencyTargets?.has(change.parentId)) {
      addEdge(change.id, change.parentId);
    }

    if (change.kind !== "task" && change.kind !== "subtask") {
      continue;
    }

    for (const dependencyTargetId of dependencyTargets ?? []) {
      addEdge(dependencyTargetId, change.id);
    }
  }

  const ordered: StatusCascadeChange[] = [];
  const ready = changes
    .filter((change) => (indegree.get(change.id) ?? 0) === 0)
    .sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0));

  // Kahn-style topo sort. We re-sort `ready` after every push so the
  // iteration is deterministic on the original change index, but that
  // turns the loop into O(n^2 log n) in the worst case (System Hardening
  // 0.4.2, finding 34). Cascades currently fan out to at most a few dozen
  // entities so this is a non-issue in practice; keep the simple
  // array-based queue for readability.
  // TODO(perf): swap `ready` for a min-heap keyed on `indexById` if a
  // future benchmark shows cascades on large epics (>1k changes) hot in
  // a profile.
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) {
      continue;
    }

    ordered.push(next);
    for (const dependentId of dependents.get(next.id) ?? []) {
      const remaining = (indegree.get(dependentId) ?? 0) - 1;
      indegree.set(dependentId, remaining);
      if (remaining !== 0) {
        continue;
      }

      const dependent = changeById.get(dependentId);
      if (dependent === undefined) {
        continue;
      }

      ready.push(dependent);
      ready.sort((left, right) => (indexById.get(left.id) ?? 0) - (indexById.get(right.id) ?? 0));
    }
  }

  if (ordered.length !== changes.length) {
    throw new DomainError({
      code: "invalid_dependency",
      message: "unable to determine dependency-safe cascade order",
      details: {
        changedIds: changes.map((change) => change.id),
      },
    });
  }

  return ordered;
}

export function collectStatusCascadeBlockers(
  reader: CascadePlannerReader,
  changes: readonly StatusCascadeChange[],
  scopeIdSet: ReadonlySet<string>,
  changedIdSet: ReadonlySet<string>,
  targetStatus: string,
): StatusCascadeBlocker[] {
  if (!DEPENDENCY_GATED_STATUSES.has(targetStatus)) {
    return [];
  }

  // Collect all dependency-eligible change IDs upfront.
  const eligibleIds: string[] = [];
  for (const change of changes) {
    if (change.kind === "task" || change.kind === "subtask") {
      eligibleIds.push(change.id);
    }
  }

  if (eligibleIds.length === 0) {
    return [];
  }

  const rows = reader.loadDependencyTargetStatuses(eligibleIds);
  const blockers: StatusCascadeBlocker[] = [];

  for (const row of rows) {
    // Skip orphaned dependency rows where the referenced node no longer exists.
    if (row.dependsOnStatus === null) {
      continue;
    }

    const inScope = scopeIdSet.has(row.dependsOnId);
    const willCascade = targetStatus === "done" && changedIdSet.has(row.dependsOnId);
    if (row.dependsOnStatus === "done" || willCascade) {
      continue;
    }

    blockers.push({
      sourceId: row.sourceId,
      sourceKind: row.sourceKind,
      dependsOnId: row.dependsOnId,
      dependsOnKind: row.dependsOnKind,
      dependsOnStatus: row.dependsOnStatus,
      inScope,
      willCascade,
    });
  }

  return blockers.sort(
    (left, right) =>
      left.sourceId.localeCompare(right.sourceId) ||
      left.dependsOnId.localeCompare(right.dependsOnId) ||
      left.dependsOnKind.localeCompare(right.dependsOnKind),
  );
}

/**
 * Default SQL implementation of {@link CascadePlannerReader.loadDependencyTargetStatuses}.
 *
 * Issues chunked `WHERE source_id IN (...)` joins so the `?` parameter count
 * never exceeds SQLite's binding cap, preserving the deterministic
 * `(created_at ASC, id ASC)` row order the blocker pass relies on.
 */
export function loadCascadeDependencyTargetStatuses(
  db: Database,
  sourceIds: readonly string[],
): readonly CascadeDependencyTargetStatusRow[] {
  if (sourceIds.length === 0) {
    return [];
  }

  type DepStatusRow = {
    source_id: string;
    source_kind: DependencyNodeKind;
    depends_on_id: string;
    depends_on_kind: DependencyNodeKind;
    dep_status: string | null;
  };

  const collected: CascadeDependencyTargetStatusRow[] = [];

  for (let offset = 0; offset < sourceIds.length; offset += CASCADE_BLOCKER_SQLITE_MAX_VARIABLES) {
    const chunkIds = sourceIds.slice(offset, offset + CASCADE_BLOCKER_SQLITE_MAX_VARIABLES);
    const inPlaceholders: string = chunkIds.map(() => "?").join(", ");
    const rows = db
      .query(
        `SELECT d.source_id, d.source_kind, d.depends_on_id, d.depends_on_kind,
                COALESCE(t.status, s.status) AS dep_status
         FROM dependencies d
         LEFT JOIN tasks t ON d.depends_on_kind = 'task' AND d.depends_on_id = t.id
         LEFT JOIN subtasks s ON d.depends_on_kind = 'subtask' AND d.depends_on_id = s.id
         WHERE d.source_id IN (${inPlaceholders})
         ORDER BY d.created_at ASC, d.id ASC;`,
      )
      .all(...chunkIds) as DepStatusRow[];

    for (const row of rows) {
      collected.push({
        sourceId: row.source_id,
        sourceKind: row.source_kind,
        dependsOnId: row.depends_on_id,
        dependsOnKind: row.depends_on_kind,
        dependsOnStatus: row.dep_status,
      });
    }
  }

  return collected;
}
