import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createMutationQueue } from "../../src/board/assets/state/api.js";

describe("mutation queue", () => {
  test("flush resolves after the pending mutation queue drains", async () => {
    let resolveRequest = (_value?: unknown) => {};
    const rerenders: number[] = [];
    const model = {
      store: {
        snapshot: {
          epics: [],
          tasks: [],
          subtasks: [],
          dependencies: [],
        },
        notice: null,
        isMutating: false,
      },
      replaceSnapshot(snapshot: unknown) {
        this.store.snapshot = snapshot;
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
});
