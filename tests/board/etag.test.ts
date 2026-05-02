import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startBoardServer, type BoardServerInfo } from "../../src/board/server";
import { resolveStoragePaths } from "../../src/storage/path";
import { openTrekoonDatabase, type TrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-etag-"));
  tempDirs.push(workspace);
  return workspace;
}

function prepareBoardAssets(workspace: string): void {
  const paths = resolveStoragePaths(workspace);
  mkdirSync(dirname(paths.boardEntryFile), { recursive: true });
  writeFileSync(paths.boardEntryFile, "<html><body>board</body></html>\n", "utf8");
}

interface SeedResult {
  readonly epicId: string;
  readonly taskId: string;
  readonly subtaskId: string;
}

function seed(workspace: string): SeedResult {
  const database: TrekoonDatabase = openTrekoonDatabase(workspace);
  try {
    const mutations = new MutationService(database.db, workspace);
    const epic = mutations.createEpic({ title: "If-Match Epic", description: "Seed epic" });
    const task = mutations.createTask({ epicId: epic.id, title: "If-Match Task", description: "Seed task" });
    const subtask = mutations.createSubtask({ taskId: task.id, title: "If-Match Subtask", description: "Seed subtask" });
    return { epicId: epic.id, taskId: task.id, subtaskId: subtask.id };
  } finally {
    database.close();
  }
}

let workspace: string = "";
let boardServer: BoardServerInfo | null = null;
let seeded: SeedResult = { epicId: "", taskId: "", subtaskId: "" };

beforeEach((): void => {
  workspace = createWorkspace();
  prepareBoardAssets(workspace);
  seeded = seed(workspace);
  boardServer = startBoardServer({ cwd: workspace, token: "etag-token" });
});

afterEach((): void => {
  if (boardServer) {
    boardServer.stop();
    boardServer = null;
  }
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

function authedUrl(path: string): string {
  if (!boardServer) {
    throw new Error("Board server not initialized");
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${boardServer.origin}${path}${sep}token=etag-token`;
}

function readUpdatedAt(entityKind: "epic" | "task" | "subtask", id: string): number {
  const database = openTrekoonDatabase(workspace);
  try {
    const domain = new TrackerDomain(database.db);
    if (entityKind === "epic") {
      return domain.getEpicOrThrow(id).updatedAt;
    }
    if (entityKind === "task") {
      return domain.getTaskOrThrow(id).updatedAt;
    }
    return domain.getSubtaskOrThrow(id).updatedAt;
  } finally {
    database.close();
  }
}

describe("board PATCH If-Match preconditions", (): void => {
  test("PATCH /api/epics/:id without If-Match still succeeds (backward compatible)", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Epic" }),
    });
    expect(response.status).toBe(200);
  });

  test("PATCH /api/epics/:id with matching If-Match succeeds", async (): Promise<void> => {
    const updatedAt = readUpdatedAt("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(updatedAt),
      },
      body: JSON.stringify({ title: "Matched Rename" }),
    });
    expect(response.status).toBe(200);
  });

  test("PATCH /api/epics/:id with stale If-Match returns 409 with currentUpdatedAt", async (): Promise<void> => {
    const updatedAt = readUpdatedAt("epic", seeded.epicId);
    const staleTimestamp = updatedAt - 1;
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(staleTimestamp),
      },
      body: JSON.stringify({ title: "Should Not Apply" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("epic");
    expect(body.error.details.entityId).toBe(seeded.epicId);
    expect(body.error.details.currentUpdatedAt).toBe(updatedAt);
    expect(body.error.details.providedUpdatedAt).toBe(staleTimestamp);
  });

  test("PATCH /api/tasks/:id with stale If-Match returns 409", async (): Promise<void> => {
    const updatedAt = readUpdatedAt("task", seeded.taskId);
    const response = await fetch(authedUrl(`/api/tasks/${encodeURIComponent(seeded.taskId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(updatedAt - 100),
      },
      body: JSON.stringify({ title: "Stale" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("task");
    expect(body.error.details.currentUpdatedAt).toBe(updatedAt);
  });

  test("PATCH /api/subtasks/:id with stale If-Match returns 409", async (): Promise<void> => {
    const updatedAt = readUpdatedAt("subtask", seeded.subtaskId);
    const response = await fetch(authedUrl(`/api/subtasks/${encodeURIComponent(seeded.subtaskId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(updatedAt - 100),
      },
      body: JSON.stringify({ title: "Stale" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("subtask");
  });

  test("PATCH /api/epics/:id/cascade with stale If-Match returns 409", async (): Promise<void> => {
    const updatedAt = readUpdatedAt("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}/cascade`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(updatedAt - 100),
      },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("epic");
  });

  test("PATCH with malformed If-Match header returns 400", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": "not-a-number",
      },
      body: JSON.stringify({ title: "Bad header" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_input");
  });

  test("PATCH /api/epics/:id with quoted If-Match value matches", async (): Promise<void> => {
    const updatedAt = readUpdatedAt("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `"${updatedAt}"`,
      },
      body: JSON.stringify({ title: "Quoted If-Match" }),
    });
    expect(response.status).toBe(200);
  });

  // Trekoon task 02a08a41-93a9-4c30-95be-0f9bf2478632 / system-hardening-0.4.2
  // P0 finding 2: previously the route layer issued the If-Match check
  // BEFORE entering the write transaction, so two concurrent PATCHes that
  // each saw the same `updatedAt` could both pass the check and the second
  // one would silently overwrite the first. The CAS variants in
  // MutationService now perform the precondition INSIDE
  // BEGIN IMMEDIATE — exactly one writer can win the race.
  test("two concurrent PATCHes with same If-Match: exactly one returns 200, the other returns 409 with advanced currentUpdatedAt", async (): Promise<void> => {
    const baselineUpdatedAt = readUpdatedAt("task", seeded.taskId);

    const issuePatch = (label: string): Promise<Response> =>
      fetch(authedUrl(`/api/tasks/${encodeURIComponent(seeded.taskId)}`), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": String(baselineUpdatedAt),
        },
        body: JSON.stringify({ title: `Concurrent rename: ${label}` }),
      });

    // Fire both PATCHes from the same loop tick so they race for the
    // BEGIN IMMEDIATE lock. SQLite serialises them; the late writer
    // observes the now-advanced updated_at and the SQL CAS clause
    // produces zero affected rows -> PreconditionFailedError -> 409.
    const [responseA, responseB] = await Promise.all([
      issuePatch("A"),
      issuePatch("B"),
    ]);

    const statuses = [responseA.status, responseB.status].sort((a, b) => a - b);
    expect(statuses).toEqual([200, 409]);

    const losingResponse = responseA.status === 409 ? responseA : responseB;
    const conflictBody = await losingResponse.json();
    expect(conflictBody.ok).toBe(false);
    expect(conflictBody.error.code).toBe("precondition_failed");
    expect(conflictBody.error.details.entityKind).toBe("task");
    expect(conflictBody.error.details.entityId).toBe(seeded.taskId);
    expect(conflictBody.error.details.providedUpdatedAt).toBe(baselineUpdatedAt);
    // Losing reader observes the freshly-advanced updatedAt: strictly
    // greater than the baseline they sent (the winner bumped it).
    expect(conflictBody.error.details.currentUpdatedAt).toBeGreaterThan(baselineUpdatedAt);

    // And exactly one row update landed: the persisted updatedAt should
    // match the value the losing 409 reported.
    const persistedUpdatedAt = readUpdatedAt("task", seeded.taskId);
    expect(persistedUpdatedAt).toBe(conflictBody.error.details.currentUpdatedAt);
  });
});
