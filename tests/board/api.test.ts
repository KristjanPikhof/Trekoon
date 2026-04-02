import { afterEach, describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createApi, createMutationQueue } from "../../src/board/assets/state/api.js";

type Snapshot = {
  epics: unknown[];
  tasks: unknown[];
  subtasks: unknown[];
  dependencies: unknown[];
};

type TaskSnapshot = {
  epics: unknown[];
  tasks: Array<{ id: string; title: string }>;
  subtasks: unknown[];
  dependencies: unknown[];
};

type Notice = {
  type: string;
  message: string;
  title?: string;
  retryLabel?: string;
  retryMutationId?: number;
} | null;

const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalFetch === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
    return;
  }

  globalThis.fetch = originalFetch;
});

describe("mutation queue", () => {
  test("flush resolves after the pending mutation queue drains", async () => {
    let resolveRequest: (value?: { snapshot?: Snapshot }) => void = () => {};
    const rerenders: number[] = [];
    const initialSnapshot: Snapshot = {
      epics: [],
      tasks: [],
      subtasks: [],
      dependencies: [],
    };
    const model = {
      store: {
        snapshot: initialSnapshot,
        notice: null as Notice,
        isMutating: false,
      },
      replaceSnapshot(snapshot: Snapshot) {
        this.store.snapshot = snapshot;
      },
      applySnapshotDelta(delta: Snapshot) {
        this.store.snapshot = { ...this.store.snapshot, ...delta };
      },
    };
    const queue = createMutationQueue(model, () => {
      rerenders.push(rerenders.length + 1);
    });

    queue.enqueue({
      successMessage: "Task saved.",
      request: () => new Promise((resolve) => {
        resolveRequest = resolve;
      }),
    });

    const flushPromise = queue.flush();
    expect(queue.isPending).toBe(true);
    expect(model.store.isMutating).toBe(true);

    resolveRequest({});
    await flushPromise;

    expect(queue.isPending).toBe(false);
    expect(model.store.isMutating).toBe(false);
    expect(model.store.notice).toEqual({ type: "success", message: "Task saved." });
    expect(rerenders.length).toBeGreaterThan(0);
  });

  test("keeps later queued actions after one mutation fails", async () => {
    let firstResolved = false;
    const initialSnapshot: TaskSnapshot = {
      epics: [],
      tasks: [{ id: "task-1", title: "Original" }],
      subtasks: [],
      dependencies: [],
    };
    const model = {
      store: {
        snapshot: initialSnapshot,
        notice: null as Notice,
        isMutating: false,
      },
      replaceSnapshot(snapshot: TaskSnapshot) {
        this.store.snapshot = snapshot;
      },
      applySnapshotDelta(delta: TaskSnapshot) {
        this.store.snapshot = { ...this.store.snapshot, ...delta };
      },
    };
    const queue = createMutationQueue(model, () => {});

    queue.enqueue({
      optimistic(snapshot: TaskSnapshot) {
        const [task] = snapshot.tasks;
        if (task) task.title = "First optimistic";
        return snapshot;
      },
      request: async () => {
        firstResolved = true;
        throw new Error("PATCH /api/tasks/task-1 failed");
      },
    });
    queue.enqueue({
      optimistic(snapshot: TaskSnapshot) {
        const [task] = snapshot.tasks;
        if (task) task.title = "Second optimistic";
        return snapshot;
      },
      request: async () => ({
        snapshot: {
          epics: [],
          tasks: [{ id: "task-1", title: "Second saved" }],
          subtasks: [],
          dependencies: [],
        },
      }),
      successMessage: "Task saved.",
    });

    await queue.flush();

    expect(firstResolved).toBe(true);
    expect(model.store.snapshot.tasks[0]?.title).toBe("Second saved");
    expect(model.store.notice).toEqual({ type: "success", message: "Task saved." });
  });

  test("aborts requests after the explicit timeout and supports retry", async () => {
    const fetchMock = mock((_path: string, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(options.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const emptySnapshot: Snapshot = { epics: [], tasks: [], subtasks: [], dependencies: [] };
    const model = {
      store: {
        snapshot: emptySnapshot,
        notice: null as Notice,
        isMutating: false,
      },
      replaceSnapshot(snapshot: Snapshot) {
        this.store.snapshot = snapshot;
      },
      applySnapshotDelta(delta: Snapshot) {
        this.store.snapshot = { ...this.store.snapshot, ...delta };
      },
    };
    const api = createApi(model, { sessionToken: "", rerender: () => {}, requestTimeoutMs: 10 });

    api.patchTask("task-1", { title: "Retry me" }, (snapshot: Snapshot) => snapshot);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(model.store.notice?.retryLabel).toBe("Retry");
    expect(model.store.notice?.message).toContain("timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const didRetry = api.retryLastFailedMutation();

    expect(didRetry).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries createSubtask with a stable client request id", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      data: {
        snapshotDelta: {
          subtasks: [],
        },
      },
    }), {
      status: 201,
      headers: {
        "content-type": "application/json",
      },
    })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const emptySnapshot: Snapshot = { epics: [], tasks: [], subtasks: [], dependencies: [] };
    const model = {
      store: {
        snapshot: emptySnapshot,
        notice: null as Notice,
        isMutating: false,
      },
      replaceSnapshot(snapshot: Snapshot) {
        this.store.snapshot = snapshot;
      },
      applySnapshotDelta(delta: Snapshot) {
        this.store.snapshot = { ...this.store.snapshot, ...delta };
      },
    };
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    api.createSubtask({ taskId: "task-1", title: "Write tests", description: "", status: "todo" }, (snapshot: Snapshot) => snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const didRetry = api.retryLastFailedMutation();

    expect(didRetry).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const [, firstOptions] = firstCall;
    const firstBody = JSON.parse(String(firstOptions.body)) as { clientRequestId: string };
    const headers = new Headers(firstOptions.headers);
    expect(headers.get("x-trekoon-idempotency-key")).toBe(firstBody.clientRequestId);
  });

  test("uses stable idempotency keys for delete retries", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      data: {
        snapshotDelta: {
          deletedSubtaskIds: [],
          deletedDependencyIds: [],
        },
      },
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const emptySnapshot: Snapshot = { epics: [], tasks: [], subtasks: [], dependencies: [] };
    const model = {
      store: {
        snapshot: emptySnapshot,
        notice: null as Notice,
        isMutating: false,
      },
      replaceSnapshot(snapshot: Snapshot) {
        this.store.snapshot = snapshot;
      },
      applySnapshotDelta(delta: Snapshot) {
        this.store.snapshot = { ...this.store.snapshot, ...delta };
      },
    };
    const api = createApi(model, { sessionToken: "", rerender: () => {} });

    api.deleteSubtask("subtask-1", (snapshot: Snapshot) => snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));
    api.removeDependency("task-1", "task-2", (snapshot: Snapshot) => snapshot);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const deleteHeaders = new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers);
    const removeHeaders = new Headers((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers);

    expect(deleteHeaders.get("x-trekoon-idempotency-key")).toBeString();
    expect(removeHeaders.get("x-trekoon-idempotency-key")).toBeString();
    expect(deleteHeaders.get("x-trekoon-idempotency-key")).not.toBe(removeHeaders.get("x-trekoon-idempotency-key"));
  });

  test("retries addDependency with a stable idempotency key", async () => {
    const fetchMock = mock((_path: string, options?: RequestInit) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => {
        reject(options.signal?.reason ?? new Error("aborted"));
      }, { once: true });
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const emptySnapshot: Snapshot = { epics: [], tasks: [], subtasks: [], dependencies: [] };
    const model = {
      store: {
        snapshot: emptySnapshot,
        notice: null as Notice,
        isMutating: false,
      },
      replaceSnapshot(snapshot: Snapshot) {
        this.store.snapshot = snapshot;
      },
      applySnapshotDelta(delta: Snapshot) {
        this.store.snapshot = { ...this.store.snapshot, ...delta };
      },
    };
    const api = createApi(model, { sessionToken: "", rerender: () => {}, requestTimeoutMs: 10 });

    api.addDependency("task-1", "task-2", (snapshot: Snapshot) => snapshot);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(api.retryLastFailedMutation()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const secondCall = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    const firstHeaders = new Headers(firstCall[1].headers);
    const secondHeaders = new Headers(secondCall[1].headers);
    const firstBody = JSON.parse(String(firstCall[1].body)) as { clientRequestId: string; sourceId: string; dependsOnId: string };
    const secondBody = JSON.parse(String(secondCall[1].body)) as { clientRequestId: string; sourceId: string; dependsOnId: string };

    expect(firstHeaders.get("x-trekoon-idempotency-key")).toBe(firstBody.clientRequestId);
    expect(secondHeaders.get("x-trekoon-idempotency-key")).toBe(secondBody.clientRequestId);
    expect(firstBody).toEqual(secondBody);
  });
});
