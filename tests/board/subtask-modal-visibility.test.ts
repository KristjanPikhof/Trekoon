import { afterEach, describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createBoardActions } from "../../src/board/assets/state/actions.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { shouldUseSubtaskModal, shouldUseTaskModal } from "../../src/board/assets/components/helpers.js";
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
    tasks: [{ id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" }],
    subtasks: [
      { id: "subtask-1", taskId: "task-1", title: "Subtask 1", status: "todo" },
      { id: "subtask-2", taskId: "task-1", title: "Subtask 2", status: "todo" },
    ],
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

describe("subtask modal visibility actions", () => {
  test("createStore initializes subtaskModalOpen to false", () => {
    const { model } = buildHarness();
    expect(model.getState().subtaskModalOpen).toBe(false);
    expect(model.getBoardState().subtaskModalOpen).toBe(false);
  });

  test("openSubtask flips subtaskModalOpen=true and sets selectedSubtaskId", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.openSubtask("subtask-1");

    const state = model.getState();
    expect(state.selectedSubtaskId).toBe("subtask-1");
    expect(state.subtaskModalOpen).toBe(true);
    expect(model.getBoardState().subtaskModalOpen).toBe(true);
  });

  test("closeSubtask clears subtaskModalOpen and selectedSubtaskId", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");
    actions.openSubtask("subtask-1");

    actions.closeSubtask();

    const state = model.getState();
    expect(state.selectedSubtaskId).toBeNull();
    expect(state.subtaskModalOpen).toBe(false);
    expect(model.getBoardState().subtaskModalOpen).toBe(false);
  });

  test("openSubtask(null) does not open the modal", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");

    actions.openSubtask(null);

    expect(model.getState().selectedSubtaskId).toBeNull();
    expect(model.getState().subtaskModalOpen).toBe(false);
  });

  test("closeTask also clears subtaskModalOpen", () => {
    const { model, actions } = buildHarness();
    actions.selectTask("task-1");
    actions.openSubtask("subtask-1");
    expect(model.getState().subtaskModalOpen).toBe(true);

    actions.closeTask();

    expect(model.getState().subtaskModalOpen).toBe(false);
    expect(model.getState().selectedSubtaskId).toBeNull();
    expect(model.getState().taskModalOpen).toBe(false);
  });

  test("subtask selection without modal does not render dialog (subtaskModalOpen forced false when subtask missing)", () => {
    const { model } = buildHarness();
    // Manually push state into a "selected but not opened" shape.
    model.syncState({
      screen: "tasks",
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
      taskModalOpen: true,
      // Note: subtaskModalOpen NOT set; selectedSubtaskId set.
      selectedSubtaskId: "subtask-1",
    });

    const boardState = model.getBoardState();
    // selectedSubtask is populated, but the modal MUST NOT be marked open
    // because no one toggled subtaskModalOpen.
    expect(boardState.selectedSubtask).not.toBeNull();
    expect(boardState.subtaskModalOpen).toBe(false);
    expect(shouldUseSubtaskModal(boardState)).toBe(false);
  });

  test("shouldUseSubtaskModal mirrors shouldUseTaskModal semantics", () => {
    expect(shouldUseSubtaskModal({ selectedSubtask: { id: "x" }, subtaskModalOpen: false })).toBe(false);
    expect(shouldUseSubtaskModal({ selectedSubtask: null, subtaskModalOpen: true })).toBe(false);
    expect(shouldUseSubtaskModal({ selectedSubtask: { id: "x" }, subtaskModalOpen: true })).toBe(true);
    expect(shouldUseSubtaskModal(null)).toBe(false);
    expect(shouldUseSubtaskModal(undefined)).toBe(false);
    // Sanity check the existing predicate still works.
    expect(shouldUseTaskModal({ selectedTask: { id: "x" }, taskModalOpen: true })).toBe(true);
  });

  test("subtaskModalOpen does not persist to localStorage", () => {
    const storage = createMockStorage();
    globalThis.localStorage = storage as Storage;

    const model = createStore({
      epics: [{ id: "epic-1", title: "Epic 1" }],
      tasks: [{ id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" }],
      subtasks: [
        { id: "subtask-1", taskId: "task-1", title: "Subtask 1", status: "todo" },
      ],
      dependencies: [],
    });

    model.syncState({
      screen: "tasks",
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
      taskModalOpen: true,
      selectedSubtaskId: "subtask-1",
      subtaskModalOpen: true,
    });
    model.persist();

    const written = JSON.parse(storage.getItem("trekoon-board-state") ?? "{}");
    expect(written).not.toHaveProperty("subtaskModalOpen");
  });
});
