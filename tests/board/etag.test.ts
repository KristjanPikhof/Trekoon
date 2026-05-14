import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { startBoardServer, type BoardServerInfo } from "../../src/board/server";
import { openTrekoonDatabase, type TrekoonDatabase } from "../../src/storage/database";
import { MutationService } from "../../src/domain/mutation-service";
import { TrackerDomain } from "../../src/domain/tracker-domain";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-etag-"));
  tempDirs.push(workspace);
  return workspace;
}

function prepareBoardAssets(_workspace: string): { assetRoot: string } {
  const assetRoot: string = mkdtempSync(join(tmpdir(), "trekoon-board-etag-assets-"));
  tempDirs.push(assetRoot);
  writeFileSync(join(assetRoot, "index.html"), "<html><body>board</body></html>\n", "utf8");
  return { assetRoot };
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
const nativeFetch = globalThis.fetch;

function fetch(
  input: Parameters<typeof globalThis.fetch>[0],
  init?: Parameters<typeof globalThis.fetch>[1],
): ReturnType<typeof globalThis.fetch> {
  const headers = new Headers(init?.headers);
  headers.set("authorization", "Bearer etag-token");
  return nativeFetch(input, { ...init, headers });
}

beforeEach((): void => {
  workspace = createWorkspace();
  const { assetRoot } = prepareBoardAssets(workspace);
  seeded = seed(workspace);
  boardServer = startBoardServer({ cwd: workspace, token: "etag-token", assetRootOverride: assetRoot });
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
  return `${boardServer.origin}${path}`;
}

function readVersion(entityKind: "epic" | "task" | "subtask", id: string): number {
  const database = openTrekoonDatabase(workspace);
  try {
    const domain = new TrackerDomain(database.db);
    if (entityKind === "epic") {
      return domain.getEpicOrThrow(id).version;
    }
    if (entityKind === "task") {
      return domain.getTaskOrThrow(id).version;
    }
    return domain.getSubtaskOrThrow(id).version;
  } finally {
    database.close();
  }
}

describe("board PATCH If-Match preconditions", (): void => {
  test("PATCH /api/epics/:id without If-Match returns 428 Precondition Required", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Epic" }),
    });
    expect(response.status).toBe(428);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("precondition_required");
  });

  test("PATCH /api/tasks/:id without If-Match returns 428 Precondition Required", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/tasks/${encodeURIComponent(seeded.taskId)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Task" }),
    });
    expect(response.status).toBe(428);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("precondition_required");
  });

  test("PATCH /api/subtasks/:id without If-Match returns 428 Precondition Required", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/subtasks/${encodeURIComponent(seeded.subtaskId)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Renamed Subtask" }),
    });
    expect(response.status).toBe(428);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("precondition_required");
  });

  test("PATCH /api/epics/:id/cascade without If-Match returns 428 Precondition Required", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}/cascade`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(response.status).toBe(428);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("precondition_required");
  });

  test("PATCH /api/epics/:id with matching If-Match succeeds", async (): Promise<void> => {
    const version = readVersion("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(version),
      },
      body: JSON.stringify({ title: "Matched Rename" }),
    });
    expect(response.status).toBe(200);
  });

  test("PATCH /api/epics/:id with stale If-Match returns 409 with currentVersion", async (): Promise<void> => {
    const version = readVersion("epic", seeded.epicId);
    const staleVersion = version - 1;
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(staleVersion),
      },
      body: JSON.stringify({ title: "Should Not Apply" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("epic");
    expect(body.error.details.entityId).toBe(seeded.epicId);
    expect(body.error.details.currentVersion).toBe(version);
    expect(body.error.details.providedVersion).toBe(staleVersion);
  });

  test("PATCH /api/tasks/:id with stale If-Match returns 409", async (): Promise<void> => {
    const version = readVersion("task", seeded.taskId);
    const response = await fetch(authedUrl(`/api/tasks/${encodeURIComponent(seeded.taskId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(version - 1),
      },
      body: JSON.stringify({ title: "Stale" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("task");
    expect(body.error.details.currentVersion).toBe(version);
  });

  test("PATCH /api/subtasks/:id with stale If-Match returns 409", async (): Promise<void> => {
    const version = readVersion("subtask", seeded.subtaskId);
    const response = await fetch(authedUrl(`/api/subtasks/${encodeURIComponent(seeded.subtaskId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(version - 1),
      },
      body: JSON.stringify({ title: "Stale" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("precondition_failed");
    expect(body.error.details.entityKind).toBe("subtask");
  });

  test("PATCH /api/epics/:id/cascade with stale If-Match returns 409", async (): Promise<void> => {
    const version = readVersion("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}/cascade`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": String(version - 1),
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
    const version = readVersion("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `"${version}"`,
      },
      body: JSON.stringify({ title: "Quoted If-Match" }),
    });
    expect(response.status).toBe(200);
  });

  test("PATCH /api/epics/:id with W/-prefixed weak ETag matches", async (): Promise<void> => {
    const version = readVersion("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `W/"${version}"`,
      },
      body: JSON.stringify({ title: "Weak ETag Rename" }),
    });
    expect(response.status).toBe(200);
  });

  test("PATCH /api/epics/:id with bare W/<digits> weak ETag matches", async (): Promise<void> => {
    const version = readVersion("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `W/${version}`,
      },
      body: JSON.stringify({ title: "Weak ETag Bare" }),
    });
    expect(response.status).toBe(200);
  });

  test("PATCH /api/epics/:id with W/-prefixed stale ETag returns 409", async (): Promise<void> => {
    const version = readVersion("epic", seeded.epicId);
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": `W/"${version - 1}"`,
      },
      body: JSON.stringify({ title: "Should Not Apply" }),
    });
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("precondition_failed");
  });

  test("PATCH /api/epics/:id with `*` wildcard If-Match returns 400 (not supported)", async (): Promise<void> => {
    const response = await fetch(authedUrl(`/api/epics/${encodeURIComponent(seeded.epicId)}`), {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "if-match": "*",
      },
      body: JSON.stringify({ title: "Star Header" }),
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_input");
    expect(String(body.error.message)).toContain("wildcard");
  });

  // Trekoon task 02a08a41-93a9-4c30-95be-0f9bf2478632 / system-hardening-0.4.2
  // P0 finding 2: previously the route layer issued the If-Match check
  // BEFORE entering the write transaction, so two concurrent PATCHes that
  // each saw the same token could both pass the check and the second
  // one would silently overwrite the first. The CAS variants in
  // MutationService now perform the precondition INSIDE
  // BEGIN IMMEDIATE — exactly one writer can win the race.
  test("two concurrent PATCHes with same If-Match: exactly one returns 200, the other returns 409 with advanced currentVersion", async (): Promise<void> => {
    const baselineVersion = readVersion("task", seeded.taskId);

    const issuePatch = (label: string): Promise<Response> =>
      fetch(authedUrl(`/api/tasks/${encodeURIComponent(seeded.taskId)}`), {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": String(baselineVersion),
        },
        body: JSON.stringify({ title: `Concurrent rename: ${label}` }),
      });

    // Fire both PATCHes from the same loop tick so they race for the
    // BEGIN IMMEDIATE lock. SQLite serialises them; the late writer
    // observes the now-advanced version and the SQL CAS clause
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
    expect(conflictBody.error.details.providedVersion).toBe(baselineVersion);
    // Losing reader observes the freshly-advanced version: strictly greater
    // than the baseline they sent (the winner bumped it).
    expect(conflictBody.error.details.currentVersion).toBeGreaterThan(baselineVersion);

    // And exactly one row update landed: the persisted version should
    // match the value the losing 409 reported.
    const persistedVersion = readVersion("task", seeded.taskId);
    expect(persistedVersion).toBe(conflictBody.error.details.currentVersion);
  });
});
