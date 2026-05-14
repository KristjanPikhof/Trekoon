import { afterEach, describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createApi } from "../../src/board/assets/state/api.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createBoardActions } from "../../src/board/assets/state/actions.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { normalizeSnapshot, normalizeStatus } from "../../src/board/assets/state/utils.js";

type StorageShape = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

function createMockStorage(seed: Record<string, string> = {}): StorageShape {
  const values = new Map(Object.entries(seed));
  return {
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  if (originalFetch === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
  } else {
    globalThis.fetch = originalFetch;
  }
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    globalThis.localStorage = originalLocalStorage;
  }
});

function waitForQueueTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

describe("lazy If-Match resolution via normalized store", () => {
  test("normalizeSnapshot carries version on every epic/task/subtask", () => {
    const snapshot = normalizeSnapshot({
      epics: [{ id: "epic-1", title: "E", status: "todo", version: 4 }],
      tasks: [{ id: "task-1", epicId: "epic-1", title: "T", status: "todo", version: 7 }],
      subtasks: [{ id: "sub-1", taskId: "task-1", title: "S", status: "todo", version: 2 }],
      dependencies: [],
    });

    expect(snapshot.epics[0].version).toBe(4);
    expect(snapshot.tasks[0].version).toBe(7);
    expect(snapshot.subtasks[0].version).toBe(2);
  });

  test("invalid version inputs are dropped to null without throwing", () => {
    const snapshot = normalizeSnapshot({
      epics: [{ id: "epic-1", title: "E", status: "todo", version: "not-a-number" }],
      tasks: [{ id: "task-1", epicId: "epic-1", title: "T", status: "todo", version: -1 }],
      subtasks: [{ id: "sub-1", taskId: "task-1", title: "S", status: "todo", version: 1.5 }],
      dependencies: [],
    });

    expect(snapshot.epics[0].version).toBeNull();
    expect(snapshot.tasks[0].version).toBeNull();
    expect(snapshot.subtasks[0].version).toBeNull();
  });

  test("submitTaskForm emits If-Match header read lazily from the normalized snapshot", async () => {
    globalThis.localStorage = createMockStorage() as Storage;
    const fetchMock = mock(() => Promise.resolve(jsonResponse(200, { ok: true, data: { snapshotDelta: { tasks: [] } } })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const model = createStore({
      epics: [{ id: "epic-1", title: "E", status: "todo", version: 1 }],
      tasks: [{ id: "task-1", epicId: "epic-1", title: "Original", status: "todo", description: "", version: 7 }],
      subtasks: [],
      dependencies: [],
    });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    const actions = createBoardActions({
      model,
      api,
      rerender: () => {},
      normalizeSnapshot,
      normalizeStatus,
      applyTheme: () => {},
    });

    const fd = new FormData();
    fd.set("title", "Renamed");
    fd.set("description", "");
    fd.set("status", "todo");
    actions.submitTaskForm("task-1", fd);

    await waitForQueueTurn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("if-match")).toBe("7");
  });

  test("rapid double-edit on the same task does NOT 409 on the second request", async () => {
    globalThis.localStorage = createMockStorage() as Storage;
    let callIndex = 0;
    const fetchMock = mock(() => {
      callIndex += 1;
      // First call: server advanced task to version 8 and returned it in the delta.
      // Second call: the queue must have read version 8 from the store, not the
      // stale 7 captured at enqueue time.
      if (callIndex === 1) {
        return Promise.resolve(jsonResponse(200, {
          ok: true,
          data: { snapshotDelta: { tasks: [{ id: "task-1", epicId: "epic-1", title: "Renamed", status: "todo", description: "", version: 8 }] } },
        }));
      }
      return Promise.resolve(jsonResponse(200, {
        ok: true,
        data: { snapshotDelta: { tasks: [{ id: "task-1", epicId: "epic-1", title: "Renamed twice", status: "todo", description: "", version: 9 }] } },
      }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const model = createStore({
      epics: [{ id: "epic-1", title: "E", status: "todo", version: 1 }],
      tasks: [{ id: "task-1", epicId: "epic-1", title: "Original", status: "todo", description: "", version: 7 }],
      subtasks: [],
      dependencies: [],
    });
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    const actions = createBoardActions({
      model,
      api,
      rerender: () => {},
      normalizeSnapshot,
      normalizeStatus,
      applyTheme: () => {},
    });

    const fd1 = new FormData();
    fd1.set("title", "Renamed");
    fd1.set("description", "");
    fd1.set("status", "todo");
    actions.submitTaskForm("task-1", fd1);

    const fd2 = new FormData();
    fd2.set("title", "Renamed twice");
    fd2.set("description", "");
    fd2.set("status", "todo");
    // Enqueue the second mutation IMMEDIATELY, before the first resolves.
    actions.submitTaskForm("task-1", fd2);

    // Let both queue turns drain.
    await waitForQueueTurn();
    await waitForQueueTurn();
    await waitForQueueTurn();

    // Debug: snapshot state after queue drain
    const task = model.getSnapshot().tasks.find((t: { id: string }) => t.id === "task-1");
    expect(task?.version).toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    // First call used the original version 7.
    expect(new Headers(calls[0]![1].headers).get("if-match")).toBe("7");
    // Second call MUST observe the post-success version 8 from the snapshot,
    // not the stale enqueue-time read.
    expect(new Headers(calls[1]![1].headers).get("if-match")).toBe("8");
  });
});
