import { describe, expect, mock, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createOverlayFocusTrap } from "../../src/board/assets/runtime/focus-trap.js";

type Listener = (event: unknown) => void;

function createMockDocument() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    listeners,
    addEventListener(type: string, listener: Listener) {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener);
    },
    listenerCount(type: string) {
      return listeners.get(type)?.size ?? 0;
    },
    dispatch(type: string, event: unknown) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
  };
}

describe("createOverlayFocusTrap", () => {
  test("does not attach listeners until attach() is called", () => {
    const doc = createMockDocument();
    createOverlayFocusTrap({
      doc: doc as unknown as Document,
      onTabKey: () => {},
      onFocusIn: () => {},
    });

    // Acceptance: Tab outside any overlay reaches normal browser flow because
    // the document keydown handler isn't even installed yet.
    expect(doc.listenerCount("keydown")).toBe(0);
    expect(doc.listenerCount("focusin")).toBe(0);
  });

  test("attach() installs keydown + focusin; detach() removes them", () => {
    const doc = createMockDocument();
    const trap = createOverlayFocusTrap({
      doc: doc as unknown as Document,
      onTabKey: () => {},
      onFocusIn: () => {},
    });

    trap.attach();
    expect(trap.isAttached()).toBe(true);
    expect(doc.listenerCount("keydown")).toBe(1);
    expect(doc.listenerCount("focusin")).toBe(1);

    trap.detach();
    expect(trap.isAttached()).toBe(false);
    expect(doc.listenerCount("keydown")).toBe(0);
    expect(doc.listenerCount("focusin")).toBe(0);
  });

  test("repeated attach()/detach() are idempotent and do not stack listeners", () => {
    const doc = createMockDocument();
    const trap = createOverlayFocusTrap({
      doc: doc as unknown as Document,
      onTabKey: () => {},
      onFocusIn: () => {},
    });

    trap.attach();
    trap.attach();
    trap.attach();
    expect(doc.listenerCount("keydown")).toBe(1);

    trap.detach();
    trap.detach();
    expect(doc.listenerCount("keydown")).toBe(0);
  });

  test("Tab keydowns are routed to onTabKey only while attached", () => {
    const doc = createMockDocument();
    const onTabKey = mock(() => {});
    const trap = createOverlayFocusTrap({
      doc: doc as unknown as Document,
      onTabKey,
      onFocusIn: () => {},
    });

    // Detached: Tab outside any overlay should not call onTabKey.
    doc.dispatch("keydown", { key: "Tab" });
    expect(onTabKey).not.toHaveBeenCalled();

    trap.attach();
    doc.dispatch("keydown", { key: "Tab" });
    expect(onTabKey).toHaveBeenCalledTimes(1);

    trap.detach();
    doc.dispatch("keydown", { key: "Tab" });
    expect(onTabKey).toHaveBeenCalledTimes(1);
  });

  test("falls back to a no-op trap when no document is available", () => {
    const trap = createOverlayFocusTrap({
      doc: null as unknown as Document,
      onTabKey: () => {},
      onFocusIn: () => {},
    });

    expect(() => trap.attach()).not.toThrow();
    expect(() => trap.detach()).not.toThrow();
    expect(trap.isAttached()).toBe(false);
  });
});
