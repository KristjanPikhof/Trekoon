import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { createBoardApiHandler } from "../../src/board/routes";
import { openTrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";

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
          counts: expect.objectContaining({ todo: 1, blocked: 0 }),
          searchText: expect.stringContaining("roadmap plan release"),
        }),
      ]);
      expect(body.data.snapshot.tasks).toEqual([
        expect.objectContaining({
          id: task.id,
          subtasks: [expect.objectContaining({ id: subtask.id })],
          dependencyIds: [],
          searchText: expect.stringContaining("implement ship board"),
        }),
      ]);
      expect(body.data.snapshot.subtasks).toEqual([
        expect.objectContaining({
          id: subtask.id,
          dependencyIds: [dependency.id],
          blockedBy: [task.id],
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

  test("accepts x-trekoon-token auth for board API requests", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request("http://board.test/api/snapshot", {
        headers: {
          "x-trekoon-token": "secret-token",
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
          snapshotDelta: { tasks: Array<{ id: string; status: string }> };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.task.status).toBe("blocked");
      expect(body.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({ id: task.id, status: "blocked" }));
    } finally {
      storage.close();
    }
  });

  test("cascades epic status updates atomically through one board route", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const firstTask = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const secondTask = mutations.createTask({ epicId: epic.id, title: "Verify", description: "Check output" });
      const subtask = mutations.createSubtask({ taskId: firstTask.id, title: "Write tests", description: "Cover cascade" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request(`http://board.test/api/epics/${epic.id}/cascade?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "done" }),
      }));
      const body = await response.json() as {
        ok: boolean;
        data: {
          plan: { atomic: boolean; changedIds: string[]; blockers: unknown[] };
          snapshotDelta: {
            epics: Array<{ id: string; status: string }>;
            tasks: Array<{ id: string; status: string }>;
            subtasks: Array<{ id: string; status: string }>;
          };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.plan).toEqual(expect.objectContaining({
        atomic: true,
        changedIds: expect.arrayContaining([epic.id, firstTask.id, secondTask.id, subtask.id]),
        blockers: [],
      }));
      expect(body.data.snapshotDelta.epics).toContainEqual(expect.objectContaining({ id: epic.id, status: "done" }));
      expect(body.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({ id: firstTask.id, status: "done" }));
      expect(body.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({ id: secondTask.id, status: "done" }));
      expect(body.data.snapshotDelta.subtasks).toContainEqual(expect.objectContaining({ id: subtask.id, status: "done" }));
    } finally {
      storage.close();
    }
  });

  test("rejects blocked epic cascades without partial snapshot changes", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "Finish first" });
      const blocked = mutations.createTask({ epicId: epic.id, title: "Blocked", description: "Depends on blocker" });
      const blockedSubtask = mutations.createSubtask({ taskId: blocked.id, title: "Wait on unblock", description: "Cannot finish yet" });
      mutations.addDependency(blocked.id, blocker.id);

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const response = await handler(new Request(`http://board.test/api/epics/${epic.id}/cascade?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "in_progress" }),
      }));
      const body = await response.json() as {
        ok: boolean;
        error: { code: string; message: string; details: { changedIds: string[]; blockerCount: number } };
      };

      expect(response.status).toBe(409);
      expect(body.ok).toBeFalse();
      expect(body.error.code).toBe("dependency_blocked");
      expect(body.error.message).toContain(`task ${blocked.id} is blocked by task ${blocker.id} (todo)`);
      expect(body.error.details).toEqual(expect.objectContaining({
        blockerCount: 1,
      }));

      const snapshotResponse = await handler(new Request("http://board.test/api/snapshot?token=secret-token"));
      const snapshotBody = await snapshotResponse.json() as {
        ok: boolean;
        data: {
          snapshot: {
            epics: Array<{ id: string; status: string }>;
            tasks: Array<{ id: string; status: string }>;
            subtasks: Array<{ id: string; status: string }>;
          };
        };
      };

      expect(snapshotResponse.status).toBe(200);
      expect(snapshotBody.ok).toBeTrue();
      expect(snapshotBody.data.snapshot.epics).toContainEqual(expect.objectContaining({ id: epic.id, status: "todo" }));
      expect(snapshotBody.data.snapshot.tasks).toContainEqual(expect.objectContaining({ id: blocker.id, status: "todo" }));
      expect(snapshotBody.data.snapshot.tasks).toContainEqual(expect.objectContaining({ id: blocked.id, status: "todo" }));
      expect(snapshotBody.data.snapshot.subtasks).toContainEqual(expect.objectContaining({ id: blockedSubtask.id, status: "todo" }));
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
        body: JSON.stringify({ status: "in_progress" }),
      }));
      const body = await response.json() as {
        ok: boolean;
        data: {
          task: { id: string; status: string };
          snapshotDelta: { tasks: Array<{ id: string; status: string }> };
        };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.task).toEqual(expect.objectContaining({ id: task.id, status: "in_progress" }));
      expect(body.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({ id: task.id, status: "in_progress" }));
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
          status: "in_progress",
        }),
      }));
      const emptyBody = await emptyResponse.json() as {
        ok: boolean;
        data: {
          subtask: { id: string; title: string; description: string; status: string };
          snapshotDelta: { subtasks: Array<{ id: string; title: string; description: string; status: string }> };
        };
      };

      expect(emptyResponse.status).toBe(200);
      expect(emptyBody.ok).toBeTrue();
      expect(emptyBody.data.subtask).toEqual(expect.objectContaining({
        id: emptySubtask.id,
        title: "Triage regression",
        description: "",
        status: "in_progress",
      }));
      expect(emptyBody.data.snapshotDelta.subtasks).toContainEqual(expect.objectContaining({
        id: emptySubtask.id,
        title: "Triage regression",
        description: "",
        status: "in_progress",
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
          snapshotDelta: { subtasks: Array<{ id: string; description: string; status: string }> };
        };
      };

      expect(clearResponse.status).toBe(200);
      expect(clearBody.ok).toBeTrue();
      expect(clearBody.data.subtask).toEqual(expect.objectContaining({
        id: describedSubtask.id,
        description: "",
        status: "in_progress",
      }));
      expect(clearBody.data.snapshotDelta.subtasks).toContainEqual(expect.objectContaining({
        id: describedSubtask.id,
        description: "",
        status: "in_progress",
      }));
    } finally {
      storage.close();
    }
  });

  test("retries subtask creation idempotently when given the same client request id", async (): Promise<void> => {
    const cwd = createWorkspace();
    let storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      let handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestBody = JSON.stringify({
        taskId: task.id,
        title: "Write regression coverage",
        description: "Add the board route tests",
        status: "todo",
        clientRequestId: "create-subtask-1",
      });

      const firstResponse = await handler(new Request("http://board.test/api/subtasks?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }));
      const secondResponse = await handler(new Request("http://board.test/api/subtasks?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }));

      const firstBody = await firstResponse.json() as { data: { subtask: { id: string } } };
      const secondBody = await secondResponse.json() as { data: { subtask: { id: string }; snapshotDelta: { subtasks: Array<{ id: string }> } } };

      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(201);
      expect(secondBody.data.subtask.id).toBe(firstBody.data.subtask.id);
      expect(secondBody.data.snapshotDelta.subtasks.filter((subtask) => subtask.id === firstBody.data.subtask.id)).toHaveLength(1);

      const deleteResponse = await handler(new Request(`http://board.test/api/subtasks/${firstBody.data.subtask.id}?token=secret-token`, {
        method: "DELETE",
      }));
      expect(deleteResponse.status).toBe(200);

      storage.close();
      storage = openTrekoonDatabase(cwd);
      handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const replayResponse = await handler(new Request("http://board.test/api/subtasks?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }));
      const replayBody = await replayResponse.json() as { data: { subtask: { id: string }; snapshotDelta: { subtasks: Array<{ id: string }> } } };

      expect(replayResponse.status).toBe(201);
      expect(replayBody.data.subtask.id).toBe(firstBody.data.subtask.id);
      expect(replayBody.data.snapshotDelta.subtasks).toContainEqual(expect.objectContaining({ id: firstBody.data.subtask.id }));

      const snapshotResponse = await handler(new Request("http://board.test/api/snapshot?token=secret-token"));
      const snapshotBody = await snapshotResponse.json() as { data: { snapshot: { subtasks: Array<{ id: string }> } } };
      expect(snapshotBody.data.snapshot.subtasks.some((subtask) => subtask.id === firstBody.data.subtask.id)).toBeFalse();
    } finally {
      storage.close();
    }
  });

  test("rejects reusing a subtask idempotency key for a different request", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestHeaders = {
        "content-type": "application/json",
        "x-trekoon-idempotency-key": "create-subtask-header-1",
      };

      const firstResponse = await handler(new Request("http://board.test/api/subtasks?token=secret-token", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          taskId: task.id,
          title: "Write regression coverage",
          description: "Add the board route tests",
          status: "todo",
        }),
      }));
      expect(firstResponse.status).toBe(201);

      const secondResponse = await handler(new Request("http://board.test/api/subtasks?token=secret-token", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          taskId: task.id,
          title: "Different subtask",
          description: "Should be rejected",
          status: "todo",
        }),
      }));
      const secondBody = await secondResponse.json() as { error: { code: string; message: string } };

      expect(secondResponse.status).toBe(400);
      expect(secondBody.error).toEqual(expect.objectContaining({
        code: "invalid_input",
        message: "Idempotency key cannot be reused for a different subtask request",
      }));
    } finally {
      storage.close();
    }
  });

  test("accepts null owners for board task updates", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      mutations.updateTask(task.id, { owner: "alice" });
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const response = await handler(new Request(`http://board.test/api/tasks/${task.id}?token=secret-token`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ owner: null }),
      }));
      const body = await response.json() as {
        ok: boolean;
        data: { task: { id: string; owner: string | null }; snapshotDelta: { tasks: Array<{ id: string; owner: string | null }> } };
      };

      expect(response.status).toBe(200);
      expect(body.ok).toBeTrue();
      expect(body.data.task).toEqual(expect.objectContaining({ id: task.id, owner: null }));
      expect(new TrackerDomain(storage.db).getTask(task.id)?.owner).toBeNull();
    } finally {
      storage.close();
    }
  });

  test("retries dependency creation idempotently when given the same client request id", async (): Promise<void> => {
    const cwd = createWorkspace();
    let storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "Finish first" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      let handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestBody = JSON.stringify({
        sourceId: task.id,
        dependsOnId: blocker.id,
        clientRequestId: "dependency-1",
      });

      const firstResponse = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }));
      const secondResponse = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }));

      const firstBody = await firstResponse.json() as { data: { dependency: { id: string } } };
      const secondBody = await secondResponse.json() as { data: { dependency: { id: string }; snapshotDelta: { dependencies: Array<{ id: string }> } } };

      expect(firstResponse.status).toBe(201);
      expect(secondResponse.status).toBe(201);
      expect(secondBody.data.dependency.id).toBe(firstBody.data.dependency.id);
      expect(secondBody.data.snapshotDelta.dependencies.filter((dependency) => dependency.id === firstBody.data.dependency.id)).toHaveLength(1);

      const deleteResponse = await handler(new Request(`http://board.test/api/dependencies?token=secret-token&sourceId=${encodeURIComponent(task.id)}&dependsOnId=${encodeURIComponent(blocker.id)}`, {
        method: "DELETE",
      }));
      expect(deleteResponse.status).toBe(200);

      storage.close();
      storage = openTrekoonDatabase(cwd);
      handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const replayResponse = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: requestBody,
      }));
      const replayBody = await replayResponse.json() as { data: { dependency: { id: string }; snapshotDelta: { dependencies: Array<{ id: string }> } } };

      expect(replayResponse.status).toBe(201);
      expect(replayBody.data.dependency.id).toBe(firstBody.data.dependency.id);
      expect(replayBody.data.snapshotDelta.dependencies).toContainEqual(expect.objectContaining({ id: firstBody.data.dependency.id }));

      const snapshotResponse = await handler(new Request("http://board.test/api/snapshot?token=secret-token"));
      const snapshotBody = await snapshotResponse.json() as { data: { snapshot: { dependencies: Array<{ id: string }> } } };
      expect(snapshotBody.data.snapshot.dependencies.some((dependency) => dependency.id === firstBody.data.dependency.id)).toBeFalse();
    } finally {
      storage.close();
    }
  });

  test("rejects reusing a dependency idempotency key for a different request", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "Finish first" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const otherBlocker = mutations.createTask({ epicId: epic.id, title: "Review", description: "Approve first" });
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestHeaders = {
        "content-type": "application/json",
        "x-trekoon-idempotency-key": "dependency-header-1",
      };

      const firstResponse = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          sourceId: task.id,
          dependsOnId: blocker.id,
        }),
      }));
      expect(firstResponse.status).toBe(201);

      const secondResponse = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: requestHeaders,
        body: JSON.stringify({
          sourceId: task.id,
          dependsOnId: otherBlocker.id,
        }),
      }));
      const secondBody = await secondResponse.json() as { error: { code: string; message: string } };

      expect(secondResponse.status).toBe(400);
      expect(secondBody.error).toEqual(expect.objectContaining({
        code: "invalid_input",
        message: "Idempotency key cannot be reused for a different dependency request",
      }));
    } finally {
      storage.close();
    }
  });

  test("creates and deletes subtasks through board routes", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const createResponse = await handler(new Request("http://board.test/api/subtasks?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          taskId: task.id,
          title: "Write regression coverage",
          description: "Add the board route tests",
          status: "todo",
        }),
      }));

      const createBody = await createResponse.json() as {
        ok: boolean;
        data: {
          subtask: { id: string; taskId: string; title: string; description: string; status: string };
          snapshotDelta: { subtasks: Array<{ id: string; taskId: string; title: string; description: string; status: string }> };
        };
      };

      expect(createResponse.status).toBe(201);
      expect(createBody.ok).toBeTrue();
      expect(createBody.data.subtask).toEqual(expect.objectContaining({
        taskId: task.id,
        title: "Write regression coverage",
        description: "Add the board route tests",
        status: "todo",
      }));
      expect(createBody.data.snapshotDelta.subtasks).toContainEqual(expect.objectContaining({
        id: createBody.data.subtask.id,
        taskId: task.id,
        title: "Write regression coverage",
      }));

      const deleteResponse = await handler(new Request(`http://board.test/api/subtasks/${createBody.data.subtask.id}?token=secret-token`, {
        method: "DELETE",
      }));

      const deleteBody = await deleteResponse.json() as {
        ok: boolean;
        data: {
          subtaskId: string;
          deleted: boolean;
          snapshotDelta: { deletedSubtaskIds: string[] };
        };
      };

      expect(deleteResponse.status).toBe(200);
      expect(deleteBody.ok).toBeTrue();
      expect(deleteBody.data).toEqual(expect.objectContaining({
        subtaskId: createBody.data.subtask.id,
        deleted: true,
      }));
      expect(deleteBody.data.snapshotDelta.deletedSubtaskIds).toContain(createBody.data.subtask.id);
    } finally {
      storage.close();
    }
  });

  test("deleting a subtask removes touching dependency rows and delta ids", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "Finish first" });
      const blockedSubtask = mutations.createSubtask({ taskId: task.id, title: "Write regression coverage", description: "Board sync" });
      const helperSubtask = mutations.createSubtask({ taskId: task.id, title: "Prepare fixtures", description: "Shared prep" });
      const incomingDependency = mutations.addDependency(blockedSubtask.id, blocker.id);
      const outgoingDependency = mutations.addDependency(helperSubtask.id, blockedSubtask.id);

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });
      const deleteResponse = await handler(new Request(`http://board.test/api/subtasks/${blockedSubtask.id}?token=secret-token`, {
        method: "DELETE",
      }));
      const deleteBody = await deleteResponse.json() as {
        ok: boolean;
        data: {
          subtaskId: string;
          deleted: boolean;
          snapshotDelta: { deletedSubtaskIds: string[]; deletedDependencyIds: string[] };
        };
      };

      expect(deleteResponse.status).toBe(200);
      expect(deleteBody.ok).toBeTrue();
      expect(deleteBody.data.snapshotDelta.deletedSubtaskIds).toEqual([blockedSubtask.id]);
      expect(deleteBody.data.snapshotDelta.deletedDependencyIds.sort()).toEqual([incomingDependency.id, outgoingDependency.id].sort());

      const snapshotResponse = await handler(new Request("http://board.test/api/snapshot?token=secret-token"));
      const snapshotBody = await snapshotResponse.json() as {
        ok: boolean;
        data: { snapshot: { subtasks: Array<{ id: string }>; dependencies: Array<{ id: string; sourceId: string; dependsOnId: string }> } };
      };

      expect(snapshotBody.ok).toBeTrue();
      expect(snapshotBody.data.snapshot.subtasks.some((subtask) => subtask.id === blockedSubtask.id)).toBeFalse();
      expect(snapshotBody.data.snapshot.dependencies).not.toContainEqual(expect.objectContaining({ id: incomingDependency.id }));
      expect(snapshotBody.data.snapshot.dependencies).not.toContainEqual(expect.objectContaining({ id: outgoingDependency.id }));
    } finally {
      storage.close();
    }
  });

  test("retries subtask deletion idempotently when given the same client request id", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const subtask = mutations.createSubtask({ taskId: task.id, title: "Write regression coverage", description: "Board sync" });
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestUrl = `http://board.test/api/subtasks/${subtask.id}?token=secret-token`;
      const requestHeaders = { "x-trekoon-idempotency-key": "delete-subtask-1" };
      const firstResponse = await handler(new Request(requestUrl, { method: "DELETE", headers: requestHeaders }));
      const secondResponse = await handler(new Request(requestUrl, { method: "DELETE", headers: requestHeaders }));

      const firstBody = await firstResponse.json() as { data: { subtaskId: string; snapshotDelta: { deletedSubtaskIds: string[] } } };
      const secondBody = await secondResponse.json() as { data: { subtaskId: string; snapshotDelta: { deletedSubtaskIds: string[] } } };

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(secondBody.data.subtaskId).toBe(firstBody.data.subtaskId);
      expect(secondBody.data.snapshotDelta.deletedSubtaskIds).toEqual([subtask.id]);
    } finally {
      storage.close();
    }
  });

  test("keeps dependency snapshot relationships consistent across add and remove", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Stabilize shell", description: "Guard overlays" });
      const task = mutations.createTask({ epicId: epic.id, title: "Verify board", description: "Check search and scroll" });

      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const addResponse = await handler(new Request("http://board.test/api/dependencies?token=secret-token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sourceId: task.id,
          dependsOnId: blocker.id,
        }),
      }));

      const addBody = await addResponse.json() as {
        ok: boolean;
        data: {
          dependency: { id: string; sourceId: string; dependsOnId: string };
          snapshotDelta: {
            tasks: Array<{
              id: string;
              dependencyIds: string[];
              dependentIds: string[];
            }>;
            dependencies: Array<{ id: string }>;
          };
        };
      };

      expect(addResponse.status).toBe(201);
      expect(addBody.ok).toBeTrue();
      expect(addBody.data.dependency).toEqual(expect.objectContaining({
        sourceId: task.id,
        dependsOnId: blocker.id,
      }));
      expect(addBody.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({
        id: task.id,
        dependencyIds: [addBody.data.dependency.id],
      }));
      expect(addBody.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({
        id: blocker.id,
        dependentIds: [addBody.data.dependency.id],
      }));
      expect(addBody.data.snapshotDelta.dependencies).toContainEqual(expect.objectContaining({ id: addBody.data.dependency.id }));

      const removeResponse = await handler(new Request(`http://board.test/api/dependencies?token=secret-token&sourceId=${encodeURIComponent(task.id)}&dependsOnId=${encodeURIComponent(blocker.id)}`, {
        method: "DELETE",
      }));

      const removeBody = await removeResponse.json() as {
        ok: boolean;
        data: {
          removed: number;
          snapshotDelta: {
            tasks: Array<{
              id: string;
              dependencyIds: string[];
              dependentIds: string[];
            }>;
            deletedDependencyIds: string[];
          };
        };
      };

      expect(removeResponse.status).toBe(200);
      expect(removeBody.ok).toBeTrue();
      expect(removeBody.data.removed).toBe(1);
      expect(removeBody.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({
        id: task.id,
        dependencyIds: [],
      }));
      expect(removeBody.data.snapshotDelta.tasks).toContainEqual(expect.objectContaining({
        id: blocker.id,
        dependentIds: [],
      }));
      expect(removeBody.data.snapshotDelta.deletedDependencyIds).toContain(addBody.data.dependency.id);
    } finally {
      storage.close();
    }
  });

  test("retries dependency deletion idempotently when given the same client request id", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "Finish first" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const dependency = mutations.addDependency(task.id, blocker.id);
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestUrl = `http://board.test/api/dependencies?token=secret-token&sourceId=${encodeURIComponent(task.id)}&dependsOnId=${encodeURIComponent(blocker.id)}`;
      const requestHeaders = { "x-trekoon-idempotency-key": "delete-dependency-1" };
      const firstResponse = await handler(new Request(requestUrl, { method: "DELETE", headers: requestHeaders }));
      const secondResponse = await handler(new Request(requestUrl, { method: "DELETE", headers: requestHeaders }));

      const firstBody = await firstResponse.json() as { data: { removed: number; snapshotDelta: { deletedDependencyIds: string[] } } };
      const secondBody = await secondResponse.json() as { data: { removed: number; snapshotDelta: { deletedDependencyIds: string[] } } };

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(firstBody.data.removed).toBe(1);
      expect(secondBody.data.removed).toBe(1);
      expect(secondBody.data.snapshotDelta.deletedDependencyIds).toContain(dependency.id);
    } finally {
      storage.close();
    }
  });

  test("rejects reusing a dependency delete idempotency key for a different request target", async (): Promise<void> => {
    const cwd = createWorkspace();
    const storage = openTrekoonDatabase(cwd);

    try {
      const mutations = new MutationService(storage.db, cwd);
      const epic = mutations.createEpic({ title: "Roadmap", description: "Plan release" });
      const blocker = mutations.createTask({ epicId: epic.id, title: "Blocker", description: "Finish first" });
      const task = mutations.createTask({ epicId: epic.id, title: "Implement", description: "Ship board" });
      const otherTask = mutations.createTask({ epicId: epic.id, title: "Review", description: "Check board" });
      mutations.addDependency(task.id, blocker.id);
      mutations.addDependency(otherTask.id, blocker.id);
      const handler = createBoardApiHandler({ db: storage.db, cwd, token: "secret-token" });

      const requestHeaders = { "x-trekoon-idempotency-key": "delete-dependency-target-1" };
      const firstResponse = await handler(new Request(`http://board.test/api/dependencies?token=secret-token&sourceId=${encodeURIComponent(task.id)}&dependsOnId=${encodeURIComponent(blocker.id)}`, {
        method: "DELETE",
        headers: requestHeaders,
      }));
      expect(firstResponse.status).toBe(200);

      const secondResponse = await handler(new Request(`http://board.test/api/dependencies?token=secret-token&sourceId=${encodeURIComponent(otherTask.id)}&dependsOnId=${encodeURIComponent(blocker.id)}`, {
        method: "DELETE",
        headers: requestHeaders,
      }));
      const secondBody = await secondResponse.json() as { error: { code: string; message: string } };

      expect(secondResponse.status).toBe(400);
      expect(secondBody.error).toEqual(expect.objectContaining({
        code: "invalid_input",
        message: "Idempotency key cannot be reused for a different dependency delete request",
      }));
      expect(new TrackerDomain(storage.db).listDependencies(otherTask.id)).toHaveLength(1);
    } finally {
      storage.close();
    }
  });
});
