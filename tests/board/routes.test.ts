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
            epics: Array<{ id: string; taskIds: string[]; counts: { tasks: { total: number; blocked: number } }; search: { text: string } }>;
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
            tasks: expect.objectContaining({ total: 1, blocked: 0 }),
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

  test("accepts bearer token auth for board API requests", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request("http://board.test/api/snapshot", {
        headers: {
          authorization: "Bearer secret-token",
        },
      }));
      const body = await response.json() as { ok: boolean; data: { snapshot: { epics: unknown[] } } };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(Array.isArray(body.data.snapshot.epics)).toBeTrue();
    } finally {
      storage.close();
    }
  });

  test("returns readable dependency blocked errors for mutation routes", async (): Promise<void> => {
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
      const body = await response.json() as { error: { code: string; message: string; details: { unresolvedDependencyCount: number } } };

      expect(response.status).toBe(409);
      expect(body.error.code).toBe("dependency_blocked");
      expect(body.error.message).toContain(`task ${blockedBy.id} is still todo`);
      expect(body.error.details.unresolvedDependencyCount).toBe(1);
    } finally {
      storage.close();
    }
  });

  test("returns fresh snapshot payloads with successful mutations", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request(`http://board.test/api/tasks/${task.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "blocked" }),
      }));
      const body = await response.json() as {
        ok: boolean;
        data: {
          task: { id: string; status: string };
          snapshot: { tasks: Array<{ id: string; status: string }> };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.task.status).toBe("blocked");
      expect(body.data.snapshot.tasks).toContainEqual(expect.objectContaining({ id: task.id, status: "blocked" }));
    } finally {
      storage.close();
    }
  });

  test("returns invalid_input for malformed JSON bodies", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request(`http://board.test/api/tasks/${task.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: "{",
      }));
      const body = await response.json() as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(response.status).toBe(400);
      expect(body).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Malformed JSON request body",
        },
      });
    } finally {
      storage.close();
    }
  });

  test("returns invalid_input for representative invalid request bodies", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const wrongContentType = await handler(new Request(`http://board.test/api/tasks/${task.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "text/plain",
        },
        body: JSON.stringify({ status: "done" }),
      }));
      const wrongContentTypeBody = await wrongContentType.json() as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(wrongContentType.status).toBe(400);
      expect(wrongContentTypeBody).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Expected application/json request body",
        },
      });

      const wrongShape = await handler(new Request(`http://board.test/api/tasks/${task.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(["done"]),
      }));
      const wrongShapeBody = await wrongShape.json() as {
        ok: boolean;
        error: { code: string; message: string };
      };

      expect(wrongShape.status).toBe(400);
      expect(wrongShapeBody).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Expected JSON object request body",
        },
      });

      const missingRequiredField = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ sourceId: task.id }),
      }));
      const missingRequiredFieldBody = await missingRequiredField.json() as {
        ok: boolean;
        error: { code: string; message: string; details: { field: string } };
      };

      expect(missingRequiredField.status).toBe(400);
      expect(missingRequiredFieldBody).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "dependsOnId is required",
          details: {
            field: "dependsOnId",
          },
        },
      });
    } finally {
      storage.close();
    }
  });

  test("accepts bearer token auth for mutation routes", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request(`http://board.test/api/tasks/${task.id}`, {
        method: "PATCH",
        headers: {
          authorization: "Bearer secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "done" }),
      }));
      const body = await response.json() as {
        ok: boolean;
        data: {
          task: { id: string; status: string };
          snapshot: { tasks: Array<{ id: string; status: string }> };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.task).toEqual(expect.objectContaining({ id: task.id, status: "done" }));
      expect(body.data.snapshot.tasks).toContainEqual(expect.objectContaining({ id: task.id, status: "done" }));
    } finally {
      storage.close();
    }
  });

  test("edits empty-description subtasks and allows clearing descriptions", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const emptySubtask = mutations.createSubtask({ taskId: task.id, title: "Triage bug" });
      const describedSubtask = mutations.createSubtask({
        taskId: task.id,
        title: "Document fix",
        description: "Capture before/after behaviour",
      });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const emptyResponse = await handler(new Request(`http://board.test/api/subtasks/${emptySubtask.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: "Triage regression",
          description: "",
          status: "done",
        }),
      }));
      const emptyBody = await emptyResponse.json() as {
        ok: boolean;
        data: {
          subtask: { id: string; title: string; description: string; status: string };
          snapshot: { subtasks: Array<{ id: string; title: string; description: string; status: string }> };
        };
      };

      expect(emptyResponse.status).toBe(200);
      expect(emptyBody.ok).toBeTrue();
      expect(emptyBody.data.subtask).toEqual(expect.objectContaining({
        id: emptySubtask.id,
        title: "Triage regression",
        description: "",
        status: "done",
      }));
      expect(emptyBody.data.snapshot.subtasks).toContainEqual(expect.objectContaining({
        id: emptySubtask.id,
        title: "Triage regression",
        description: "",
        status: "done",
      }));

      const clearResponse = await handler(new Request(`http://board.test/api/subtasks/${describedSubtask.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          title: describedSubtask.title,
          description: "",
          status: "in_progress",
        }),
      }));
      const clearBody = await clearResponse.json() as {
        ok: boolean;
        data: {
          subtask: { id: string; description: string; status: string };
          snapshot: { subtasks: Array<{ id: string; description: string; status: string }> };
        };
      };

      expect(clearResponse.status).toBe(200);
      expect(clearBody.ok).toBeTrue();
      expect(clearBody.data.subtask).toEqual(expect.objectContaining({
        id: describedSubtask.id,
        description: "",
        status: "in_progress",
      }));
      expect(clearBody.data.snapshot.subtasks).toContainEqual(expect.objectContaining({
        id: describedSubtask.id,
        description: "",
        status: "in_progress",
      }));
    } finally {
      storage.close();
    }
  });
});
