/**
 * URL hash synchronization for board state.
 *
 * Serializes epic, task, search, and view into the URL hash so that
 * browser back/forward and refresh preserve board navigation.
 * Theme stays in localStorage; token stays in sessionStorage.
 */

const DEFAULT_VIEW = "kanban";

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
 * - On store changes, updates the URL hash via replaceState (no history entry).
 * - On hashchange (browser back/forward), reads the hash and updates store state.
 *
 * @param {object} store - Observable store from createStore
 * @returns {() => void} Cleanup function that removes event listeners and unsubscribes
 */
export function syncUrlHash(store) {
  let suppressHashChange = false;

  // Restore state from current URL hash on init
  if (window.location.hash.length > 1) {
    const urlState = hashToState(window.location.hash);
    store.syncState(urlState);
    store.persist();
  } else {
    // Write current state to URL
    const state = store.store;
    const hash = stateToHash(state);
    if (hash.length > 0) {
      window.history.replaceState(null, "", `#${hash}`);
    }
  }

  // Store → URL: update hash when state changes
  const unsubscribe = store.subscribe(() => {
    const state = store.store;
    const hash = stateToHash(state);
    const currentHash = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;

    if (hash !== currentHash) {
      suppressHashChange = true;
      const url = hash.length > 0 ? `#${hash}` : window.location.pathname;
      window.history.replaceState(null, "", url);
      // Allow hashchange to fire and be ignored
      queueMicrotask(() => {
        suppressHashChange = false;
      });
    }
  });

  // URL → Store: respond to browser back/forward
  function onHashChange() {
    if (suppressHashChange) return;
    const urlState = hashToState(window.location.hash);
    store.syncState(urlState);
    store.persist();
  }

  window.addEventListener("hashchange", onHashChange);

  return () => {
    unsubscribe();
    window.removeEventListener("hashchange", onHashChange);
  };
}
