import { afterEach, describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { hashToState, stateToHash, syncUrlHash } from "../../src/board/assets/state/url.js";

type Listener = () => void;

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

function createMockStore(initialState: {
  selectedEpicId: string | null;
  selectedTaskId: string | null;
  search: string;
  view: string;
}, options: {
  syncState?: (patch: Partial<{
    selectedEpicId: string | null;
    selectedTaskId: string | null;
    search: string;
    view: string;
  }>, store: {
    selectedEpicId: string | null;
    selectedTaskId: string | null;
    search: string;
    view: string;
  }) => Partial<{
    selectedEpicId: string | null;
    selectedTaskId: string | null;
    search: string;
    view: string;
  }> | void;
} = {}) {
  const listeners = new Set<Listener>();
  const store = { ...initialState };

  return {
    store,
    persist() {
      // no-op for tests
    },
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    syncState(patch: Partial<typeof store>) {
      const reconciled = options.syncState?.(patch, store) ?? patch;
      Object.assign(store, reconciled);
      return { ...store };
    },
    emit() {
      for (const listener of listeners) {
        listener();
      }
    },
  };
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
    listeners,
    window: mockWindow,
  };
}

const originalWindow = globalThis.window;

afterEach(() => {
  if (originalWindow === undefined) {
    Reflect.deleteProperty(globalThis, "window");
    return;
  }

  globalThis.window = originalWindow;
});

describe("board URL state sync", () => {
  test("round-trips serialized board state", () => {
    const hash = stateToHash({
      screen: "tasks",
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
      search: "roadmap",
      view: "list",
    });

    expect(hash).toBe("epic=epic-1&task=task-1&search=roadmap&view=list");
    expect(hashToState(hash)).toEqual({
      selectedEpicId: "epic-1",
      selectedTaskId: "task-1",
      search: "roadmap",
      view: "list",
      screen: "tasks",
    });
  });

  test("serializes selected epic overview distinctly from board view", () => {
    const hash = stateToHash({
      screen: "epics",
      selectedEpicId: "epic-1",
      selectedTaskId: null,
      search: "",
      view: "kanban",
    });

    expect(hash).toBe("epic=epic-1&screen=epics");
    expect(hashToState(hash)).toEqual({
      selectedEpicId: "epic-1",
      selectedTaskId: null,
      search: "",
      view: "kanban",
      screen: "epics",
    });
  });

  test("replaces noisy changes but pushes major navigation", () => {
    const mockStore = createMockStore({
      selectedEpicId: "epic-1",
      selectedTaskId: null,
      search: "",
      view: "kanban",
    });
    const mockWindow = createMockWindow();
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const cleanup = syncUrlHash(mockStore);

    expect(mockWindow.calls).toEqual([
      { mode: "replace", url: "/board#epic=epic-1" },
    ]);

    mockStore.store.search = "ship";
    mockStore.emit();
    expect(mockWindow.calls.at(-1)).toEqual({
      mode: "replace",
      url: "/board#epic=epic-1&search=ship",
    });

    mockStore.store.selectedTaskId = "task-1";
    mockStore.emit();
    expect(mockWindow.calls.at(-1)).toEqual({
      mode: "replace",
      url: "/board#epic=epic-1&task=task-1&search=ship",
    });

    mockStore.store.selectedEpicId = "epic-2";
    mockStore.store.selectedTaskId = null;
    mockStore.emit();
    expect(mockWindow.calls.at(-1)).toEqual({
      mode: "push",
      url: "/board#epic=epic-2&search=ship",
    });

    mockStore.store.view = "list";
    mockStore.emit();
    expect(mockWindow.calls.at(-1)).toEqual({
      mode: "push",
      url: "/board#epic=epic-2&search=ship&view=list",
    });

    cleanup();
    expect(mockWindow.listeners.get("popstate")?.size ?? 0).toBe(0);
  });

  test("canonicalizes invalid initial deep links with replaceState", () => {
    const mockStore = createMockStore({
      selectedEpicId: null,
      selectedTaskId: null,
      search: "",
      view: "kanban",
    }, {
      syncState(patch) {
        return {
          selectedEpicId: patch.selectedEpicId === "missing-epic" ? null : patch.selectedEpicId ?? null,
          selectedTaskId: patch.selectedTaskId === "missing-task" ? null : patch.selectedTaskId ?? null,
          search: patch.search ?? "",
          view: patch.view ?? "kanban",
        };
      },
    });
    const mockWindow = createMockWindow();
    mockWindow.window.location.hash = "#epic=missing-epic&task=missing-task&search=ship&view=list";
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    syncUrlHash(mockStore);

    expect(mockStore.store).toEqual({
      selectedEpicId: null,
      selectedTaskId: null,
      search: "ship",
      view: "list",
    });
    expect(mockWindow.calls).toEqual([
      { mode: "replace", url: "/board#search=ship&view=list" },
    ]);
  });

  test("canonicalizes invalid popstate deep links without push spam", () => {
    const mockStore = createMockStore({
      selectedEpicId: "epic-1",
      selectedTaskId: null,
      search: "",
      view: "kanban",
    }, {
      syncState(patch) {
        return {
          selectedEpicId: patch.selectedEpicId === "missing-epic" ? null : patch.selectedEpicId ?? null,
          selectedTaskId: patch.selectedTaskId === "missing-task" ? null : patch.selectedTaskId ?? null,
          search: patch.search ?? "",
          view: patch.view ?? "kanban",
        };
      },
    });
    const mockWindow = createMockWindow();
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const cleanup = syncUrlHash(mockStore);
    expect(mockWindow.calls).toEqual([
      { mode: "replace", url: "/board#epic=epic-1" },
    ]);

    mockWindow.window.location.hash = "#epic=missing-epic&task=missing-task&search=ship";
    mockWindow.emit("popstate");

    expect(mockStore.store).toEqual({
      selectedEpicId: null,
      selectedTaskId: null,
      search: "ship",
      view: "kanban",
    });
    expect(mockWindow.calls).toEqual([
      { mode: "replace", url: "/board#epic=epic-1" },
      { mode: "replace", url: "/board#search=ship" },
    ]);

    cleanup();
  });

  test("restores cancel stale pending work before applying popstate state", () => {
    const calls: string[] = [];
    const mockStore = createMockStore({
      selectedEpicId: "epic-1",
      selectedTaskId: null,
      search: "",
      view: "kanban",
    });
    const mockWindow = createMockWindow();
    globalThis.window = mockWindow.window as unknown as Window & typeof globalThis;

    const cleanup = syncUrlHash(mockStore, {
      beforeRestore() {
        calls.push("beforeRestore");
      },
      onRestore() {
        calls.push("onRestore");
      },
    });

    mockWindow.window.location.hash = "#epic=epic-2&search=ship";
    mockWindow.emit("popstate");

    expect(calls).toEqual(["beforeRestore", "onRestore"]);
    expect(mockStore.store).toEqual({
      screen: "tasks",
      selectedEpicId: "epic-2",
      selectedTaskId: null,
      search: "ship",
      view: "kanban",
    });

    cleanup();
  });
});
