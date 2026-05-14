import { afterEach, describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createApi } from "../../src/board/assets/state/api.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { applySnapshotDelta } from "../../src/board/assets/state/utils.js";

type Snapshot = {
  generatedAt: number | null;
  epics: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  subtasks: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
};

type Notice = {
  type: string;
  message: string;
  title?: string;
  retryLabel?: string;
  retryMutationId?: string;
} | null;

function emptySnapshot(): Snapshot {
  return { generatedAt: null, epics: [], tasks: [], subtasks: [], dependencies: [] };
}

function createTestModel(initial: Snapshot) {
  return {
    store: { snapshot: initial, notice: null as Notice, isMutating: false },
    replaceSnapshot(snapshot: Snapshot) {
      this.store.snapshot = snapshot;
    },
    applySnapshotDelta(delta: Record<string, unknown>) {
      this.store.snapshot = applySnapshotDelta(this.store.snapshot, delta);
    },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalFetch === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
    return;
  }
  globalThis.fetch = originalFetch;
});

function waitForQueueTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe("client If-Match header", () => {
  test("patchTask emits bare integer If-Match header when version is provided", async () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse(200, { ok: true, data: { snapshotDelta: { tasks: [] } } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const model = createTestModel({ ...emptySnapshot(), tasks: [{ id: "task-1", title: "T", status: "todo", version: 7 }] });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    api.patchTask("task-1", { title: "Renamed" }, (snap: Snapshot) => snap, { ifMatchVersion: 7 });
    await waitForQueueTurn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("if-match")).toBe("7");
  });

  test("patchEpic, patchSubtask, and cascadeEpicStatus all emit the If-Match header", async () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse(200, { ok: true, data: { snapshotDelta: {} } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const model = createTestModel(emptySnapshot());
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    api.patchEpic("epic-1", { status: "todo" }, (snap: Snapshot) => snap, { ifMatchVersion: 1 });
    await waitForQueueTurn();
    api.patchSubtask("sub-1", { status: "done" }, (snap: Snapshot) => snap, { ifMatchVersion: 3 });
    await waitForQueueTurn();
    api.cascadeEpicStatus("epic-1", "done", (snap: Snapshot) => snap, { ifMatchVersion: 12 });
    await waitForQueueTurn();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const first = calls[0];
    const second = calls[1];
    const third = calls[2];
    if (!first || !second || !third) {
      throw new Error("Expected three captured fetch calls");
    }
    expect(new Headers(first[1].headers).get("if-match")).toBe("1");
    expect(new Headers(second[1].headers).get("if-match")).toBe("3");
    expect(new Headers(third[1].headers).get("if-match")).toBe("12");
  });

  test("omits If-Match when version is undefined (server back-compat path)", async () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse(200, { ok: true, data: { snapshotDelta: { tasks: [] } } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const model = createTestModel({ ...emptySnapshot(), tasks: [{ id: "task-1", title: "T", status: "todo" }] });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    api.patchTask("task-1", { title: "Renamed" }, (snap: Snapshot) => snap);
    await waitForQueueTurn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.has("if-match")).toBe(false);
  });

  test("ignores non-integer / negative versions instead of emitting a malformed header", async () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse(200, { ok: true, data: { snapshotDelta: { tasks: [] } } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const model = createTestModel({ ...emptySnapshot(), tasks: [{ id: "task-1", title: "T", status: "todo" }] });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    api.patchTask("task-1", { title: "Renamed" }, (snap: Snapshot) => snap, { ifMatchVersion: -1 });
    await waitForQueueTurn();
    api.patchTask("task-1", { title: "Renamed again" }, (snap: Snapshot) => snap, { ifMatchVersion: 1.5 });
    await waitForQueueTurn();
    api.patchTask("task-1", { title: "Renamed yet again" }, (snap: Snapshot) => snap, { ifMatchVersion: "7" as unknown as number });
    await waitForQueueTurn();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls as unknown as Array<[string, RequestInit]>) {
      expect(new Headers(call[1].headers).has("if-match")).toBe(false);
    }
  });
});

describe("409 precondition_failed rollback", () => {
  test("stale If-Match returns 409 and queue applies inverse delta to restore original task", async () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse(409, {
      ok: false,
      error: {
        code: "precondition_failed",
        message: "If-Match version does not match current version",
        details: { entityKind: "task", entityId: "task-1", currentVersion: 9, providedVersion: 7 },
      },
    })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const original = { id: "task-1", title: "Original", status: "todo", description: "", epicId: "epic-1", version: 7 };
    const model = createTestModel({ ...emptySnapshot(), tasks: [original] });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    // Optimistic mutation: rename the task.
    api.patchTask(
      "task-1",
      { title: "Renamed" },
      (snap: Snapshot) => {
        const next = { ...snap, tasks: snap.tasks.map((task) => ({ ...task })) };
        const target = next.tasks.find((task) => task.id === "task-1");
        if (target) target.title = "Renamed";
        return next;
      },
      { ifMatchVersion: 7 },
    );
    await waitForQueueTurn();

    // Verify server-rejected 409 surfaces as a typed stale_version notice
    // (not a generic error) so the UI can offer the right recovery affordance.
    expect(model.store.notice?.type).toBe("warning");
    expect((model.store.notice as { code?: string } | null)?.code).toBe("stale_version");
    expect(model.store.notice?.message?.toLowerCase()).toContain("refresh");

    // Inverse delta must restore the original title and version on the optimistic record.
    const taskAfter = model.store.snapshot.tasks.find((task) => task.id === "task-1") as Record<string, unknown> | undefined;
    expect(taskAfter?.title).toBe("Original");
    expect(taskAfter?.version).toBe(7);
  });

  test("unrelated server-pushed delta on a different entity survives a 409 rollback", async () => {
    const fetchMock = mock(() => Promise.resolve(jsonResponse(409, {
      ok: false,
      error: {
        code: "precondition_failed",
        message: "If-Match version does not match current version",
        details: { entityKind: "task", entityId: "task-1", currentVersion: 5, providedVersion: 3 },
      },
    })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const task = { id: "task-1", title: "Original", status: "todo", description: "", epicId: "epic-1", version: 3 };
    const otherTask = { id: "task-2", title: "Other", status: "todo", description: "", epicId: "epic-1", version: 1 };
    const model = createTestModel({ ...emptySnapshot(), tasks: [task, otherTask] });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    // Optimistic rename of task-1.
    api.patchTask(
      "task-1",
      { title: "Renamed" },
      (snap: Snapshot) => {
        const next = { ...snap, tasks: snap.tasks.map((entry) => ({ ...entry })) };
        const target = next.tasks.find((entry) => entry.id === "task-1");
        if (target) target.title = "Renamed";
        return next;
      },
      { ifMatchVersion: 3 },
    );

    // While the request is in flight, simulate an SSE-pushed delta on task-2.
    model.applySnapshotDelta({ tasks: [{ id: "task-2", title: "Other (pushed)", status: "todo", description: "", epicId: "epic-1", version: 2 }] });

    await waitForQueueTurn();

    // task-1 must be restored to its pre-optimistic state.
    const task1After = model.store.snapshot.tasks.find((entry) => entry.id === "task-1") as Record<string, unknown> | undefined;
    expect(task1After?.title).toBe("Original");

    // task-2 must keep the unrelated server-pushed update (inverse delta is targeted, not a wholesale replace).
    const task2After = model.store.snapshot.tasks.find((entry) => entry.id === "task-2") as Record<string, unknown> | undefined;
    expect(task2After?.title).toBe("Other (pushed)");
  });
});
