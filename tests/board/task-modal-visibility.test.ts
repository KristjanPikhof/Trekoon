import { afterEach, describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createBoardActions } from "../../src/board/assets/state/actions.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { shouldUseTaskModal } from "../../src/board/assets/components/helpers.js";
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
    epics: [
      { id: "epic-1", title: "Epic 1" },
      { id: "epic-2", title: "Epic 2" },
    ],
    tasks: [
      { id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" },
      { id: "task-2", epicId: "epic-1", title: "Task 2", status: "in_progress" },
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

  const actions = createBoardActions({
    model,
    api,
    rerender: () => {},
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

  return { model, actions, api };
}

describe("task modal visibility actions", () => {
  test("selectTask sets taskModalOpen=true and selectedTaskId", () => {
    const { model, actions } = buildHarness();

    actions.selectTask("task-1");

    const state = model.getState();
    expect(state.selectedTaskId).toBe("task-1");
    expect(state.taskModalOpen).toBe(true);
    expect(model.getBoardState().taskModalOpen).toBe(true);
  });

  test("closeTask clears taskModalOpen and selectedTaskId", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.closeTask();

    const state = model.getState();
    expect(state.selectedTaskId).toBeNull();
    expect(state.selectedSubtaskId).toBeNull();
    expect(state.taskModalOpen).toBe(false);
  });

  test("dropTaskStatus does not open or change modal selection when none was open", () => {
    const { model, actions, api } = buildHarness();
    actions.selectTask("task-1");
    actions.closeTask();
    expect(model.getState().taskModalOpen).toBe(false);
    expect(model.getState().selectedTaskId).toBeNull();

    actions.dropTaskStatus("task-2", "done");

    // Drag is a status change only; do not hijack selection.
    expect(model.getState().selectedTaskId).toBeNull();
    expect(model.getState().taskModalOpen).toBe(false);
    expect(api.patchTask).toHaveBeenCalled();
  });

  test("dropTaskStatus does not close or change selection when another task modal is open", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");
    expect(model.getState().taskModalOpen).toBe(true);
    expect(model.getState().selectedTaskId).toBe("task-1");

    actions.dropTaskStatus("task-2", "done");

    // The currently-open modal MUST NOT be hijacked by an unrelated drag.
    expect(model.getState().selectedTaskId).toBe("task-1");
    expect(model.getState().taskModalOpen).toBe(true);
  });

  test("openEpic clears taskModalOpen", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.openEpic("epic-2");

    expect(model.getState().taskModalOpen).toBe(false);
    expect(model.getState().selectedTaskId).toBeNull();
  });

  test("selectEpic clears taskModalOpen", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.selectEpic("epic-2");

    expect(model.getState().taskModalOpen).toBe(false);
    expect(model.getState().selectedTaskId).toBeNull();
  });

  test("showEpics clears taskModalOpen", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.showEpics();

    expect(model.getState().taskModalOpen).toBe(false);
    expect(model.getState().screen).toBe("epics");
  });

  test("showBoard clears taskModalOpen", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.showBoard();

    expect(model.getState().taskModalOpen).toBe(false);
    expect(model.getState().selectedTaskId).toBeNull();
  });
});

describe("shouldUseTaskModal predicate", () => {
  const fakeTask = { id: "task-1", title: "Fake" };

  test("returns false when taskModalOpen is false even if selectedTask is set", () => {
    expect(shouldUseTaskModal({ selectedTask: fakeTask, taskModalOpen: false })).toBe(false);
  });

  test("returns true only when both taskModalOpen and selectedTask are truthy", () => {
    expect(shouldUseTaskModal({ selectedTask: fakeTask, taskModalOpen: true })).toBe(true);
    expect(shouldUseTaskModal({ selectedTask: null, taskModalOpen: true })).toBe(false);
    expect(shouldUseTaskModal(null)).toBe(false);
    expect(shouldUseTaskModal(undefined)).toBe(false);
  });
});
