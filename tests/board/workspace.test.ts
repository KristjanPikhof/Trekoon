import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createWorkspace } from "../../src/board/assets/components/Workspace.js";

function createMockContainer() {
  let html = "";

  const container = {} as HTMLElement & { innerHTML: string };

  Object.defineProperty(container, "innerHTML", {
    get() {
      return html;
    },
    set(value: string) {
      html = value;
    },
  });

  return {
    container,
    getHtml() {
      return html;
    },
  };
}

describe("workspace epic selector", () => {
  test("renders epic options newest-first", () => {
    const { container, getHtml } = createMockContainer();
    const workspace = createWorkspace().mount(container);

    workspace.update({
      selectedEpic: {
        id: "epic-middle",
        title: "Middle epic",
        description: "",
        status: "todo",
      },
      selectedTask: null,
      snapshotEpics: [
        { id: "epic-older", title: "Older epic", createdAt: 100 },
        { id: "epic-newest", title: "Newest epic", createdAt: 300 },
        { id: "epic-middle", title: "Middle epic", createdAt: 200 },
      ],
      store: {
        notesPanelOpen: false,
        isMutating: false,
        selectedEpicId: "epic-middle",
        view: "kanban",
      },
      visibleTasks: [],
    });

    const html = getHtml();
    const optionValues = [...html.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);

    expect(optionValues.slice(1, 4)).toEqual([
      "epic-newest",
      "epic-middle",
      "epic-older",
    ]);
  });
});
