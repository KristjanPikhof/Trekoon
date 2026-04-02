import { afterEach, describe, expect, mock, test } from "bun:test";

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
  test("orders visible epics newest-first with deterministic ties", () => {
    globalThis.localStorage = createMockStorage() as Storage;

    const store = createStore({
      epics: [
        { id: "epic-z", title: "Older epic", createdAt: 100 },
        { id: "epic-b", title: "Newest beta epic", createdAt: 300 },
        { id: "epic-a", title: "Newest alpha epic", createdAt: 300 },
        { id: "epic-c", title: "Middle epic", createdAt: 200 },
      ],
      tasks: [],
      subtasks: [],
      dependencies: [],
    });

    expect(store.getBoardState().visibleEpics.map((epic: { id: string }) => epic.id)).toEqual([
      "epic-a",
      "epic-b",
      "epic-c",
      "epic-z",
    ]);

    const searched = store.syncState({ search: "newest" });

    expect(searched.visibleEpics.map((epic: { id: string }) => epic.id)).toEqual(["epic-a", "epic-b"]);
  });

  test("overview search matches epic, task, and subtask content", () => {
    globalThis.localStorage = createMockStorage() as Storage;

    const store = createStore({
      epics: [
        { id: "epic-title", title: "Payments roadmap", description: "Quarterly planning" },
        { id: "epic-task", title: "Operations", description: "Backoffice work" },
        { id: "epic-subtask", title: "Support", description: "Inbox cleanup" },
      ],
      tasks: [
        {
          id: "task-1",
          epicId: "epic-task",
          title: "Refine runbook",
          description: "Document the red button rollback flow",
          status: "todo",
        },
        {
          id: "task-2",
          epicId: "epic-subtask",
          title: "Triage requests",
          description: "Handle routine intake",
          status: "todo",
        },
      ],
      subtasks: [
        {
          id: "subtask-1",
          taskId: "task-2",
          title: "Capture screenshot evidence",
          description: "Attach the customer repro to the ticket",
          status: "todo",
        },
      ],
      dependencies: [],
    });

    expect(store.syncState({ search: "payments" }).visibleEpics.map((epic: { id: string }) => epic.id)).toEqual(["epic-title"]);
    expect(store.syncState({ search: "red button rollback" }).visibleEpics.map((epic: { id: string }) => epic.id)).toEqual(["epic-task"]);
    expect(store.syncState({ search: "customer repro" }).visibleEpics.map((epic: { id: string }) => epic.id)).toEqual(["epic-subtask"]);
  });

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

    const reconciled = store.syncState({ selectedTaskId: "missing-task" });

    expect(reconciled.selectedTaskId).toBeNull();
    expect(reconciled.selectedSubtaskId).toBeNull();
    expect(reconciled.selectedSubtask).toBeNull();
    expect(store.getState().selectedTaskId).toBeNull();
    expect(store.getState().selectedSubtaskId).toBeNull();
  });

  test("canonicalizes conflicting selectedEpicId to the selected task owner", () => {
    globalThis.localStorage = createMockStorage() as Storage;

    const store = createStore({
      epics: [
        { id: "epic-1", title: "Epic 1" },
        { id: "epic-2", title: "Epic 2" },
      ],
      tasks: [
        { id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" },
      ],
      subtasks: [],
      dependencies: [],
    });

    const reconciled = store.syncState({
      screen: "tasks",
      selectedEpicId: "epic-2",
      selectedTaskId: "task-1",
    });

    expect(reconciled.selectedEpicId).toBe("epic-1");
    expect(reconciled.selectedTaskId).toBe("task-1");
    expect(reconciled.selectedTask).toMatchObject({
      id: "task-1",
      epicId: "epic-1",
    });
    expect(store.getState()).toMatchObject({
      screen: "tasks",
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
    });
  });

  test("storage read and persist failures degrade safely", () => {
    const setItem = mock(() => {
      throw new Error("quota exceeded");
    });
    globalThis.localStorage = ({
      clear() {},
      getItem() {
        throw new Error("storage unavailable");
      },
      key() {
        return null;
      },
      get length() {
        return 0;
      },
      removeItem() {},
      setItem,
    } as unknown) as Storage;

    const store = createStore({
      epics: [{ id: "epic-1", title: "Epic 1" }],
      tasks: [],
      subtasks: [],
      dependencies: [],
    });

    expect(() => store.persist()).not.toThrow();
    expect(store.getState().theme).toBe("dark");
    expect(setItem).toHaveBeenCalled();
  });

  test("invalid timestamps fall back safely for sorting and derived state", () => {
    globalThis.localStorage = createMockStorage() as Storage;

    const store = createStore({
      epics: [
        { id: "epic-invalid", title: "Broken", createdAt: Number.NaN, updatedAt: Number.NaN },
        { id: "epic-valid", title: "Healthy", createdAt: 200, updatedAt: 300 },
      ],
      tasks: [
        { id: "task-invalid", epicId: "epic-invalid", title: "Task", createdAt: Number.POSITIVE_INFINITY, updatedAt: -1, status: "todo" },
      ],
      subtasks: [],
      dependencies: [],
    });

    const boardState = store.getBoardState();

    expect(boardState.visibleEpics).toHaveLength(2);
    expect(Number.isFinite(store.getSnapshot().epics[0]?.createdAt)).toBeTrue();
    expect(Number.isFinite(store.getSnapshot().tasks[0]?.updatedAt)).toBeTrue();
  });
});
