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

const FORM_ROOT_SELECTOR = [
  "form",
  "[data-form-id]",
  "[data-task-form]",
  "[data-subtask-form]",
  "[data-create-subtask-form]",
  "[data-dependency-form]",
].join(", ");

function getFormRoot(el) {
  if (!el) return null;
  return el.matches(FORM_ROOT_SELECTOR) ? el : el.closest(FORM_ROOT_SELECTOR);
}

function getNamespacedFormIdentity(form) {
  if (!form) return "default-form";
  if (form.hasAttribute("data-form-id")) {
    return `form:${form.getAttribute("data-form-id")}`;
  }
  if (form.hasAttribute("data-task-form")) {
    return `task:${form.getAttribute("data-task-form")}`;
  }
  if (form.hasAttribute("data-subtask-form")) {
    return `subtask:${form.getAttribute("data-subtask-form")}`;
  }
  if (form.hasAttribute("data-create-subtask-form")) {
    return `create-subtask:${form.getAttribute("data-create-subtask-form")}`;
  }
  if (form.hasAttribute("data-dependency-form")) {
    return `dependency:${form.getAttribute("data-dependency-form")}`;
  }
  if (form.id) {
    return `id:${form.id}`;
  }
  return "anonymous-form";
}

function getManagedControls(root) {
  return Array.from(root.querySelectorAll("input, textarea, select"));
}

function getControlIdentity(el, form) {
  const controlKey = el.getAttribute("data-control-id");
  if (controlKey) {
    return `control:${controlKey}`;
  }

  if (el.id) {
    return `id:${el.id}`;
  }

  const name = el.getAttribute("name");
  if (name) {
    const tagName = el.tagName.toLowerCase();
    const type = tagName === "input" ? (el.getAttribute("type") ?? "text") : tagName;
    const peers = getManagedControls(form).filter((candidate) => candidate.getAttribute("name") === name);
    const index = peers.indexOf(el);
    return `name:${name}:${type}:${index}`;
  }

  const index = getManagedControls(form).indexOf(el);
  return `index:${index}:${el.tagName.toLowerCase()}`;
}

function captureSelection(el) {
  if (typeof el.selectionStart !== "number") {
    return { selectionStart: null, selectionEnd: null };
  }

  return {
    selectionStart: el.selectionStart,
    selectionEnd: el.selectionEnd,
  };
}

function restoreSelection(el, selectionStart, selectionEnd) {
  if (typeof selectionStart !== "number") {
    return;
  }

  try {
    el.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
  } catch {
    // setSelectionRange is not supported on all controls
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
  const inputs = getManagedControls(container);

  const activeElement = document.activeElement;
  let focusedIdentity = null;

  const savedStates = inputs.map((el) => {
    const form = getFormRoot(el);
    const formId = getNamespacedFormIdentity(form);
    const controlId = form ? getControlIdentity(el, form) : null;
    const identity = controlId ? { formId, controlId } : null;

    if (activeElement === el) {
      focusedIdentity = identity;
    }

    const { selectionStart, selectionEnd } = captureSelection(el);

    return {
      identity,
      value: el.value,
      selectionStart,
      selectionEnd,
    };
  }).filter(s => s.identity);

  writeFn();

  const formsByIdentity = new Map(
    Array.from(container.querySelectorAll(FORM_ROOT_SELECTOR)).map((form) => [
      getNamespacedFormIdentity(form),
      form,
    ]),
  );

  for (const state of savedStates) {
    const { formId, controlId } = state.identity;
    const form = formsByIdentity.get(formId) ?? container;
    const restored = getManagedControls(form).find((control) => getControlIdentity(control, form) === controlId);
    if (restored && restored.value !== state.value) {
      restored.value = state.value;
    }

    if (restored && activeElement === container.ownerDocument?.body) {
      restoreSelection(restored, state.selectionStart, state.selectionEnd);
    }
  }

  if (focusedIdentity) {
    const { formId, controlId } = focusedIdentity;
    const form = formsByIdentity.get(formId) ?? container;
    const restored = getManagedControls(form).find((control) => getControlIdentity(control, form) === controlId);
    if (restored) {
      restored.focus({ preventScroll: true });
      const focusedState = savedStates.find((state) => state.identity?.formId === formId && state.identity?.controlId === controlId);
      if (focusedState) {
        restoreSelection(restored, focusedState.selectionStart, focusedState.selectionEnd);
      }
    }
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
