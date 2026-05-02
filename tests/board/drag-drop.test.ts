import { afterEach, describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createBoardActions } from "../../src/board/assets/state/actions.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { normalizeSnapshot } from "../../src/board/assets/state/utils.js";

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

const originalLocalStorage = globalThis.localStorage;

afterEach(() => {
  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
    return;
  }
  globalThis.localStorage = originalLocalStorage;
});

function buildHarness() {
  globalThis.localStorage = createMockStorage() as Storage;
  const model = createStore({
    epics: [{ id: "epic-1", title: "Epic 1" }],
    tasks: [
      { id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" },
      { id: "task-2", epicId: "epic-1", title: "Task 2", status: "in_progress" },
      { id: "task-3", epicId: "epic-1", title: "Task 3", status: "todo" },
    ],
    subtasks: [],
    dependencies: [],
  });

  const api = {
    patchTask: mock(() => {}),
    patchSubtask: mock(() => {}),
    patchEpic: mock(() => {}),
    cascadeEpicStatus: mock(() => {}),
    createSubtask: mock(() => {}),
    deleteSubtask: mock(() => {}),
    addDependency: mock(() => {}),
    removeDependency: mock(() => {}),
  };

  const rerender = mock(() => {});

  const actions = createBoardActions({
    model,
    api,
    rerender,
    normalizeSnapshot,
    normalizeStatus: (status: string) => status,
    applyTheme: () => {},
    closeTopmostDisclosure: () => false,
    dismissSearch: () => false,
    hasOpenOverlay: () => false,
    closeActiveOverlay: () => {},
    focusSearch: () => {},
    focusTaskDetail: () => {},
    searchFocusKeys: new Set(["/"]),
  });

  return { model, actions, api, rerender };
}

describe("dropTaskStatus selection invariants", () => {
  test("does not change selection or modal state with no prior selection", () => {
    const { model, actions, api } = buildHarness();

    expect(model.getState().selectedTaskId).toBeNull();
    expect(model.getState().taskModalOpen).toBe(false);

    actions.dropTaskStatus("task-1", "done");

    expect(model.getState().selectedTaskId).toBeNull();
    expect(model.getState().taskModalOpen).toBe(false);
    expect(api.patchTask).toHaveBeenCalledTimes(1);
    expect((api.patchTask.mock.calls[0] as unknown[])?.[1]).toEqual({ status: "done" });
  });

  test("keeps an open task modal intact when dragging a different card", () => {
    const { model, actions, api } = buildHarness();
    actions.selectTask("task-1");

    expect(model.getState().selectedTaskId).toBe("task-1");
    expect(model.getState().taskModalOpen).toBe(true);

    actions.dropTaskStatus("task-2", "done");

    // Acceptance: drag must not mutate selection.
    expect(model.getState().selectedTaskId).toBe("task-1");
    expect(model.getState().taskModalOpen).toBe(true);
    expect(api.patchTask).toHaveBeenCalledTimes(1);
  });

  test("does not change selection when dragging the currently selected card", () => {
    const { model, actions, api } = buildHarness();
    actions.selectTask("task-1");

    actions.dropTaskStatus("task-1", "done");

    expect(model.getState().selectedTaskId).toBe("task-1");
    expect(model.getState().taskModalOpen).toBe(true);
    expect(api.patchTask).toHaveBeenCalledTimes(1);
  });

  test("noop drop (same status / unknown task) does not call api or change state", () => {
    const { model, actions, api } = buildHarness();
    actions.selectTask("task-2");
    const before = model.getState();

    actions.dropTaskStatus("task-2", "in_progress"); // same status
    actions.dropTaskStatus("missing-task", "done");
    actions.dropTaskStatus("task-1", "");

    const after = model.getState();
    expect(after.selectedTaskId).toBe(before.selectedTaskId);
    expect(after.taskModalOpen).toBe(before.taskModalOpen);
    expect(api.patchTask).not.toHaveBeenCalled();
  });
});
