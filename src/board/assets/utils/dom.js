function escapeSelector(value) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }

  return String(value).replaceAll(/(["\\])/g, "\\$1");
}

function buildAttributeSelector(attribute, value) {
  return `[${attribute}="${escapeSelector(value)}"]`;
}

function captureFieldSelection(element) {
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    return null;
  }

  return {
    selectionStart: typeof element.selectionStart === "number" ? element.selectionStart : null,
    selectionEnd: typeof element.selectionEnd === "number" ? element.selectionEnd : null,
  };
}

function resolveFocusSelector(element) {
  if (!(element instanceof HTMLElement)) {
    return null;
  }

  if (element.id) {
    return { selector: `#${escapeSelector(element.id)}`, selection: captureFieldSelection(element) };
  }

  const formField = element.closest("[data-task-form], [data-subtask-form], [data-create-subtask-form], [data-dependency-form]");
  if (formField instanceof HTMLElement && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) && element.name) {
    const attributeName = Array.from(formField.attributes)
      .find((attribute) => attribute.name.startsWith("data-") && attribute.name.endsWith("-form"))?.name;
    const attributeValue = attributeName ? formField.getAttribute(attributeName) : null;
    if (attributeName && attributeValue) {
      return {
        selector: `${buildAttributeSelector(attributeName, attributeValue)} [name="${escapeSelector(element.name)}"]`,
        selection: captureFieldSelection(element),
      };
    }
  }

  const attributeNames = [
    "data-open-epic",
    "data-task-id",
    "data-open-subtask",
    "data-close-task",
    "data-close-subtask",
    "data-nav",
    "data-nav-board",
    "data-view",
    "data-action",
    "data-delete-subtask",
    "data-remove-dependency-source",
  ];

  for (const attributeName of attributeNames) {
    const owner = element.closest(`[${attributeName}]`);
    if (!(owner instanceof HTMLElement)) {
      continue;
    }

    const attributeValue = owner.getAttribute(attributeName);
    if (attributeValue === null || attributeValue === "") {
      return { selector: `[${attributeName}]`, selection: null };
    }

    return { selector: buildAttributeSelector(attributeName, attributeValue), selection: null };
  }

  return null;
}

function captureScrollState(root) {
  const scrollSelectors = [
    ".board-sidebar__list",
    ".board-kanban",
    ".board-list__rows",
    ".board-drawer__body",
    ".board-modal__body",
  ];
  const scrollState = [];

  for (const selector of scrollSelectors) {
    const element = root.querySelector(selector);
    if (element instanceof HTMLElement) {
      scrollState.push({ selector, top: element.scrollTop, left: element.scrollLeft });
    }
  }

  root.querySelectorAll("[id^='column-']").forEach((element) => {
    if (element instanceof HTMLElement && element.id) {
      scrollState.push({ selector: `#${escapeSelector(element.id)}`, top: element.scrollTop, left: element.scrollLeft });
    }
  });

  return scrollState;
}

export function syncOverlayScrollLock(isLocked) {
  document.documentElement.style.overflow = isLocked ? "hidden" : "";
  document.body.style.overflow = isLocked ? "hidden" : "";
}

export function captureRuntimeState(root, store) {
  if (!(root instanceof HTMLElement)) {
    return null;
  }

  const focusState = resolveFocusSelector(document.activeElement);
  return {
    focusState,
    scrollState: captureScrollState(root),
    fallbackTaskId: store?.selectedTaskId ?? null,
    fallbackEpicId: store?.selectedEpicId ?? null,
  };
}

export function restoreRuntimeState(root, runtimeState) {
  if (!(root instanceof HTMLElement) || !runtimeState) {
    return;
  }

  for (const { selector, top, left } of runtimeState.scrollState ?? []) {
    const element = root.querySelector(selector);
    if (element instanceof HTMLElement) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }

  const focusCandidates = [];
  if (runtimeState.focusState?.selector) {
    focusCandidates.push(runtimeState.focusState.selector);
  }
  if (runtimeState.fallbackTaskId) {
    focusCandidates.push(buildAttributeSelector("data-task-id", runtimeState.fallbackTaskId));
  }
  if (runtimeState.fallbackEpicId) {
    focusCandidates.push(buildAttributeSelector("data-open-epic", runtimeState.fallbackEpicId));
  }
  focusCandidates.push("#board-search-input");

  for (const selector of focusCandidates) {
    const element = root.querySelector(selector);
    if (!(element instanceof HTMLElement)) {
      continue;
    }

    element.focus({ preventScroll: true });
    const selection = runtimeState.focusState?.selector === selector ? runtimeState.focusState.selection : null;
    if (selection && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && selection.selectionStart !== null) {
      element.setSelectionRange(selection.selectionStart, selection.selectionEnd ?? selection.selectionStart);
    }
    break;
  }
}
