import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";

type StorageShape = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

function createMockStorage(seed: Record<string, string> = {}): StorageShape {
  const values = new Map(Object.entries(seed));
  return {
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

const originalLocalStorage = globalThis.localStorage;

beforeEach(() => {
  globalThis.localStorage = createMockStorage() as Storage;
});

afterEach(() => {
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
    return;
  }
  globalThis.localStorage = originalLocalStorage;
});

describe("selectVisibleEpics done-grace bucket", () => {
  test("done epic within 24h grace stays visible until cutoff is crossed", () => {
    // Pin Date.now() for the initial store creation and first read.
    const baseNow = 100_000_000_000;
    const updatedAt = baseNow - 23 * 3_600_000; // 23h old: still in grace
    const dateSpy = spyOn(Date, "now").mockReturnValue(baseNow);

    const store = createStore({
      epics: [
        {
          id: "epic-recent-done",
          title: "Recently done epic",
          status: "done",
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      tasks: [],
      subtasks: [],
      dependencies: [],
    });

    // Done filter is off by default; epic should still be visible (within 24h).
    expect(store.getBoardState().visibleEpics.map((e: { id: string }) => e.id)).toEqual([
      "epic-recent-done",
    ]);

    // Advance the clock by 2 hours -- now the epic is past the 24h cutoff.
    dateSpy.mockReturnValue(baseNow + 2 * 3_600_000);

    // After the hour bucket changes, the memo MUST re-evaluate and drop the epic.
    expect(store.getBoardState().visibleEpics.map((e: { id: string }) => e.id)).toEqual([]);

    dateSpy.mockRestore();
  });

  test("epic crossing 24h grace boundary disappears within 1h on an open page", () => {
    const baseNow = 200_000_000_000;
    // Updated 23h59m ago: still inside grace at baseNow.
    const updatedAt = baseNow - (24 * 3_600_000 - 60_000);
    const dateSpy = spyOn(Date, "now").mockReturnValue(baseNow);

    const store = createStore({
      epics: [
        {
          id: "epic-edge",
          title: "Edge epic",
          status: "done",
          createdAt: updatedAt,
          updatedAt,
        },
      ],
      tasks: [],
      subtasks: [],
      dependencies: [],
    });

    expect(store.getBoardState().visibleEpics.map((e: { id: string }) => e.id)).toEqual([
      "epic-edge",
    ]);

    // Advance by 1 hour -- well past the boundary; bucket changes; memo invalidates.
    dateSpy.mockReturnValue(baseNow + 3_600_000);

    expect(store.getBoardState().visibleEpics).toEqual([]);

    dateSpy.mockRestore();
  });

  test("memo still returns a stable reference within the same hour bucket", () => {
    const baseNow = 300_000_000_000;
    const dateSpy = spyOn(Date, "now").mockReturnValue(baseNow);

    const store = createStore({
      epics: [
        {
          id: "epic-fresh",
          title: "Fresh epic",
          status: "todo",
          createdAt: baseNow,
          updatedAt: baseNow,
        },
      ],
      tasks: [],
      subtasks: [],
      dependencies: [],
    });

    const first = store.getBoardState().visibleEpics;
    // Move the clock forward but stay in the same hour bucket.
    dateSpy.mockReturnValue(baseNow + 60_000);
    const second = store.getBoardState().visibleEpics;

    expect(second).toBe(first);

    dateSpy.mockRestore();
  });
});
