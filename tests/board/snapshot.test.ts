import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { buildBoardSnapshot, buildBoardSnapshotDelta } from "../../src/board/snapshot";
import { openTrekoonDatabase } from "../../src/storage/database";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-snapshot-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("buildBoardSnapshotDelta", (): void => {
  test("fetches dependency by ID even when its source task is outside the task/subtask selection", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Dep Epic", description: "for dep test" });
      // taskA depends on taskB — taskA is the source, taskB is the target.
      const taskA = mutations.createTask({ epicId: epic.id, title: "A", description: "source task" });
      const taskB = mutations.createTask({ epicId: epic.id, title: "B", description: "target task" });
      const dep = mutations.addDependency(taskA.id, taskB.id);

      const domain = new TrackerDomain(storage.db);

      // Pass only dependencyIds — no taskIds or subtaskIds.
      // The source (taskA) is NOT in the task/subtask selection, so the old
      // source-index path would silently drop the dependency.
      const delta = buildBoardSnapshotDelta(domain, {
        dependencyIds: [dep.id],
      });

      expect(Array.isArray(delta.dependencies)).toBe(true);
      const deps = delta.dependencies as Array<{ id: string; sourceId: string; dependsOnId: string }>;
      expect(deps).toHaveLength(1);
      const firstDep = deps[0];
      expect(firstDep?.id).toBe(dep.id);
      expect(firstDep?.sourceId).toBe(taskA.id);
      expect(firstDep?.dependsOnId).toBe(taskB.id);
    } finally {
      storage.close();
    }
  });

  test("returns empty dependencies array when requested dependencyId does not exist", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const domain = new TrackerDomain(storage.db);
      const delta = buildBoardSnapshotDelta(domain, {
        dependencyIds: ["00000000-0000-0000-0000-nonexistent01"],
      });

      expect(Array.isArray(delta.dependencies)).toBe(true);
      const deps = delta.dependencies as unknown[];
      expect(deps).toHaveLength(0);
    } finally {
      storage.close();
    }
  });

  test("uses source-index path when no explicit dependencyIds are given (existing behaviour)", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Index Epic", description: "index path test" });
      const taskA = mutations.createTask({ epicId: epic.id, title: "Src", description: "source task" });
      const taskB = mutations.createTask({ epicId: epic.id, title: "Tgt", description: "target task" });
      const dep = mutations.addDependency(taskA.id, taskB.id);

      const domain = new TrackerDomain(storage.db);

      // Pass taskIds only — no explicit dependencyIds. Delta must still surface the dependency.
      const delta = buildBoardSnapshotDelta(domain, {
        taskIds: [taskA.id, taskB.id],
        dependencyIds: [dep.id],
      });

      const deps = delta.dependencies as Array<{ id: string }>;
      expect(deps.some((d) => d.id === dep.id)).toBe(true);
    } finally {
      storage.close();
    }
  });
});

describe("buildBoardSnapshot", (): void => {
  test("groups tasks under their epics via map lookup (no global filter)", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epicA = mutations.createEpic({ title: "Alpha", description: "First epic" });
      const epicB = mutations.createEpic({ title: "Beta", description: "Second epic" });
      const taskA1 = mutations.createTask({ epicId: epicA.id, title: "A1", description: "task one" });
      const taskA2 = mutations.createTask({ epicId: epicA.id, title: "A2", description: "task two" });
      const taskB1 = mutations.createTask({ epicId: epicB.id, title: "B1", description: "task three" });

      const domain = new TrackerDomain(storage.db);
      const snapshot = buildBoardSnapshot(domain);

      const alpha = snapshot.epics.find((epic) => epic.id === epicA.id);
      const beta = snapshot.epics.find((epic) => epic.id === epicB.id);
      // Map lookup must produce identical taskIds to filtering snapshotTasks by epicId.
      const expectedAlphaIds = snapshot.tasks.filter((task) => task.epicId === epicA.id).map((task) => task.id);
      const expectedBetaIds = snapshot.tasks.filter((task) => task.epicId === epicB.id).map((task) => task.id);
      expect(alpha?.taskIds).toEqual(expectedAlphaIds);
      expect(beta?.taskIds).toEqual(expectedBetaIds);
      // Sanity check task IDs are present and disjoint between epics.
      expect(new Set(alpha?.taskIds)).toEqual(new Set([taskA1.id, taskA2.id]));
      expect(new Set(beta?.taskIds)).toEqual(new Set([taskB1.id]));
      // Counts must reflect grouped tasks, not the global task list.
      expect(alpha?.counts.todo).toBe(2);
      expect(beta?.counts.todo).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("includes epics with zero tasks via empty default array", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epicEmpty = mutations.createEpic({ title: "Empty", description: "No tasks here" });
      const epicPopulated = mutations.createEpic({ title: "Populated", description: "Has work" });
      mutations.createTask({ epicId: epicPopulated.id, title: "T1", description: "first task" });

      const domain = new TrackerDomain(storage.db);
      const snapshot = buildBoardSnapshot(domain);

      const empty = snapshot.epics.find((epic) => epic.id === epicEmpty.id);
      expect(empty).toBeDefined();
      expect(empty?.taskIds).toEqual([]);
      expect(empty?.counts).toEqual({ todo: 0, blocked: 0, in_progress: 0, done: 0 });
      expect(empty?.searchText).toBe("empty no tasks here");
    } finally {
      storage.close();
    }
  });

  test("preserves searchText derivation aligned with domain task order", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      mutations.createTask({ epicId: epic.id, title: "First", description: "alpha description" });
      mutations.createTask({ epicId: epic.id, title: "Second", description: "beta description" });
      mutations.createTask({ epicId: epic.id, title: "Third", description: "gamma description" });

      const domain = new TrackerDomain(storage.db);
      const snapshot = buildBoardSnapshot(domain);

      const epicSnapshot = snapshot.epics.find((entry) => entry.id === epic.id);
      // taskIds must mirror the same per-epic task order used to build searchText.
      const expected = snapshot.tasks.filter((task) => task.epicId === epic.id).map((task) => task.id);
      expect(epicSnapshot?.taskIds).toEqual(expected);
      // searchText concatenates epic + per-task search text in matching order.
      const expectedText = ["roadmap plan release", ...snapshot.tasks
        .filter((task) => task.epicId === epic.id)
        .map((task) => task.searchText)].join(" ").toLowerCase();
      expect(epicSnapshot?.searchText).toBe(expectedText);
    } finally {
      storage.close();
    }
  });
});
