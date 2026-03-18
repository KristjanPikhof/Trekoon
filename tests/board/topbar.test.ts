import { afterEach, describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createTopBar } from "../../src/board/assets/components/TopBar.js";

type SearchInput = {
  value: string;
  selectionStart: number;
  selectionEnd: number;
  focus: (options?: { preventScroll?: boolean }) => void;
  setSelectionRange: (start: number, end: number) => void;
};

function createProps(overrides: Partial<{
  currentNav: string;
  screen: string;
  search: string;
  searchScope: { summary: string; detail: string };
  selectedEpic: { title: string } | null;
  theme: string;
  isMutating: boolean;
}> = {}) {
  return {
    currentNav: "epics",
    screen: "epics",
    search: "",
    searchScope: {
      summary: "Epic overview",
      detail: "Search across epics, tasks, and subtasks.",
    },
    selectedEpic: null,
    theme: "dark",
    isMutating: false,
    ...overrides,
  };
}

function createMockContainer() {
  let input: SearchInput | null = null;
  let disclosure: { open: boolean; hasAttribute: (name: string) => boolean } | null = null;
  let html = "";

  const container = {
    querySelector(selector: string) {
      if (selector === "#board-search-input") {
        return input;
      }
      if (selector === "details") {
        return disclosure;
      }
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === "details") {
        return disclosure ? [disclosure] : [];
      }
      return [];
    },
  } as unknown as HTMLElement & { innerHTML: string };

  Object.defineProperty(container, "innerHTML", {
    get() {
      return html;
    },
    set(value: string) {
      html = value;
      const match = value.match(/id="board-search-input"[^>]*value="([^"]*)"/);
      const nextValue = match?.[1] ?? "";
      const detailsMatch = value.match(/<details[^>]*class="board-shell-topbar__meta"([^>]*)>/);
      input = {
        value: nextValue,
        selectionStart: nextValue.length,
        selectionEnd: nextValue.length,
        focus() {},
        setSelectionRange(start: number, end: number) {
          this.selectionStart = start;
          this.selectionEnd = end;
        },
      };
      disclosure = {
        open: (detailsMatch?.[1] ?? "").includes("open"),
        hasAttribute(name: string) {
          return name === "open" ? this.open : false;
        },
      };
    },
  });

  return {
    container,
    getInput() {
      if (!input) {
        throw new Error("Search input not rendered");
      }
      return input;
    },
    getDisclosure() {
      if (!disclosure) {
        throw new Error("Disclosure not rendered");
      }
      return disclosure;
    },
  };
}

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
    return;
  }

  globalThis.document = originalDocument;
});

describe("top bar search input", () => {
  test("keeps the board navigation button enabled without a selected epic", () => {
    const { container } = createMockContainer();

    const topBar = createTopBar().mount(container);
    topBar.update(createProps({ selectedEpic: null }));

    expect(container.innerHTML).toContain('data-nav-board="true"');
    expect(container.innerHTML).toContain('title="Open the newest epic board."');
    expect(container.innerHTML).not.toMatch(/data-nav-board="true"[^>]*disabled/);
  });

  test("applies externally restored search values to the visible input", () => {
    const { container, getInput } = createMockContainer();
    globalThis.document = { activeElement: null } as Document;

    const topBar = createTopBar().mount(container);
    topBar.update(createProps({ search: "ship" }));

    const firstInput = getInput();
    firstInput.value = "ship draft";
    firstInput.selectionStart = 10;
    firstInput.selectionEnd = 10;

    topBar.update(createProps({ search: "" }));

    expect(getInput().value).toBe("");
  });

  test("keeps the info disclosure open across unrelated rerenders", () => {
    const { container, getDisclosure } = createMockContainer();
    const topBar = createTopBar().mount(container);

    topBar.update(createProps());

    const disclosure = getDisclosure();
    disclosure.open = true;
    topBar.update(createProps({ theme: "light" }));

    const rerenderedDisclosure = getDisclosure();
    expect(rerenderedDisclosure.hasAttribute("open")).toBe(true);
    expect(rerenderedDisclosure.open).toBe(true);
  });
});
