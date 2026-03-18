import { afterEach, describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset modules are exercised directly in tests.
import { createBoardActions } from "../../src/board/assets/state/actions.js";
// @ts-expect-error Untyped browser asset modules are exercised directly in tests.
import { createStore } from "../../src/board/assets/state/store.js";
// @ts-expect-error Untyped browser asset modules are exercised directly in tests.
import { syncUrlHash } from "../../src/board/assets/state/url.js";

type StorageShape = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
};

type MockWindow = {
  location: {
    pathname: string;
    search: string;
    hash: string;
  };
  history: {
    pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    replaceState: (state: unknown, title: string, url?: string | URL | null) => void;
  };
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
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

function createMockDocument(searchInput: HTMLInputElement | null = null) {
  return {
    activeElement: null,
    querySelector(selector: string) {
      if (selector === "#board-search-input") {
        return searchInput;
      }
      return null;
    },
  } as unknown as Document;
}

function setActiveElement(documentRef: Document, element: Element | null) {
  (documentRef as { activeElement: Element | null }).activeElement = element;
}

function createMockWindow(pathname = "/board") {
  const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const calls: Array<{ mode: "push" | "replace"; url: string }> = [];
  const location = {
    pathname,
    search: "",
    hash: "",
  };

  const applyUrl = (url: string | URL | null | undefined) => {
    const value = String(url ?? "");
    const hashIndex = value.indexOf("#");
    location.hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  };

  const mockWindow: MockWindow = {
    location,
    history: {
      pushState(_state, _title, url) {
        calls.push({ mode: "push", url: String(url ?? "") });
        applyUrl(url);
      },
      replaceState(_state, _title, url) {
        calls.push({ mode: "replace", url: String(url ?? "") });
        applyUrl(url);
      },
    },
    addEventListener(type, listener) {
      const current = listeners.get(type) ?? new Set();
      current.add(listener);
      listeners.set(type, current);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    calls,
    emit(type: string) {
      const event = { type } as Event;
      for (const listener of listeners.get(type) ?? []) {
        if (typeof listener === "function") {
          listener(event);
          continue;
        }
        listener.handleEvent(event);
      }
    },
    window: mockWindow,
  };
}

const originalDocument = globalThis.document;
const originalHTMLInputElement = globalThis.HTMLInputElement;
const originalLocalStorage = globalThis.localStorage;
const originalWindow = globalThis.window;

afterEach(() => {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    globalThis.document = originalDocument;
  }

  if (originalLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    globalThis.localStorage = originalLocalStorage;
  }

  if (originalHTMLInputElement === undefined) {
    Reflect.deleteProperty(globalThis, "HTMLInputElement");
  } else {
    globalThis.HTMLInputElement = originalHTMLInputElement;
  }

  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
  } else {
    globalThis.window = originalWindow;
  }
});

function createSnapshot() {
  return {
    epics: [
      { id: "epic-1", title: "Epic 1", status: "todo" },
      { id: "epic-2", title: "Epic 2", status: "todo" },
    ],
    tasks: [
      { id: "task-1", epicId: "epic-1", title: "Task 1", status: "todo" },
      { id: "task-2", epicId: "epic-2", title: "Task 2", status: "todo" },
    ],
    subtasks: [],
    dependencies: [],
  };
}

function createActions(model: ReturnType<typeof createStore>) {
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
    rerender() {},
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

function createMockSearchInput() {
  class MockSearchInput {
    id = "board-search-input";
    value = "";
    blurred = false;

    focus() {}

    blur() {
      this.blurred = true;
    }

    setSelectionRange() {}
  }

  return new MockSearchInput() as unknown as HTMLInputElement & { blurred: boolean };
}

describe("board URL/store integration", () => {
  test("round-trips selected epic overview separately from board view", () => {
    globalThis.document = createMockDocument();
    globalThis.HTMLInputElement = class {} as typeof HTMLInputElement;
    globalThis.localStorage = createMockStorage() as Storage;
    const mockWindow = createMockWindow();
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const model = createStore(createSnapshot());
    const actions = createActions(model);
    const cleanup = syncUrlHash(model);

    expect(mockWindow.calls).toEqual([]);

    actions.showBoard();
    expect(mockWindow.calls.at(-1)).toEqual({ mode: "push", url: "/board#epic=epic-1" });
    expect(model.getBoardState().screen).toBe("tasks");

    actions.showEpics();
    expect(mockWindow.calls.at(-1)).toEqual({ mode: "push", url: "/board#epic=epic-1&screen=epics" });
    expect(model.getBoardState().screen).toBe("epics");

    mockWindow.window.location.hash = "#epic=epic-1";
    mockWindow.emit("popstate");
    expect(model.getBoardState()).toMatchObject({
      screen: "tasks",
      selectedEpicId: "epic-1",
    });

    mockWindow.window.location.hash = "#epic=epic-1&screen=epics";
    mockWindow.emit("popstate");
    expect(model.getBoardState()).toMatchObject({
      screen: "epics",
      selectedEpicId: "epic-1",
    });

    cleanup();
  });

  test("debounced search updates sync into the URL", async () => {
    const searchInput = createMockSearchInput();
    globalThis.document = createMockDocument(searchInput);
    globalThis.HTMLInputElement = searchInput.constructor as typeof HTMLInputElement;
    globalThis.localStorage = createMockStorage() as Storage;
    const mockWindow = createMockWindow();
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const model = createStore(createSnapshot());
    const actions = createActions(model);
    const cleanup = syncUrlHash(model);

    actions.showBoard();
    actions.updateSearch("ship");
    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(model.getBoardState().search).toBe("ship");
    expect(mockWindow.calls.at(-1)).toEqual({
      mode: "replace",
      url: "/board#epic=epic-1&search=ship",
    });

    cleanup();
  });

  test("escape cancels a pending debounced search before it reaches state or URL", async () => {
    const searchInput = createMockSearchInput();
    const mockDocument = createMockDocument(searchInput);
    globalThis.document = mockDocument;
    globalThis.HTMLInputElement = searchInput.constructor as typeof HTMLInputElement;
    globalThis.localStorage = createMockStorage() as Storage;
    const mockWindow = createMockWindow();
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const model = createStore(createSnapshot());
    const actions = createActions(model);
    const cleanup = syncUrlHash(model);

    actions.showBoard();
    searchInput.value = "ship";
    setActiveElement(mockDocument, searchInput);
    actions.updateSearch("ship");

    let prevented = false;
    actions.handleKeydown({
      key: "Escape",
      preventDefault() {
        prevented = true;
      },
    } as KeyboardEvent);

    await new Promise((resolve) => setTimeout(resolve, 220));

    expect(prevented).toBe(true);
    expect(searchInput.value).toBe("");
    expect(searchInput.blurred).toBe(true);
    expect(model.getBoardState().search).toBe("");
    expect(mockWindow.calls).toEqual([
      { mode: "push", url: "/board#epic=epic-1" },
    ]);

    cleanup();
  });

  test("task-only deep links canonicalize to the owning epic board state", () => {
    globalThis.document = createMockDocument();
    globalThis.HTMLInputElement = class {} as typeof HTMLInputElement;
    globalThis.localStorage = createMockStorage() as Storage;
    const mockWindow = createMockWindow();
    mockWindow.window.location.hash = "#task=task-1";
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const model = createStore(createSnapshot());
    syncUrlHash(model);

    expect(model.getBoardState()).toMatchObject({
      screen: "tasks",
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
    });
    expect(mockWindow.calls).toEqual([
      { mode: "replace", url: "/board#epic=epic-1&task=task-1" },
    ]);
  });
});
