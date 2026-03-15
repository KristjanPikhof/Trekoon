import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createBoardApiHandler } from "../../src/board/routes";
import { openTrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-board-routes-"));
  tempDirs.push(workspace);
  return workspace;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("board routes", (): void => {
  test("returns snapshot with hierarchy, dependency edges, counts, and search fields", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const subtask = mutations.createSubtask({ taskId: task.id, title: "Write tests", description: "Cover API" });
      const dependency = mutations.addDependency(subtask.id, task.id);

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request("http://board.test/api/snapshot?token=secret-token"));
      const body = await response.json() as {
        ok: boolean;
        data: {
          snapshot: {
            epics: Array<{ id: string; taskIds: string[]; counts: { tasks: { total: number } }; search: { text: string } }>;
            tasks: Array<{ id: string; subtaskIds: string[]; dependencyIds: string[]; search: { text: string } }>;
            subtasks: Array<{ id: string; dependencyIds: string[]; counts: { dependencies: number } }>;
            dependencies: Array<{ id: string; sourceId: string; dependsOnId: string }>;
            counts: { dependencies: number };
          };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.snapshot.epics).toEqual([
        expect.objectContaining({
          id: epic.id,
          taskIds: [task.id],
          counts: {
            tasks: expect.objectContaining({ total: 1 }),
            subtasks: expect.objectContaining({ total: 1 }),
          },
          search: expect.objectContaining({ text: "Roadmap\nPlan release" }),
        }),
      ]);
      expect(body.data.snapshot.tasks).toEqual([
        expect.objectContaining({
          id: task.id,
          subtaskIds: [subtask.id],
          search: expect.objectContaining({ text: "Implement\nShip board" }),
        }),
      ]);
      expect(body.data.snapshot.subtasks).toEqual([
        expect.objectContaining({
          id: subtask.id,
          dependencyIds: [dependency.id],
          counts: { dependencies: 1, dependents: 0 },
        }),
      ]);
      expect(body.data.snapshot.dependencies).toEqual([
        expect.objectContaining({
          id: dependency.id,
          sourceId: subtask.id,
          dependsOnId: task.id,
        }),
      ]);
      expect(body.data.snapshot.counts.dependencies).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("rejects requests without a valid session token", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request("http://board.test/api/snapshot"));
      const body = await response.json() as { error: { code: string } };

      expect(response.status).toBe(401);
      expect(body.error.code).toBe("unauthorized");
    } finally {
      storage.close();
    }
  });

  test("returns stable invalid transition codes for mutation routes", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blockedBy = mutations.createTask({ epicId: epic.id, title: "Blocked By", description: "Finish first" });
      const blocked = mutations.createTask({ epicId: epic.id, title: "Blocked", description: "Depends on prior work" });
      mutations.addDependency(blocked.id, blockedBy.id);

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request(`http://board.test/api/tasks/${blocked.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "in_progress" }),
      }));
      const body = await response.json() as { error: { code: string; details: { unresolvedDependencyCount: number } } };

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("dependency_blocked");
      expect(body.error.details.unresolvedDependencyCount).toBe(1);
    } finally {
      storage.close();
    }
  });
});
