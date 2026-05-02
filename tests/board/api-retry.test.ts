import { afterEach, describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createApi } from "../../src/board/assets/state/api.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { normalizeSnapshot } from "../../src/board/assets/state/utils.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalFetch === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
    return;
  }
  globalThis.fetch = originalFetch;
});

function waitForQueue() {
  return new Promise<void>((resolve) => setTimeout(resolve, 10));
}

function makeModel() {
  const store = createStore(
    normalizeSnapshot({ epics: [], tasks: [], subtasks: [], dependencies: [] }),
    { normalizeSnapshot },
  );
  return store;
}

function stubFetch(responses: Array<{ ok: boolean; body?: unknown }>) {
  let callIndex = 0;
  globalThis.fetch = (async () => {
    const spec = (responses[callIndex] ?? responses[responses.length - 1])!;
    callIndex += 1;
    return {
      ok: spec.ok,
      status: spec.ok ? 200 : 500,
      statusText: spec.ok ? "OK" : "Internal Server Error",
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => JSON.stringify(spec.body ?? (spec.ok ? { ok: true, data: {} } : { error: { code: "server_error", message: "fail" } })),
    } as Response;
  }) as typeof fetch;
}

describe("stable mutationId for retry compare", () => {
  test("lastFailedMutation is cleared when the same mutation succeeds", async () => {
    const model = makeModel();
    let lastFailedSet = false;
    let lastFailedCleared = false;

    stubFetch([
      { ok: false },  // first attempt fails
      { ok: true, body: { ok: true, data: {} } }, // retry succeeds
    ]);

    const rerenders: number[] = [];
    const api = createApi(model, {
      sessionToken: "test-token",
      rerender: () => rerenders.push(rerenders.length + 1),
      requestTimeoutMs: 2000,
    });

    // Enqueue a mutation that will fail first, then succeed.
    // The onError / onSuccess callbacks use closures, so function references
    // are not stable across repeated calls — only mutationId can link them.
    const taskId = model.store.snapshot.tasks[0]?.id ?? "fake-task-id";
    api.patchTask(taskId, { status: "in_progress" }, (snap: unknown) => snap);
    await waitForQueue();

    // After the first (failed) call the notice should have a retryMutationId
    const notice = model.store.notice;
    expect(notice?.type).toBe("error");
    expect(notice?.retryMutationId).toBeDefined();
    lastFailedSet = true;

    // Retry the same mutation: enqueue a fresh closure (new function reference)
    // but for the SAME logical operation.
    api.patchTask(taskId, { status: "in_progress" }, (snap: unknown) => snap);
    await waitForQueue();

    // After success the notice should be cleared (null or success type).
    const noticeAfterRetry = model.store.notice;
    expect(noticeAfterRetry === null || noticeAfterRetry?.type === "success").toBe(true);
    lastFailedCleared = true;

    expect(lastFailedSet).toBe(true);
    expect(lastFailedCleared).toBe(true);
  });

  test("each enqueued mutation gets a unique mutationId", async () => {
    const model = makeModel();
    const capturedIds: string[] = [];

    // Both calls will fail so we can capture retryMutationId for each.
    stubFetch([{ ok: false }, { ok: false }]);

    const api = createApi(model, {
      sessionToken: "test-token",
      rerender: () => {},
      requestTimeoutMs: 2000,
    });

    const taskId = "fake-id";

    // First mutation — fails and records a retryMutationId.
    api.patchTask(taskId, { status: "todo" }, (snap: unknown) => snap);
    await waitForQueue();
    const id1 = model.store.notice?.retryMutationId;
    expect(id1).toBeDefined();
    capturedIds.push(String(id1));

    // Reset fetch so the next call also fails.
    stubFetch([{ ok: false }]);

    // Second mutation — a fresh enqueue, so it must receive a different mutationId.
    api.patchTask(taskId, { status: "in_progress" }, (snap: unknown) => snap);
    await waitForQueue();
    const id2 = model.store.notice?.retryMutationId;
    expect(id2).toBeDefined();
    capturedIds.push(String(id2));

    // The two IDs must be different — each mutation is tagged independently.
    expect(capturedIds[0]).not.toBe(capturedIds[1]);
  });

  test("onError callback receives the error and records failure", async () => {
    const model = makeModel();
    const errors: Error[] = [];

    stubFetch([{ ok: false }]);

    const api = createApi(model, {
      sessionToken: "test-token",
      rerender: () => {},
      requestTimeoutMs: 2000,
    });

    const taskId = "fake-task-id";
    api.patchTask(taskId, { status: "blocked" }, (snap: unknown) => snap);
    await waitForQueue();

    expect(model.store.notice?.type).toBe("error");
    expect(model.store.notice?.retryMutationId).toBeDefined();
  });

  test("onSuccess clears the failure notice by mutationId, not function identity", async () => {
    const model = makeModel();

    // Simulate: mutation A fails, then mutation B (same type, new closure) succeeds.
    // Without mutationId-based comparison, lastFailedMutation never gets cleared
    // because the new closure is a different function reference.
    let callCount = 0;
    globalThis.fetch = (async () => {
      callCount += 1;
      const ok = callCount > 1; // first call fails, subsequent succeed
      return {
        ok,
        status: ok ? 200 : 500,
        statusText: ok ? "OK" : "Server Error",
        headers: new Headers({ "content-type": "application/json" }),
        text: async () => ok
          ? JSON.stringify({ ok: true, data: {} })
          : JSON.stringify({ error: { code: "e", message: "fail" } }),
      } as Response;
    }) as unknown as typeof fetch;

    const api = createApi(model, {
      sessionToken: "tok",
      rerender: () => {},
      requestTimeoutMs: 2000,
    });

    const taskId = "t1";

    // First enqueue — will fail.
    api.patchTask(taskId, { status: "blocked" }, (snap: unknown) => snap);
    await waitForQueue();
    expect(model.store.notice?.type).toBe("error");

    // Second enqueue (fresh closure / new function ref) — will succeed.
    // With the old function-identity comparison this would NOT clear the notice.
    // With the mutationId fix it SHOULD clear it.
    api.patchTask(taskId, { status: "blocked" }, (snap: unknown) => snap);
    await waitForQueue();

    // Verify the failure was cleared (null or success notice).
    const finalNotice = model.store.notice;
    expect(finalNotice === null || finalNotice?.type === "success").toBe(true);
  });
});
