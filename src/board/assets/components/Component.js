/**
 * Base component utilities for the board UI.
 *
 * Each component is a factory function returning { mount, update, unmount }.
 * - mount(container) binds the component to a DOM element.
 * - update(props)    renders or patches DOM based on new props.
 * - unmount()        cleans up and removes content.
 */

/**
 * Save and restore the value + cursor of an input or textarea across a DOM write.
 *
 * @param {HTMLElement} container
 * @param {string}      selector  CSS selector for the input element
 * @param {() => void}  writeFn   Function that mutates the DOM
 */
export function preserveInput(container, selector, writeFn) {
  const input = container.querySelector(selector);
  const state = input
    ? {
        value: input.value,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
        focused: document.activeElement === input,
      }
    : null;

  writeFn();

  if (state) {
    const restored = container.querySelector(selector);
    if (restored) {
      restored.value = state.value;
      if (state.focused) {
        restored.focus({ preventScroll: true });
        try {
          restored.setSelectionRange(state.selectionStart, state.selectionEnd);
        } catch {
          // setSelectionRange not supported on all input types
        }
      }
    }
  }
}

/**
 * Capture the full state of every form input inside a container, execute a DOM
 * write, then restore all captured values and focus.
 *
 * It uses a hierarchical identity (closest [data-form-id] or [data-task-form] etc.
 * plus the input name/id) to ensure correct restoration even when multiple
 * forms with similar field names exist in the same container.
 *
 * @param {HTMLElement} container
 * @param {() => void}  writeFn
 */
export function preserveFormState(container, writeFn) {
  const inputs = Array.from(
    container.querySelectorAll("input, textarea, select"),
  );

  const activeElement = document.activeElement;
  let focusedIdentity = null;

  function getFormIdentity(el) {
    const form = el.closest("form, [data-form-id], [data-task-form], [data-subtask-form], [data-create-subtask-form], [data-dependency-form]");
    if (!form) return "default-form";
    return form.getAttribute("data-form-id")
      || form.getAttribute("data-task-form")
      || form.getAttribute("data-subtask-form")
      || form.getAttribute("data-create-subtask-form")
      || form.getAttribute("data-dependency-form")
      || form.id
      || "anonymous-form";
  }

  function getControlSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name) return `[name="${CSS.escape(el.name)}"]`;
    return null;
  }

  const savedStates = inputs.map((el) => {
    const formId = getFormIdentity(el);
    const selector = getControlSelector(el);
    const identity = selector ? { formId, selector } : null;

    if (activeElement === el) {
      focusedIdentity = identity;
    }

    return {
      identity,
      value: el.value,
      selectionStart: el.selectionStart,
      selectionEnd: el.selectionEnd,
    };
  }).filter(s => s.identity);

  writeFn();

  for (const state of savedStates) {
    const { formId, selector } = state.identity;
    // Find the form first to avoid cross-form collisions
    const forms = Array.from(container.querySelectorAll("form, [data-form-id], [data-task-form], [data-subtask-form], [data-create-subtask-form], [data-dependency-form]"));
    const form = forms.find(f => getFormIdentity(f) === formId) || container;
    
    const restored = form.querySelector(selector);
    if (restored && restored.value !== state.value) {
      restored.value = state.value;
      try {
        if (state.selectionStart !== null) {
          restored.setSelectionRange(state.selectionStart, state.selectionEnd);
        }
      } catch {
        // not all elements support setSelectionRange
      }
    }
  }

  // Restore focus
  if (focusedIdentity) {
    const { formId, selector } = focusedIdentity;
    const forms = Array.from(container.querySelectorAll("form, [data-form-id], [data-task-form], [data-subtask-form], [data-create-subtask-form], [data-dependency-form]"));
    const form = forms.find(f => getFormIdentity(f) === formId) || container;
    form.querySelector(selector)?.focus({ preventScroll: true });
  }
}

/**
 * Capture open/closed state of all `<details>` elements and restore after a DOM write.
 *
 * @param {HTMLElement} container
 * @param {() => void}  writeFn
 */
export function preserveDetailsState(container, writeFn) {
  const details = Array.from(container.querySelectorAll("details"));
  const openStates = details.map((el, i) => ({
    index: i,
    open: el.open,
  }));

  writeFn();

  const newDetails = Array.from(container.querySelectorAll("details"));
  for (const state of openStates) {
    const target = newDetails[state.index];
    if (target && target.open !== state.open) {
      target.open = state.open;
    }
  }
}

/**
 * Create a simple component from a render function.
 * Replaces innerHTML on every update. Suitable for components that don't
 * contain user-editable inputs.
 *
 * @param {(props: object) => string} renderFn
 * @returns {{ mount: (el: HTMLElement) => object, update: (props: object) => void, unmount: () => void }}
 */
export function createSimpleComponent(renderFn) {
  let container = null;
  let lastHtml = null;

  const component = {
    mount(el) {
      container = el;
      lastHtml = null;
      return component;
    },
    update(props) {
      if (!container) return;
      const html = renderFn(props);
      if (html !== lastHtml) {
        container.innerHTML = html;
        lastHtml = html;
      }
    },
    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      lastHtml = null;
    },
  };

  return component;
}
