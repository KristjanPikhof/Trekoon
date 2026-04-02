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
});
