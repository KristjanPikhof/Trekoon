import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createBoardActions } from "../../src/board/assets/state/actions.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";

function createSnapshot() {
  return {
    epics: [
      {
        id: "epic-1",
        title: "Test epic",
        description: "",
        status: "in_progress",
        createdAt: 100,
        updatedAt: 100,
      },
    ],
    tasks: [
      {
        id: "task-1",
        epicId: "epic-1",
        title: "Task A",
        description: "",
        status: "todo",
        createdAt: 200,
        updatedAt: 200,
      },
    ],
    subtasks: [],
    dependencies: [],
  };
}

function makeActions(model: ReturnType<typeof createStore>, rerender: () => void) {
  return createBoardActions({
    model,
    api: {
      addDependency() {},
      cascadeEpicStatus() {},
      createSubtask() {},
      deleteSubtask() {},
      patchEpic() {},
      patchSubtask() {},
      patchTask() {},
      removeDependency() {},
    },
    rerender,
    normalizeSnapshot(snapshot: unknown) {
      return snapshot;
    },
    normalizeStatus(status: string) {
      return status;
    },
    applyTheme() {},
    closeTopmostDisclosure() {
      return false;
    },
    dismissSearch() {
      return false;
    },
    hasOpenOverlay() {
      return false;
    },
    closeActiveOverlay() {},
    focusSearch() {},
    focusTaskDetail() {},
    searchFocusKeys: new Set(["/"]),
  });
}

describe("setDragFeedback memoizes by primitive key", () => {
  test("same column dragover does not retrigger rerender", () => {
    const model = createStore(createSnapshot());
    let renderCount = 0;
    const actions = makeActions(model, () => {
      renderCount += 1;
    });

    // First call sets feedback, invalidates the board-state memo, and rerenders.
    const before = model.getBoardState();
    actions.setDragFeedback({ targetStatus: "in_progress", kind: "valid" });
    expect(renderCount).toBe(1);
    expect(model.getBoardState()).not.toBe(before);

    // Subsequent dragover events allocate fresh objects with the same content.
    // These must NOT cause additional rerenders.
    for (let i = 0; i < 25; i += 1) {
      actions.setDragFeedback({ targetStatus: "in_progress", kind: "valid" });
    }
    expect(renderCount).toBe(1);
  });

  test("changing target status rerenders", () => {
    const model = createStore(createSnapshot());
    let renderCount = 0;
    const actions = makeActions(model, () => {
      renderCount += 1;
    });

    actions.setDragFeedback({ targetStatus: "todo", kind: "valid" });
    expect(renderCount).toBe(1);

    actions.setDragFeedback({ targetStatus: "in_progress", kind: "valid" });
    expect(renderCount).toBe(2);
  });

  test("changing kind rerenders", () => {
    const model = createStore(createSnapshot());
    let renderCount = 0;
    const actions = makeActions(model, () => {
      renderCount += 1;
    });

    actions.setDragFeedback({ targetStatus: "todo", kind: "valid" });
    expect(renderCount).toBe(1);

    actions.setDragFeedback({ targetStatus: "todo", kind: "invalid" });
    expect(renderCount).toBe(2);
  });

  test("clearing feedback from null is a no-op", () => {
    const model = createStore(createSnapshot());
    let renderCount = 0;
    const actions = makeActions(model, () => {
      renderCount += 1;
    });

    actions.setDragFeedback(null);
    expect(renderCount).toBe(0);
  });

  test("clearing feedback after a value rerenders once", () => {
    const model = createStore(createSnapshot());
    let renderCount = 0;
    const actions = makeActions(model, () => {
      renderCount += 1;
    });

    actions.setDragFeedback({ targetStatus: "todo", kind: "valid" });
    expect(renderCount).toBe(1);

    actions.setDragFeedback(null);
    expect(renderCount).toBe(2);

    // Re-clearing is a no-op.
    actions.setDragFeedback(null);
    expect(renderCount).toBe(2);
  });
});
