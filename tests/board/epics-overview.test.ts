import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createEpicsOverview } from "../../src/board/assets/components/EpicsOverview.js";

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

describe("epics overview copy affordance", () => {
  test("renders copied row state with inline svg icon", () => {
    const { container, getHtml } = createMockContainer();
    const overview = createEpicsOverview().mount(container);

    overview.update({
      visibleEpics: [
        {
          id: "epic-1",
          title: "Ship copy flow",
          description: "Refine copied state",
          status: "todo",
          updatedAt: 123,
          taskIds: [],
          counts: { blocked: 0, done: 0, in_progress: 0 },
        },
      ],
      selectedEpicId: null,
      store: {
        snapshot: { tasks: [] },
        isMutating: false,
        copyFeedback: { epicId: "epic-1" },
      },
    });

    const html = getHtml();
    expect(html).toContain('data-copy-epic-id="epic-1"');
    expect(html).toContain("board-copy-btn--icon");
    expect(html).toContain("board-copy-btn--epic-row");
    expect(html).toContain("board-copy-btn--active");
    expect(html).toContain("board-inline-icon board-inline-icon--sm");
    expect(html).not.toContain("content_copy");
  });
});
