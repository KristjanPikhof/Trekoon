export const SCROLL_AUTHORITY = Object.freeze({
  page: "page",
  workspace: "workspace",
  inspector: "inspector",
  taskModal: "task-modal",
  subtaskModal: "subtask-modal",
});

const SCROLL_OWNER_CONFIG = {
  [SCROLL_AUTHORITY.page]: {
    containerSelector: ".board-layout",
    scrollSelectors: [".board-layout"],
    defaultFocusSelectors: ["#board-search-input", "[data-nav-board]", "[data-open-epic]"],
  },
  [SCROLL_AUTHORITY.workspace]: {
    containerSelector: "[data-scroll-surface='workspace']",
    scrollSelectors: ["[data-scroll-surface='workspace']"],
    defaultFocusSelectors: [
      "[data-task-id][aria-pressed='true']",
      "[data-task-id]",
      "#board-search-input",
      "[data-open-epic][aria-current='true']",
      "[data-open-epic]",
    ],
  },
  [SCROLL_AUTHORITY.inspector]: {
    containerSelector: "[data-scroll-surface='inspector']",
    scrollSelectors: ["[data-scroll-surface='inspector']"],
    defaultFocusSelectors: ["[data-task-form] [name='title']", "[data-close-task]"],
  },
  [SCROLL_AUTHORITY.taskModal]: {
    containerSelector: "[data-scroll-surface='task-modal']",
    scrollSelectors: ["[data-scroll-surface='task-modal']"],
    defaultFocusSelectors: [".board-task-modal [data-task-form] [name='title']", ".board-task-modal [data-close-task]"],
  },
  [SCROLL_AUTHORITY.subtaskModal]: {
    containerSelector: "[data-scroll-surface='subtask-modal']",
    scrollSelectors: ["[data-scroll-surface='subtask-modal']"],
    defaultFocusSelectors: ["[data-subtask-form] [name='title']", "[data-close-subtask]"],
  },
};

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

export function resolveFocusSelector(element) {
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

function captureScrollState(root, owner) {
  const scrollSelectors = SCROLL_OWNER_CONFIG[owner]?.scrollSelectors ?? [];
  const scrollState = [];

  for (const selector of scrollSelectors) {
    const element = root.querySelector(selector);
    if (element instanceof HTMLElement) {
      scrollState.push({ selector, top: element.scrollTop, left: element.scrollLeft });
    }
  }

  return scrollState;
}

function resolveOwnerContainer(root, owner) {
  const selector = SCROLL_OWNER_CONFIG[owner]?.containerSelector;
  if (!selector) {
    return null;
  }

  const element = root.querySelector(selector);
  return element instanceof HTMLElement ? element : null;
}

function buildFocusCandidates(owner, runtimeState, focusOverride) {
  const focusCandidates = [];

  if (focusOverride?.selector) {
    focusCandidates.push({ selector: focusOverride.selector, selection: focusOverride.selection ?? null });
  }

  if (runtimeState?.focusState?.selector) {
    focusCandidates.push({ selector: runtimeState.focusState.selector, selection: runtimeState.focusState.selection ?? null });
  }

  for (const selector of SCROLL_OWNER_CONFIG[owner]?.defaultFocusSelectors ?? []) {
    focusCandidates.push({ selector, selection: null });
  }

  if (owner === SCROLL_AUTHORITY.workspace || owner === SCROLL_AUTHORITY.page) {
    if (runtimeState?.fallbackTaskId) {
      focusCandidates.push({ selector: buildAttributeSelector("data-task-id", runtimeState.fallbackTaskId), selection: null });
    }
    if (runtimeState?.fallbackEpicId) {
      focusCandidates.push({ selector: buildAttributeSelector("data-open-epic", runtimeState.fallbackEpicId), selection: null });
    }
    focusCandidates.push({ selector: "#board-search-input", selection: null });
  }

  return focusCandidates;
}

export function resolveScrollAuthorityStack(boardState, options = {}) {
  const useTaskModal = options.useTaskModal === true;
  if (boardState?.screen !== "tasks") {
    return [SCROLL_AUTHORITY.page];
  }

  const stack = [SCROLL_AUTHORITY.workspace];
  if (boardState?.selectedTask) {
    stack.push(useTaskModal ? SCROLL_AUTHORITY.taskModal : SCROLL_AUTHORITY.inspector);
  }
  if (boardState?.selectedSubtask) {
    stack.push(SCROLL_AUTHORITY.subtaskModal);
  }
  return stack;
}

export function syncScrollAuthority(root, ownerStack) {
  if (!(root instanceof HTMLElement)) {
    return null;
  }

  const activeOwner = ownerStack.at(-1) ?? SCROLL_AUTHORITY.page;
  root.dataset.scrollOwner = activeOwner;
  root.querySelectorAll("[data-scroll-surface]").forEach((element) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }

    element.dataset.scrollActive = element.dataset.scrollSurface === activeOwner ? "true" : "false";
  });
  return activeOwner;
}

export function createScrollAuthorityStack(initialStack = [SCROLL_AUTHORITY.page]) {
  const runtimeStates = new Map();
  const returnFocusStates = new Map();
  let ownerStack = [...initialStack];

  return {
    capture(root, store) {
      const activeOwner = ownerStack.at(-1) ?? SCROLL_AUTHORITY.page;
      const runtimeState = captureRuntimeState(root, store, activeOwner);
      if (runtimeState) {
        runtimeStates.set(activeOwner, runtimeState);
      }
    },
    rememberReturnFocus(owner, focusState) {
      if (!owner || !focusState?.selector) {
        return;
      }
      returnFocusStates.set(owner, focusState);
    },
    transition(nextOwnerStack) {
      ownerStack = Array.isArray(nextOwnerStack) && nextOwnerStack.length > 0
        ? [...nextOwnerStack]
        : [SCROLL_AUTHORITY.page];
      const activeOwner = ownerStack.at(-1) ?? SCROLL_AUTHORITY.page;
      return {
        owner: activeOwner,
        runtimeState: runtimeStates.get(activeOwner) ?? null,
        returnFocusState: returnFocusStates.get(activeOwner) ?? null,
      };
    },
  };
}

export function syncOverlayScrollLock(isLocked) {
  document.documentElement.style.overflow = isLocked ? "hidden" : "";
  document.body.style.overflow = isLocked ? "hidden" : "";
}

export function captureRuntimeState(root, store, owner = SCROLL_AUTHORITY.page) {
  if (!(root instanceof HTMLElement)) {
    return null;
  }

  const ownerContainer = resolveOwnerContainer(root, owner);
  const activeElement = document.activeElement;
  const focusState = ownerContainer instanceof HTMLElement && ownerContainer.contains(activeElement)
    ? resolveFocusSelector(activeElement)
    : null;

  return {
    owner,
    focusState,
    scrollState: captureScrollState(root, owner),
    fallbackTaskId: store?.selectedTaskId ?? null,
    fallbackEpicId: store?.selectedEpicId ?? null,
  };
}

export function restoreRuntimeState(root, payload) {
  if (!(root instanceof HTMLElement) || !payload) {
    return;
  }

  const owner = payload.owner ?? payload.runtimeState?.owner ?? SCROLL_AUTHORITY.page;
  const runtimeState = payload.runtimeState ?? payload;

  for (const { selector, top, left } of runtimeState.scrollState ?? []) {
    const element = root.querySelector(selector);
    if (element instanceof HTMLElement) {
      element.scrollTop = top;
      element.scrollLeft = left;
    }
  }

  const ownerContainer = resolveOwnerContainer(root, owner) ?? root;
  const focusCandidates = buildFocusCandidates(owner, runtimeState, payload.returnFocusState);

  for (const candidate of focusCandidates) {
    const element = root.querySelector(candidate.selector);
    if (!(element instanceof HTMLElement)) {
      continue;
    }
    if (ownerContainer instanceof HTMLElement && !ownerContainer.contains(element) && owner !== SCROLL_AUTHORITY.page) {
      continue;
    }

    element.focus({ preventScroll: true });
    const selection = candidate.selection;
    if (selection && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && selection.selectionStart !== null) {
      element.setSelectionRange(selection.selectionStart, selection.selectionEnd ?? selection.selectionStart);
    }
    break;
  }
}
