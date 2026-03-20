import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createNotice } from "../../src/board/assets/components/Notice.js";

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

describe("board notice", () => {
  test("renders success notices as compact toasts", () => {
    const { container, getHtml } = createMockContainer();
    const notice = createNotice().mount(container);

    notice.update({
      notice: {
        type: "success",
        title: "Saved",
        message: "Task saved.",
      },
    });

    const html = getHtml();
    expect(html).toContain("board-toast-region");
    expect(html).toContain("board-toast board-toast--success");
    expect(html).toContain("Task saved.");
  });
});
