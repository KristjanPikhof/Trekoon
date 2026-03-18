import { afterEach, describe, expect, test } from "bun:test";

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

afterEach(() => {
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
    return;
  }

  globalThis.localStorage = originalLocalStorage;
});

describe("board state store reconciliation", () => {
  test("clears stale selectedSubtaskId when selectedTaskId is reconciled away", () => {
    globalThis.localStorage = createMockStorage() as Storage;

    const store = createStore({
      epics: [
        { id: "epic-1", title: "Epic 1" },
        { id: "epic-2", title: "Epic 2" },
      ],
      tasks: [
        { id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" },
      ],
      subtasks: [
        { id: "subtask-1", taskId: "task-1", title: "Subtask 1", status: "todo" },
      ],
      dependencies: [],
    });

    store.syncState({
      screen: "tasks",
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
      selectedSubtaskId: "subtask-1",
    });

    const reconciled = store.syncState({ selectedEpicId: "epic-2" });

    expect(reconciled.selectedTaskId).toBeNull();
    expect(reconciled.selectedSubtaskId).toBeNull();
    expect(reconciled.selectedSubtask).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
    expect(store.getState().selectedSubtaskId).toBeNull();
  });
});
