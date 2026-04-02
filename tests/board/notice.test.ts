import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createNotice } from "../../src/board/assets/components/Notice.js";

function createMockContainer() {
  let html = "";
  let retryButton: null | {
    addEventListener: (type: string, listener: () => void) => void;
    click: () => void;
  } = null;

  const container = {} as HTMLElement & {
    innerHTML: string;
    querySelector?: (selector: string) => unknown;
  };

  Object.defineProperty(container, "innerHTML", {
    get() {
      return html;
    },
    set(value: string) {
      html = value;
      retryButton = value.includes("data-board-notice-retry")
        ? (() => {
            let clickListener: null | (() => void) = null;
            return {
              addEventListener(type: string, listener: () => void) {
                if (type === "click") {
                  clickListener = listener;
                }
              },
              click() {
                clickListener?.();
              },
            };
          })()
        : null;
    },
  });

  container.querySelector = (selector: string) => {
    if (selector === "[data-board-notice-retry]") {
      return retryButton;
    }
    return null;
  };

  return {
    container,
    getHtml() {
      return html;
    },
    clickRetry() {
      retryButton?.click();
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

  test("rebinds retry handlers for repeated identical notices", () => {
    const { container, clickRetry } = createMockContainer();
    const notice = createNotice().mount(container);
    let retryCalls = 0;

    notice.update({
      notice: {
        type: "error",
        title: "Action failed",
        message: "DELETE /api/subtasks/subtask-1 timed out",
        retryLabel: "Retry",
        retryMutationId: 1,
      },
      onRetry() {
        retryCalls += 1;
      },
    });
    clickRetry();

    notice.update({
      notice: {
        type: "error",
        title: "Action failed",
        message: "DELETE /api/subtasks/subtask-1 timed out",
        retryLabel: "Retry",
        retryMutationId: 2,
      },
      onRetry() {
        retryCalls += 1;
      },
    });
    clickRetry();

    expect(retryCalls).toBe(2);
  });
});
