import {
  type CompactDependencySpec,
  type CompactEntityRef,
  type CompactSubtaskSpec,
  type DependencyRecord,
  DomainError,
  type SubtaskRecord,
  type TaskRecord,
} from "./types";

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

export interface ResolvedDependencyBatchSpec {
  readonly index: number;
  readonly sourceId: string;
  readonly sourceKind: "task" | "subtask";
  readonly dependsOnId: string;
  readonly dependsOnKind: "task" | "subtask";
}

export interface DependencyBatchValidationIssue {
  readonly index: number;
  readonly type: "missing_id" | "duplicate" | "cycle";
  readonly sourceId: string;
  readonly dependsOnId: string;
  readonly details: Record<string, unknown>;
}

export interface DependencyBatchResolution {
  readonly spec?: ResolvedDependencyBatchSpec;
  readonly issues: readonly DependencyBatchValidationIssue[];
}

export interface ResolvedCompactEntity {
  readonly id: string;
  readonly kind: "task" | "subtask";
}

// ---------------------------------------------------------------------------
// Reader interface — the only DB-touching surface the callers must supply
// ---------------------------------------------------------------------------

export interface BatchValidationReader {
  getTask(id: string): TaskRecord | null;
  getSubtask(id: string): SubtaskRecord | null;
  getDependencyByEdge(sourceId: string, dependsOnId: string): DependencyRecord | null;
  buildDependencyAdjacency(): Map<string, Set<string>>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertNonEmptyLocal(field: string, value: string | undefined | null): string {
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

function resolveNodeKindLocal(id: string, reader: BatchValidationReader): "task" | "subtask" {
  if (reader.getTask(id)) return "task";
  if (reader.getSubtask(id)) return "subtask";
  throw new DomainError({
    code: "not_found",
    message: `node not found: ${id}`,
    details: { id, expectedKinds: ["task", "subtask"] },
  });
}

function resolveDependencyBatchId(
  reference: CompactEntityRef,
  field: "source" | "dependsOn",
  index: number,
  reader: BatchValidationReader,
): { readonly id?: string; readonly issues: readonly DependencyBatchValidationIssue[] } {
  if (reference.kind === "temp_key") {
    return {
      issues: [
        {
          index,
          type: "missing_id",
          sourceId: field === "source" ? `@${reference.tempKey}` : "",
          dependsOnId: field === "dependsOn" ? `@${reference.tempKey}` : "",
          details: {
            field,
            tempKey: reference.tempKey,
            message: `Unresolved temp key @${reference.tempKey}`,
          },
        },
      ],
    };
  }

  const id = assertNonEmptyLocal(field === "source" ? "sourceId" : "dependsOnId", reference.id);
  const task = reader.getTask(id);
  const subtask = reader.getSubtask(id);
  if (!task && !subtask) {
    return {
      issues: [
        {
          index,
          type: "missing_id",
          sourceId: field === "source" ? id : "",
          dependsOnId: field === "dependsOn" ? id : "",
          details: {
            field,
            id,
            message: `Node not found: ${id}`,
          },
        },
      ],
    };
  }

  return { id, issues: [] };
}

function wouldCreateCycleInAdjacency(
  adjacency: ReadonlyMap<string, ReadonlySet<string>>,
  sourceId: string,
  dependsOnId: string,
): boolean {
  const visited = new Set<string>();
  const queue: string[] = [dependsOnId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current)) continue;
    if (current === sourceId) return true;
    visited.add(current);
    const neighbors = adjacency.get(current);
    if (neighbors === undefined) continue;
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) queue.push(neighbor);
    }
  }

  return false;
}

function resolveEpicExpandEntityRef(
  reference: CompactEntityRef,
  mappings: readonly { tempKey: string; id: string; kind: "task" | "subtask" }[],
  option: "subtask" | "dep",
  index: number,
  field: "parent" | "source" | "dependsOn",
  reader: BatchValidationReader,
): ResolvedCompactEntity {
  if (reference.kind === "temp_key") {
    const mapping = mappings.find((candidate) => candidate.tempKey === reference.tempKey);
    if (mapping === undefined) {
      throw new DomainError({
        code: "invalid_input",
        message: `Unknown temp key @${reference.tempKey} in --${option} spec ${index + 1}`,
        details: { index, field, tempKey: reference.tempKey, option },
      });
    }
    return { id: mapping.id, kind: mapping.kind };
  }

  const id = assertNonEmptyLocal(field === "parent" ? "taskId" : `${field}Id`, reference.id);
  const unprefixedTempKey = mappings.find((candidate) => candidate.tempKey === id);
  if (unprefixedTempKey !== undefined) {
    throw new DomainError({
      code: "invalid_input",
      message: `Unprefixed temp key '${id}' in --${option} spec ${index + 1} ${field} ref matches a same-command ${unprefixedTempKey.kind} temp key. Use @${id} instead.`,
      details: {
        index,
        field,
        option,
        tempKey: id,
        suggestedRef: `@${id}`,
        matchedKind: unprefixedTempKey.kind,
      },
    });
  }
  return { id, kind: resolveNodeKindLocal(id, reader) };
}

// ---------------------------------------------------------------------------
// Exported pure functions
// ---------------------------------------------------------------------------

export function resolveDependencyBatchSpec(
  index: number,
  spec: CompactDependencySpec,
  reader: BatchValidationReader,
): DependencyBatchResolution {
  const sourceResolution = resolveDependencyBatchId(spec.source, "source", index, reader);
  const dependsOnResolution = resolveDependencyBatchId(spec.dependsOn, "dependsOn", index, reader);
  const issues = [...sourceResolution.issues, ...dependsOnResolution.issues];
  const sourceId = sourceResolution.id;
  const dependsOnId = dependsOnResolution.id;

  if (sourceId === undefined || dependsOnId === undefined) {
    return { issues };
  }

  if (sourceId === dependsOnId) {
    return {
      issues: [
        ...issues,
        {
          index,
          type: "cycle",
          sourceId,
          dependsOnId,
          details: { sourceId, dependsOnId, reason: "self_reference" },
        },
      ],
    };
  }

  return {
    spec: {
      index,
      sourceId,
      sourceKind: resolveNodeKindLocal(sourceId, reader),
      dependsOnId,
      dependsOnKind: resolveNodeKindLocal(dependsOnId, reader),
    },
    issues,
  };
}

export function resolveEpicExpandSubtaskSpecs(
  specs: readonly CompactSubtaskSpec[],
  mappings: readonly { tempKey: string; id: string; kind: "task" | "subtask" }[],
  reader: BatchValidationReader,
): CompactSubtaskSpec[] {
  return specs.map((spec, index) => {
    const parent = resolveEpicExpandEntityRef(spec.parent, mappings, "subtask", index, "parent", reader);
    if (parent.kind !== "task") {
      throw new DomainError({
        code: "invalid_input",
        message: `Subtask parent must resolve to a task in --subtask spec ${index + 1}`,
        details: { index, field: "parent", kind: parent.kind, id: parent.id },
      });
    }
    return { ...spec, parent: { kind: "id", id: parent.id } };
  });
}

export function resolveEpicExpandDependencySpecs(
  specs: readonly CompactDependencySpec[],
  mappings: readonly { tempKey: string; id: string; kind: "task" | "subtask" }[],
  reader: BatchValidationReader,
): CompactDependencySpec[] {
  return specs.map((spec, index) => ({
    source: {
      kind: "id",
      id: resolveEpicExpandEntityRef(spec.source, mappings, "dep", index, "source", reader).id,
    },
    dependsOn: {
      kind: "id",
      id: resolveEpicExpandEntityRef(spec.dependsOn, mappings, "dep", index, "dependsOn", reader).id,
    },
  }));
}

export function collectDependencyBatchIssues(
  specs: readonly ResolvedDependencyBatchSpec[],
  reader: BatchValidationReader,
): DependencyBatchValidationIssue[] {
  const issues: DependencyBatchValidationIssue[] = [];
  const seenEdges = new Map<string, number>();
  const adjacency = reader.buildDependencyAdjacency();

  for (const spec of specs) {
    const edgeKey = `${spec.sourceId}->${spec.dependsOnId}`;
    const existingIndex = seenEdges.get(edgeKey);
    if (existingIndex !== undefined) {
      issues.push({
        index: spec.index,
        type: "duplicate",
        sourceId: spec.sourceId,
        dependsOnId: spec.dependsOnId,
        details: {
          sourceId: spec.sourceId,
          dependsOnId: spec.dependsOnId,
          firstIndex: existingIndex,
          duplicateIndex: spec.index,
          duplicateKind: "batch",
        },
      });
      continue;
    }

    if (reader.getDependencyByEdge(spec.sourceId, spec.dependsOnId) !== null) {
      issues.push({
        index: spec.index,
        type: "duplicate",
        sourceId: spec.sourceId,
        dependsOnId: spec.dependsOnId,
        details: {
          sourceId: spec.sourceId,
          dependsOnId: spec.dependsOnId,
          duplicateKind: "existing",
        },
      });
      continue;
    }



    if (wouldCreateCycleInAdjacency(adjacency, spec.sourceId, spec.dependsOnId)) {
      issues.push({
        index: spec.index,
        type: "cycle",
        sourceId: spec.sourceId,
        dependsOnId: spec.dependsOnId,
        details: { sourceId: spec.sourceId, dependsOnId: spec.dependsOnId },
      });
      continue;
    }

    const nextNeighbors = adjacency.get(spec.sourceId) ?? new Set<string>();
    nextNeighbors.add(spec.dependsOnId);
    adjacency.set(spec.sourceId, nextNeighbors);
    seenEdges.set(edgeKey, spec.index);
  }

  return issues.sort((left, right) => left.index - right.index || left.type.localeCompare(right.type));
}

export function buildDependencyAdjacency(
  rows: ReadonlyArray<{ source_id: string; depends_on_id: string }>,
): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const row of rows) {
    const neighbors = adjacency.get(row.source_id) ?? new Set<string>();
    neighbors.add(row.depends_on_id);
    adjacency.set(row.source_id, neighbors);
  }
  return adjacency;
}
