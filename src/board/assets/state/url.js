/**
 * URL hash synchronization for board state.
 *
 * Serializes epic, task, search, and view into the URL hash so that
 * browser back/forward and refresh preserve board navigation.
 * Theme stays in localStorage; token stays in sessionStorage.
 */

const DEFAULT_VIEW = "kanban";

function toHistoryState(state) {
  return {
    selectedEpicId: state.selectedEpicId || null,
    view: state.view || DEFAULT_VIEW,
  };
}

function shouldPushHistoryEntry(previousState, nextState) {
  if (!previousState) {
    return false;
  }

  return previousState.selectedEpicId !== nextState.selectedEpicId
    || previousState.view !== nextState.view;
}

/**
 * Serialize board-relevant state fields into a URL hash string.
 * Omits default values to keep the URL clean.
 *
 * @param {object} state
 * @param {string|null} state.selectedEpicId
 * @param {string|null} state.selectedTaskId
 * @param {string} state.search
 * @param {string} state.view
 * @returns {string} Hash string without leading '#'
 */
export function stateToHash(state) {
  const params = new URLSearchParams();

  if (state.selectedEpicId) {
    params.set("epic", state.selectedEpicId);
  }
  if (state.selectedTaskId) {
    params.set("task", state.selectedTaskId);
  }
  if (state.search && state.search.trim().length > 0) {
    params.set("search", state.search);
  }
  if (state.view && state.view !== DEFAULT_VIEW) {
    params.set("view", state.view);
  }

  const hash = params.toString();
  return hash;
}

/**
 * Parse a URL hash string back into state fields.
 *
 * @param {string} hash - Hash string (with or without leading '#')
 * @returns {{ selectedEpicId: string|null, selectedTaskId: string|null, search: string, view: string, screen: string }}
 */
export function hashToState(hash) {
  const cleaned = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(cleaned);

  const epicId = params.get("epic") || null;
  const taskId = params.get("task") || null;
  const search = params.get("search") || "";
  const view = params.get("view") || DEFAULT_VIEW;

  return {
    selectedEpicId: epicId,
    selectedTaskId: taskId,
    search,
    view,
    screen: epicId ? "tasks" : "epics",
  };
}

/**
 * Set up bidirectional URL hash synchronization with a store.
 *
 * - On store changes, pushes history for major navigation changes and replaces
 *   the current entry for noisy state like transient selection/search.
 * - On hashchange (browser back/forward), reads the hash and updates store state.
 *
 * @param {object} store - Observable store from createStore
 * @param {object} [options]
 * @param {() => void} [options.onRestore] - Callback after URL-driven state restore
 * @returns {() => void} Cleanup function that removes event listeners and unsubscribes
 */
export function syncUrlHash(store, options = {}) {
  const { onRestore } = options;
  let isApplyingLocation = false;
  let lastSerializedState = "";
  let lastHistoryState = toHistoryState(store.store);

  function serializeCurrentState() {
    return stateToHash(store.store);
  }

  function buildUrl(hash) {
    const { pathname, search } = window.location;
    return `${pathname}${search}${hash.length > 0 ? `#${hash}` : ""}`;
  }

  function applyLocation(hash, mode) {
    const nextUrl = buildUrl(hash);
    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    lastSerializedState = hash;
    if (nextUrl === currentUrl) {
      return;
    }

    if (mode === "push") {
      window.history.pushState({ boardHash: hash }, "", nextUrl);
      return;
    }

    window.history.replaceState({ boardHash: hash }, "", nextUrl);
  }

  function restoreFromLocation() {
    isApplyingLocation = true;
    const urlState = hashToState(window.location.hash);
    store.syncState(urlState);
    store.persist();
    lastSerializedState = serializeCurrentState();
    lastHistoryState = toHistoryState(store.store);
    isApplyingLocation = false;
    onRestore?.();
  }

  // Restore state from current URL hash on init
  if (window.location.hash.length > 1) {
    restoreFromLocation();
  } else {
    applyLocation(serializeCurrentState(), "replace");
  }

  // Store → URL: update hash when state changes
  const unsubscribe = store.subscribe(() => {
    if (isApplyingLocation) {
      return;
    }

    const hash = serializeCurrentState();
    if (hash !== lastSerializedState) {
      const nextHistoryState = toHistoryState(store.store);
      const mode = shouldPushHistoryEntry(lastHistoryState, nextHistoryState) ? "push" : "replace";
      applyLocation(hash, mode);
      lastHistoryState = nextHistoryState;
    }
  });

  // URL → Store: respond to browser back/forward
  function onPopState() {
    restoreFromLocation();
  }

  window.addEventListener("popstate", onPopState);

  return () => {
    unsubscribe();
    window.removeEventListener("popstate", onPopState);
  };
}
