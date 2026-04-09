import type { TrackerDomain } from "../domain/tracker-domain";
import type { DependencyRecord, SubtaskRecord, TaskRecord } from "../domain/types";

import {
  EXPORT_SCHEMA_VERSION,
  type ExportBundle,
  type ExportDependencyEdge,
  type ExportExternalNode,
  type ExportStatusCounts,
  type ExportSummary,
  type ExportWarning,
} from "./types";

function countStatuses(records: readonly { readonly status: string }[]): ExportStatusCounts {
  const counts = { total: records.length, todo: 0, inProgress: 0, done: 0, blocked: 0, other: 0 };
  for (const record of records) {
    if (record.status === "todo") counts.todo += 1;
    else if (record.status === "in_progress") counts.inProgress += 1;
    else if (record.status === "done") counts.done += 1;
    else if (record.status === "blocked") counts.blocked += 1;
    else counts.other += 1;
  }
  return counts;
}

export function buildEpicExportBundle(domain: TrackerDomain, epicId: string): ExportBundle {
  const epic = domain.getEpicOrThrow(epicId);
  const tasks: readonly TaskRecord[] = domain.listTasks(epicId);
  const taskIds = new Set(tasks.map((t) => t.id));

  const subtasksByTaskId = domain.listSubtasksByTaskIds(tasks.map((t) => t.id));
  const allSubtasks: SubtaskRecord[] = [];
  for (const task of tasks) {
    for (const subtask of subtasksByTaskId.get(task.id) ?? []) {
      allSubtasks.push(subtask);
    }
  }
  const subtaskIds = new Set(allSubtasks.map((s) => s.id));

  const inScopeIds = new Set([...taskIds, ...subtaskIds]);

  // Gather all dependencies touching any in-scope node
  const sourceIds = [...inScopeIds];
  const dependenciesBySourceId = domain.listDependenciesBySourceIds(sourceIds);
  const allRawDeps: DependencyRecord[] = [];
  const seenDepIds = new Set<string>();
  for (const deps of dependenciesBySourceId.values()) {
    for (const dep of deps) {
      if (!seenDepIds.has(dep.id)) {
        seenDepIds.add(dep.id);
        allRawDeps.push(dep);
      }
    }
  }

  // Also find dependencies where in-scope nodes are the target (dependsOnId)
  // by checking each in-scope node with listDependenciesTouchingNode
  // We use a more efficient approach: query dependencies where dependsOnId is in scope
  for (const nodeId of inScopeIds) {
    const touching = domain.listDependenciesTouchingNode(nodeId);
    for (const dep of touching) {
      if (!seenDepIds.has(dep.id)) {
        seenDepIds.add(dep.id);
        allRawDeps.push(dep);
      }
    }
  }

  // Sort for stable ordering
  allRawDeps.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  // Classify edges and build dependency indexes
  const blockedByMap = new Map<string, string[]>();
  const blocksMap = new Map<string, string[]>();
  const externalNodeMap = new Map<string, ExportExternalNode>();
  const warnings: ExportWarning[] = [];

  const edges: ExportDependencyEdge[] = allRawDeps.map((dep) => {
    const sourceInternal = inScopeIds.has(dep.sourceId);
    const targetInternal = inScopeIds.has(dep.dependsOnId);
    const internal = sourceInternal && targetInternal;

    // Build blockedBy: source is blocked by dependsOn
    if (sourceInternal) {
      const existing = blockedByMap.get(dep.sourceId) ?? [];
      existing.push(dep.dependsOnId);
      blockedByMap.set(dep.sourceId, existing);
    }

    // Build blocks: dependsOn blocks source
    if (targetInternal) {
      const existing = blocksMap.get(dep.dependsOnId) ?? [];
      existing.push(dep.sourceId);
      blocksMap.set(dep.dependsOnId, existing);
    }

    // Resolve external nodes
    if (!sourceInternal && !externalNodeMap.has(dep.sourceId)) {
      externalNodeMap.set(dep.sourceId, resolveExternalNode(domain, dep.sourceId, dep.sourceKind));
    }
    if (!targetInternal && !externalNodeMap.has(dep.dependsOnId)) {
      externalNodeMap.set(dep.dependsOnId, resolveExternalNode(domain, dep.dependsOnId, dep.dependsOnKind));
    }

    return {
      id: dep.id,
      sourceId: dep.sourceId,
      sourceKind: dep.sourceKind,
      dependsOnId: dep.dependsOnId,
      dependsOnKind: dep.dependsOnKind,
      internal,
    };
  });

  const externalNodes = [...externalNodeMap.values()].sort((a, b) => a.id.localeCompare(b.id));

  // Check for orphaned dependency references
  for (const node of externalNodes) {
    if (node.title === null) {
      warnings.push({
        code: "orphaned_external_node",
        message: `External ${node.kind} ${node.id} referenced by a dependency but not found in the database`,
        entityId: node.id,
      });
    }
  }

  const summary: ExportSummary = {
    taskCount: tasks.length,
    subtaskCount: allSubtasks.length,
    dependencyCount: edges.length,
    externalNodeCount: externalNodes.length,
    warningCount: warnings.length,
    taskStatuses: countStatuses(tasks),
    subtaskStatuses: countStatuses(allSubtasks),
  };

  return {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    epic,
    tasks,
    subtasks: allSubtasks,
    dependencies: edges,
    externalNodes,
    blockedBy: blockedByMap,
    blocks: blocksMap,
    warnings,
    summary,
  };
}

function resolveExternalNode(
  domain: TrackerDomain,
  id: string,
  kind: "task" | "subtask",
): ExportExternalNode {
  if (kind === "task") {
    const task = domain.getTask(id);
    if (task) {
      return { id, kind: "task", title: task.title, status: task.status, epicId: task.epicId };
    }
  } else {
    const subtask = domain.getSubtask(id);
    if (subtask) {
      const task = domain.getTask(subtask.taskId);
      return {
        id,
        kind: "subtask",
        title: subtask.title,
        status: subtask.status,
        epicId: task?.epicId ?? null,
      };
    }
  }

  return { id, kind, title: null, status: null, epicId: null };
}
