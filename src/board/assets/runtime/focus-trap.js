/**
 * Lazy overlay focus-trap controller.
 *
 * Attaches the document-level keydown/focusin listeners only while an overlay
 * is actually open, and detaches them on close. Without this, plain Tab outside
 * any overlay can be intercepted by a stale handler in the microtask window
 * between overlay close and rerender.
 *
 * @param {{
 *   doc?: Document,
 *   onTabKey: (event: KeyboardEvent) => void,
 *   onFocusIn: (event: FocusEvent) => void,
 * }} options
 */
export function createOverlayFocusTrap(options) {
  const doc = options.doc ?? (typeof document !== "undefined" ? document : null);
  if (!doc) {
    return {
      attach() {},
      detach() {},
      isAttached() { return false; },
    };
  }

  const onKeyDown = options.onTabKey;
  const onFocusIn = options.onFocusIn;
  let attached = false;

  function attach() {
    if (attached) return;
    doc.addEventListener("keydown", onKeyDown, true);
    doc.addEventListener("focusin", onFocusIn, true);
    attached = true;
  }

  function detach() {
    if (!attached) return;
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("focusin", onFocusIn, true);
    attached = false;
  }

  return {
    attach,
    detach,
    isAttached() { return attached; },
  };
}
