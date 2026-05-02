import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { subscribeSnapshotStream } from "../../src/board/assets/state/api.js";

interface MockEventSourceInstance {
  url: string;
  readyState: number;
  listeners: Map<string, Set<(event: { data?: string }) => void>>;
  closed: boolean;
  onerror: (() => void) | null;
  emit(eventName: string, data: unknown): void;
}

function createMockEventSourceCtor(): {
  Ctor: new (url: string) => MockEventSourceInstance;
  instances: MockEventSourceInstance[];
} {
  const instances: MockEventSourceInstance[] = [];

  const Ctor = function MockEventSource(this: MockEventSourceInstance, url: string) {
    this.url = url;
    this.readyState = 0;
    this.closed = false;
    this.listeners = new Map();
    this.onerror = null;
    instances.push(this);
  } as unknown as new (url: string) => MockEventSourceInstance;

  Ctor.prototype.addEventListener = function (
    this: MockEventSourceInstance,
    eventName: string,
    handler: (event: { data?: string }) => void,
  ) {
    let bucket = this.listeners.get(eventName);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(eventName, bucket);
    }
    bucket.add(handler);
  };

  Ctor.prototype.removeEventListener = function (
    this: MockEventSourceInstance,
    eventName: string,
    handler: (event: { data?: string }) => void,
  ) {
    this.listeners.get(eventName)?.delete(handler);
  };

  Ctor.prototype.close = function (this: MockEventSourceInstance) {
    this.closed = true;
    this.listeners.clear();
  };

  Ctor.prototype.emit = function (
    this: MockEventSourceInstance,
    eventName: string,
    data: unknown,
  ) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) return;
    const payload = { data: typeof data === "string" ? data : JSON.stringify(data) };
    for (const handler of [...handlers]) {
      handler(payload);
    }
  };

  return { Ctor, instances };
}

interface MockModel {
  applied: Array<Record<string, unknown>>;
  replaced: Array<Record<string, unknown>>;
  store: { notice: Record<string, unknown> | null };
  applySnapshotDelta(delta: Record<string, unknown>): void;
  replaceSnapshot(snapshot: Record<string, unknown>): void;
}

function createMockModel(): MockModel {
  const model: MockModel = {
    applied: [],
    replaced: [],
    store: { notice: null },
    applySnapshotDelta(delta) {
      this.applied.push(delta);
    },
    replaceSnapshot(snapshot) {
      this.replaced.push(snapshot);
    },
  };
  return model;
}

describe("subscribeSnapshotStream", () => {
  test("opens EventSource at /api/snapshot/stream with token query parameter", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "secret-token",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    expect(instances).toHaveLength(1);
    expect(instances[0]?.url).toBe("/api/snapshot/stream?token=secret-token");
    handle.dispose();
  });

  test("URL-encodes the token", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok with spaces & symbols",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    expect(instances[0]?.url).toContain("?token=");
    expect(instances[0]?.url).toContain(encodeURIComponent("tok with spaces & symbols"));
    handle.dispose();
  });

  test("omits token query parameter when sessionToken is empty", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    expect(instances[0]?.url).toBe("/api/snapshot/stream");
    handle.dispose();
  });

  test("applies snapshotDelta from server event and rerenders", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();
    let rerenderCount = 0;

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {
        rerenderCount += 1;
      },
      EventSourceCtor: Ctor,
    });

    const delta = { tasks: [{ id: "task-1", status: "in_progress" }] };
    instances[0]?.emit("snapshotDelta", { snapshotDelta: delta });

    expect(model.applied).toHaveLength(1);
    expect(model.applied[0]).toEqual(delta);
    expect(rerenderCount).toBe(1);
    handle.dispose();
  });

  test("ignores malformed JSON without crashing", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();
    let rerenderCount = 0;

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {
        rerenderCount += 1;
      },
      EventSourceCtor: Ctor,
    });

    instances[0]?.emit("snapshotDelta", "{not json");
    expect(model.applied).toHaveLength(0);
    expect(rerenderCount).toBe(0);
    handle.dispose();
  });

  test("ignores events without snapshotDelta payload", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    instances[0]?.emit("snapshotDelta", { other: "field" });
    expect(model.applied).toHaveLength(0);
    handle.dispose();
  });

  test("dispose closes the EventSource", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    expect(instances[0]?.closed).toBe(false);
    handle.dispose();
    expect(instances[0]?.closed).toBe(true);
  });

  test("post-dispose events are ignored", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    handle.dispose();
    // Force-listeners cleared by close(); emit becomes a no-op.
    instances[0]?.emit("snapshotDelta", { snapshotDelta: { tasks: [] } });
    expect(model.applied).toHaveLength(0);
  });

  test("applies initial snapshot event by replacing snapshot", () => {
    const { Ctor, instances } = createMockEventSourceCtor();
    const model = createMockModel();

    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {},
      EventSourceCtor: Ctor,
    });

    const snapshot = { epics: [], tasks: [], subtasks: [], dependencies: [] };
    instances[0]?.emit("snapshot", { snapshot });

    expect(model.replaced).toHaveLength(1);
    expect(model.replaced[0]).toEqual(snapshot);
    handle.dispose();
  });

  test("returns a no-op disposer when EventSource is unavailable", () => {
    const model = createMockModel();
    const handle = subscribeSnapshotStream(model, {
      sessionToken: "tok",
      rerender: () => {},
      EventSourceCtor: undefined,
    });

    expect(handle.eventSource).toBeNull();
    expect(() => handle.dispose()).not.toThrow();
  });
});
