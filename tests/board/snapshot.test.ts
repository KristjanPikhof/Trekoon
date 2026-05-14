import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";
import { buildBoardSnapshot } from "../../src/board/snapshot";
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

describe("buildBoardSnapshot", (): void => {
  test("groups tasks under their epics using a single pass", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epicA = mutations.createEpic({ title: "Alpha", description: "First" });
      const epicB = mutations.createEpic({ title: "Beta", description: "Second" });
      const taskA1 = mutations.createTask({ epicId: epicA.id, title: "A1", description: "" });
      const taskA2 = mutations.createTask({ epicId: epicA.id, title: "A2", description: "" });
      const taskB1 = mutations.createTask({ epicId: epicB.id, title: "B1", description: "" });

      const domain = new TrackerDomain(storage.db, cwd);
      const snapshot = buildBoardSnapshot(domain);

      const alpha = snapshot.epics.find((epic) => epic.id === epicA.id);
      const beta = snapshot.epics.find((epic) => epic.id === epicB.id);
      expect(alpha?.taskIds).toEqual([taskA1.id, taskA2.id]);
      expect(beta?.taskIds).toEqual([taskB1.id]);
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
      const epicEmpty = mutations.createEpic({ title: "Empty", description: "No tasks" });
      const epicPopulated = mutations.createEpic({ title: "Populated", description: "Has work" });
      mutations.createTask({ epicId: epicPopulated.id, title: "T1", description: "" });

      const domain = new TrackerDomain(storage.db, cwd);
      const snapshot = buildBoardSnapshot(domain);

      const empty = snapshot.epics.find((epic) => epic.id === epicEmpty.id);
      expect(empty).toBeDefined();
      expect(empty?.taskIds).toEqual([]);
      expect(empty?.counts).toEqual({ todo: 0, blocked: 0, in_progress: 0, done: 0 });
      expect(empty?.searchText).toBe("empty no tasks");
    } finally {
      storage.close();
    }
  });

  test("preserves task ordering and searchText derivation within each epic", (): void => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan" });
      const t1 = mutations.createTask({ epicId: epic.id, title: "First", description: "alpha" });
      const t2 = mutations.createTask({ epicId: epic.id, title: "Second", description: "beta" });
      const t3 = mutations.createTask({ epicId: epic.id, title: "Third", description: "gamma" });

      const domain = new TrackerDomain(storage.db, cwd);
      const snapshot = buildBoardSnapshot(domain);

      const epicSnapshot = snapshot.epics.find((entry) => entry.id === epic.id);
      // Task IDs maintain creation order returned by domain.listTasks().
      expect(epicSnapshot?.taskIds).toEqual([t1.id, t2.id, t3.id]);
      // searchText concatenates epic + per-task search text in domain order.
      expect(epicSnapshot?.searchText.startsWith("roadmap plan ")).toBe(true);
      expect(epicSnapshot?.searchText).toContain("first alpha todo");
      expect(epicSnapshot?.searchText).toContain("second beta todo");
      expect(epicSnapshot?.searchText).toContain("third gamma todo");
      // Order inside searchText matches creation order (alpha before beta before gamma).
      const alphaIdx = epicSnapshot?.searchText.indexOf("alpha") ?? -1;
      const betaIdx = epicSnapshot?.searchText.indexOf("beta") ?? -1;
      const gammaIdx = epicSnapshot?.searchText.indexOf("gamma") ?? -1;
      expect(alphaIdx).toBeGreaterThan(-1);
      expect(betaIdx).toBeGreaterThan(alphaIdx);
      expect(gammaIdx).toBeGreaterThan(betaIdx);
    } finally {
      storage.close();
    }
  });
});
