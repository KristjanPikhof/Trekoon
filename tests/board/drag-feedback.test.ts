import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createWorkspace } from "../../src/board/assets/components/Workspace.js";

function createMockContainer() {
  let html = "";
  const container = {} as HTMLElement & { innerHTML: string };
  Object.defineProperty(container, "innerHTML", {
    get() { return html; },
    set(value: string) { html = value; },
  });
  return { container, getHtml() { return html; } };
}

const baseProps = {
  selectedEpic: {
    id: "epic-1",
    title: "Test epic",
    description: "",
    status: "in_progress",
    counts: { todo: 1, blocked: 0, in_progress: 1, done: 0 },
    taskIds: ["task-1", "task-2"],
  },
  selectedTask: null,
  snapshotEpics: [{ id: "epic-1", title: "Test epic", createdAt: 100 }],
  visibleTasks: [
    { id: "task-1", title: "Task A", status: "todo", description: "", subtasks: [], blockedBy: [], updatedAt: 1000 },
    { id: "task-2", title: "Task B", status: "in_progress", description: "", subtasks: [], blockedBy: [], updatedAt: 1000 },
  ],
  store: {
    copyFeedback: null,
    notesPanelOpen: false,
    isMutating: false,
    selectedEpicId: "epic-1",
    view: "kanban",
    taskStatusFilter: null,
    dragFeedback: null,
  },
};

describe("drag feedback persistence across rerender", () => {
  test("no feedback classes appear when dragFeedback is null", () => {
    const { container, getHtml } = createMockContainer();
    const workspace = createWorkspace().mount(container);

    workspace.update({ ...baseProps, store: { ...baseProps.store, dragFeedback: null } });
    const html = getHtml();

    expect(html).not.toContain("board-drop-valid");
    expect(html).not.toContain("board-drop-invalid");
  });

  test("board-drop-valid class is present on the target column after rerender", () => {
    const { container, getHtml } = createMockContainer();
    const workspace = createWorkspace().mount(container);

    workspace.update({
      ...baseProps,
      store: {
        ...baseProps.store,
        dragFeedback: { targetStatus: "in_progress", kind: "valid" },
      },
    });
    const html = getHtml();

    expect(html).toContain("board-drop-valid");
    expect(html).not.toContain("board-drop-invalid");

    // The valid class should be on the in_progress column drop target, not on others.
    const inProgressColMatch = html.match(/data-drop-status="in_progress"[^>]*/);
    expect(inProgressColMatch?.[0]).toContain("board-drop-valid");
  });

  test("board-drop-invalid class is present on the target column after rerender", () => {
    const { container, getHtml } = createMockContainer();
    const workspace = createWorkspace().mount(container);

    workspace.update({
      ...baseProps,
      store: {
        ...baseProps.store,
        dragFeedback: { targetStatus: "done", kind: "invalid" },
      },
    });
    const html = getHtml();

    expect(html).toContain("board-drop-invalid");
    expect(html).not.toContain("board-drop-valid");

    const doneColMatch = html.match(/data-drop-status="done"[^>]*/);
    expect(doneColMatch?.[0]).toContain("board-drop-invalid");
  });

  test("feedback class is applied to the correct column, not siblings", () => {
    const { container, getHtml } = createMockContainer();
    const workspace = createWorkspace().mount(container);

    workspace.update({
      ...baseProps,
      store: {
        ...baseProps.store,
        dragFeedback: { targetStatus: "todo", kind: "valid" },
      },
    });
    const html = getHtml();

    const todoColMatch = html.match(/data-drop-status="todo"[^>]*/);
    const inProgressColMatch = html.match(/data-drop-status="in_progress"[^>]*/);

    expect(todoColMatch?.[0]).toContain("board-drop-valid");
    expect(inProgressColMatch?.[0]).not.toContain("board-drop-valid");
    expect(inProgressColMatch?.[0]).not.toContain("board-drop-invalid");
  });

  test("clearing dragFeedback removes feedback classes from rerendered output", () => {
    const { container, getHtml } = createMockContainer();
    const workspace = createWorkspace().mount(container);

    // First render with feedback
    workspace.update({
      ...baseProps,
      store: { ...baseProps.store, dragFeedback: { targetStatus: "in_progress", kind: "valid" } },
    });
    expect(getHtml()).toContain("board-drop-valid");

    // Second render clearing feedback (simulates dragend / drop completing)
    workspace.update({
      ...baseProps,
      store: { ...baseProps.store, dragFeedback: null },
    });
    expect(getHtml()).not.toContain("board-drop-valid");
    expect(getHtml()).not.toContain("board-drop-invalid");
  });
});
