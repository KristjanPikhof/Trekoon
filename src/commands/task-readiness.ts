import { TrackerDomain } from "../domain/tracker-domain";
import { type TaskRecord } from "../domain/types";

export const DEFAULT_OPEN_TASK_STATUSES = ["in_progress", "todo"] as const;
export const READY_REASON_READY = "all_dependencies_done";
export const READY_REASON_BLOCKED = "blocked_by_dependencies";

export interface DependencyBlocker {
  readonly id: string;
  readonly kind: "task" | "subtask";
  readonly status: string;
}

export interface TaskReadyCandidate {
  readonly task: TaskRecord;
  readonly readiness: {
    readonly isReady: boolean;
    readonly reason: typeof READY_REASON_READY | typeof READY_REASON_BLOCKED;
  };
  readonly blockerSummary: {
    readonly totalDependencies: number;
    readonly blockedByCount: number;
    readonly blockedBy: ReadonlyArray<DependencyBlocker>;
  };
  readonly ranking: {
    readonly statusPriority: number;
    readonly blockerCount: number;
    readonly createdAt: number;
    readonly id: string;
    readonly rank: number;
  };
}

export type ReadyReason = typeof READY_REASON_READY | typeof READY_REASON_BLOCKED;

export interface TaskReadinessSummary {
  readonly totalOpenTasks: number;
  readonly readyCount: number;
  readonly returnedCount: number;
  readonly appliedLimit: number | null;
  readonly blockedCount: number;
  readonly unresolvedDependencyCount: number;
}

export interface TaskReadinessResult {
  readonly candidates: readonly TaskReadyCandidate[];
  readonly blocked: readonly TaskReadyCandidate[];
  readonly summary: TaskReadinessSummary;
}

export function taskStatusPriority(status: string): number {
  if (status === "in_progress") {
    return 0;
  }

  if (status === "todo") {
    return 1;
  }

  return 2;
}

export function buildTaskReadiness(domain: TrackerDomain, epicId: string | undefined): TaskReadinessResult {
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
          rank: 0,
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
