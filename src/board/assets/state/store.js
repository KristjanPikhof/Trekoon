import { normalizeSnapshot, normalizeStatus, STATUS_ORDER, VIEW_MODES } from "./utils.js";

export const THEME_STORAGE_KEY = "trekoon-board-theme";
export const STATE_STORAGE_KEY = "trekoon-board-state";

const ACTIVE_EPIC_STATUSES = new Set(["in_progress", "todo"]);

const SIDEBAR_EPIC_STATUS_PRIORITY = {
  in_progress: 0,
  todo: 1,
  blocked: 2,
  done: 3,
};

function normalizeSearch(value) {
  return typeof value === "string" ? value : "";
}

function compareEpicsForSidebar(left, right) {
  const leftStatus = normalizeStatus(left.status);
  const rightStatus = normalizeStatus(right.status);
  const statusDelta = (SIDEBAR_EPIC_STATUS_PRIORITY[leftStatus] ?? Number.MAX_SAFE_INTEGER)
    - (SIDEBAR_EPIC_STATUS_PRIORITY[rightStatus] ?? Number.MAX_SAFE_INTEGER);
  if (statusDelta !== 0) return statusDelta;
  const updatedDelta = Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0);
  if (updatedDelta !== 0) return updatedDelta;
  return left.title.localeCompare(right.title);
}

// --- Persistence helpers ---

export function readStoredState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

export function writeStoredState(nextState) {
  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState));
}

export function readThemePreference() {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "dark";
}

export function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

// --- Memoization helper ---

/**
 * Create a memoized selector that only recomputes when its dependency keys change.
 * @param {(state: object) => any[]} getDeps - Extract dependency values from state
 * @param {(...deps: any[]) => any} compute - Compute derived value from deps
 */
function createSelector(getDeps, compute) {
  let cachedDeps = null;
  let cachedResult = undefined;

  return (state) => {
    const deps = getDeps(state);
    if (cachedDeps !== null && deps.every((dep, i) => dep === cachedDeps[i])) {
      return cachedResult;
    }
    cachedDeps = deps;
    cachedResult = compute(...deps);
    return cachedResult;
  };
}

// --- Derived state selectors ---

const selectVisibleEpics = createSelector(
  (s) => [s.snapshot?.epics, s.searchQuery],
  (epics, searchQuery) => {
    if (!epics) return [];
    return searchQuery.length === 0
      ? epics
      : epics.filter((epic) => epic.searchText.includes(searchQuery));
  },
);

const selectTasksInScope = createSelector(
  (s) => [s.snapshot?.tasks, s.screen, s.selectedEpicId],
  (tasks, screen, selectedEpicId) => {
    if (!tasks) return [];
    return screen === "tasks" && selectedEpicId
      ? tasks.filter((task) => task.epicId === selectedEpicId)
      : tasks;
  },
);

const selectVisibleTasks = createSelector(
  (s) => [selectTasksInScope(s), s.searchQuery],
  (tasksInScope, searchQuery) => {
    return searchQuery.length === 0
      ? tasksInScope
      : tasksInScope.filter((task) => task.searchText.includes(searchQuery));
  },
);

const selectSelectedEpic = createSelector(
  (s) => [s.snapshot?.epics, s.selectedEpicId],
  (epics, selectedEpicId) => {
    if (!epics || !selectedEpicId) return null;
    return epics.find((epic) => epic.id === selectedEpicId) ?? null;
  },
);

const selectSelectedTask = createSelector(
  (s) => [selectVisibleTasks(s), selectTasksInScope(s), s.selectedTaskId],
  (visibleTasks, tasksInScope, selectedTaskId) => {
    if (!selectedTaskId) return null;
    const fromVisible = visibleTasks.find((task) => task.id === selectedTaskId);
    if (fromVisible) return fromVisible;
    return tasksInScope.find((task) => task.id === selectedTaskId) ?? null;
  },
);

const selectSelectedSubtask = createSelector(
  (s) => [s.snapshot?.subtasks, s.selectedTaskId, s.selectedSubtaskId],
  (subtasks, selectedTaskId, selectedSubtaskId) => {
    if (!subtasks || !selectedTaskId || !selectedSubtaskId) return null;
    return subtasks.find(
      (subtask) => subtask.id === selectedSubtaskId && subtask.taskId === selectedTaskId,
    ) ?? null;
  },
);

const selectSidebarEpics = createSelector(
  (s) => [s.snapshot?.epics, s.searchQuery],
  (epics, searchQuery) => {
    if (!epics) return [];
    const filtered = searchQuery.length === 0
      ? epics.filter((epic) => ACTIVE_EPIC_STATUSES.has(normalizeStatus(epic.status)))
      : epics.filter((epic) => epic.searchText.includes(searchQuery));
    return [...filtered].sort(compareEpicsForSidebar);
  },
);

function selectSearchScope(state) {
  const selectedEpic = selectSelectedEpic(state);
  const visibleEpics = selectVisibleEpics(state);
  const visibleTasks = selectVisibleTasks(state);
  const tasksInScope = selectTasksInScope(state);
  const searchQuery = state.searchQuery;
  const screen = state.screen;

  if (screen === "tasks" && selectedEpic) {
    return {
      kind: searchQuery.length > 0 ? "epic_search" : "epic",
      label: selectedEpic.title,
      summary: searchQuery.length > 0 ? `Searching ${selectedEpic.title}` : `Epic ${selectedEpic.title}`,
      detail: searchQuery.length > 0
        ? `${visibleTasks.length} matching task${visibleTasks.length === 1 ? "" : "s"} in this epic`
        : `${tasksInScope.length} task${tasksInScope.length === 1 ? "" : "s"} in this epic`,
    };
  }

  return {
    kind: searchQuery.length > 0 ? "overview_search" : "overview",
    label: "All epics",
    summary: searchQuery.length > 0 ? "Searching all epics" : "Epic overview",
    detail: searchQuery.length > 0
      ? `${visibleEpics.length} matching epic${visibleEpics.length === 1 ? "" : "s"}`
      : `${state.snapshot?.epics?.length ?? 0} epic${(state.snapshot?.epics?.length ?? 0) === 1 ? "" : "s"} total`,
  };
}

/**
 * @typedef {object} BoardState
 * @property {"epics"|"tasks"} screen
 * @property {string|null} selectedEpicId
 * @property {object|null} selectedEpic
 * @property {string|null} selectedTaskId
 * @property {object|null} selectedTask
 * @property {string|null} selectedSubtaskId
 * @property {object|null} selectedSubtask
 * @property {string} search
 * @property {string} searchQuery
 * @property {object} searchScope
 * @property {object[]} visibleEpics
 * @property {object[]} visibleTasks
 * @property {object[]} sidebarEpics
 */

/**
 * Compute full derived board state from the internal state, using memoized selectors.
 * @param {object} state
 * @returns {BoardState}
 */
function deriveBoardState(state) {
  const selectedEpic = selectSelectedEpic(state);
  const screen = state.screen === "tasks" && selectedEpic ? "tasks" : "epics";
  const stateWithScreen = state.screen !== screen ? { ...state, screen } : state;

  const visibleTasks = selectVisibleTasks(stateWithScreen);
  const selectedTask = selectSelectedTask(stateWithScreen);
  const selectedTaskId = selectedTask && visibleTasks.some((t) => t.id === selectedTask.id)
    ? selectedTask.id
    : null;

  return {
    screen,
    selectedEpicId: selectedEpic?.id ?? null,
    selectedEpic,
    selectedTaskId,
    selectedTask: selectedTaskId ? selectedTask : null,
    selectedSubtaskId: selectSelectedSubtask(stateWithScreen)?.id ?? null,
    selectedSubtask: selectedTaskId ? selectSelectedSubtask(stateWithScreen) : null,
    search: stateWithScreen.search,
    searchQuery: stateWithScreen.searchQuery,
    searchScope: selectSearchScope(stateWithScreen),
    visibleEpics: selectVisibleEpics(stateWithScreen),
    visibleTasks,
    sidebarEpics: selectSidebarEpics(stateWithScreen),
  };
}

function reconcileBoardState(state) {
  const derived = deriveBoardState(state);
  return {
    screen: derived.screen,
    selectedEpicId: derived.selectedEpicId,
    search: derived.search,
    view: VIEW_MODES.includes(state.view) ? state.view : "kanban",
    selectedTaskId: derived.selectedTaskId,
    selectedSubtaskId: derived.selectedSubtaskId,
  };
}

/**
 * Create an observable store with memoized derived state.
 *
 * @param {object} initialSnapshot - Raw board snapshot from server
 * @param {object} [options]
 * @param {function} [options.normalizeSnapshot] - Custom normalizer (defaults to utils.normalizeSnapshot)
 * @returns {{
 *   getState: () => object,
 *   setState: (patch: object) => void,
 *   subscribe: (listener: (state: object) => void) => () => void,
 *   getSnapshot: () => object,
 *   getBoardState: () => BoardState,
 *   getTaskById: (id: string) => object|null,
 *   getSubtaskById: (id: string) => object|null,
 *   replaceSnapshot: (rawSnapshot: object) => void,
 *   store: object,
 *   persist: () => void,
 *   syncState: (patch?: object) => BoardState,
 * }}
 */
export function createStore(initialSnapshot, options = {}) {
  const normalize = options.normalizeSnapshot ?? normalizeSnapshot;
  const storedState = readStoredState();
  const snapshot = typeof initialSnapshot === "object" && initialSnapshot !== null
    ? normalize(initialSnapshot)
    : normalize({ epics: [], tasks: [], subtasks: [], dependencies: [] });

  const search = normalizeSearch(storedState.search);

  /** @type {object} Internal mutable state */
  const state = {
    snapshot,
    screen: storedState.screen === "tasks" ? "tasks" : "epics",
    selectedEpicId: typeof storedState.selectedEpicId === "string" ? storedState.selectedEpicId : null,
    search,
    searchQuery: search.trim().toLowerCase(),
    view: VIEW_MODES.includes(storedState.view) ? storedState.view : "kanban",
    selectedTaskId: typeof storedState.selectedTaskId === "string" ? storedState.selectedTaskId : null,
    selectedSubtaskId: null,
    theme: readThemePreference(),
    focusedEpicIndex: 0,
    notice: null,
    isMutating: false,
  };

  /** @type {Set<(state: object) => void>} */
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) {
      listener(state);
    }
  }

  function persist() {
    writeStoredState({
      screen: state.screen,
      selectedEpicId: state.selectedEpicId,
      search: state.search,
      view: state.view,
      selectedTaskId: state.selectedTaskId,
    });
  }

  function syncState(patch = {}) {
    const merged = { ...state, ...patch };
    if (merged.search !== state.search || patch.search !== undefined) {
      merged.searchQuery = normalizeSearch(merged.search).trim().toLowerCase();
    }
    const reconciled = reconcileBoardState(merged);
    const changed =
      state.screen !== reconciled.screen
      || state.selectedEpicId !== reconciled.selectedEpicId
      || state.search !== reconciled.search
      || state.view !== reconciled.view
      || state.selectedTaskId !== reconciled.selectedTaskId
      || state.selectedSubtaskId !== reconciled.selectedSubtaskId;

    state.screen = reconciled.screen;
    state.selectedEpicId = reconciled.selectedEpicId;
    state.search = reconciled.search;
    state.searchQuery = normalizeSearch(reconciled.search).trim().toLowerCase();
    state.view = reconciled.view;
    state.selectedTaskId = reconciled.selectedTaskId;
    state.selectedSubtaskId = reconciled.selectedSubtaskId;
    if (changed) {
      notify();
    }
    return deriveBoardState(state);
  }

  // Reconcile initial state
  syncState();

  return {
    /** Direct reference to internal state (legacy compatibility). */
    store: state,

    /**
     * Get a shallow copy of the current state.
     * @returns {object}
     */
    getState() {
      return { ...state };
    },

    /**
     * Merge a patch into state, notifying subscribers only if a value actually changed.
     * @param {object} patch
     */
    setState(patch) {
      let changed = false;
      for (const key of Object.keys(patch)) {
        if (state[key] !== patch[key]) {
          state[key] = patch[key];
          changed = true;
        }
      }
      if (patch.search !== undefined) {
        state.searchQuery = normalizeSearch(state.search).trim().toLowerCase();
      }
      if (changed) {
        notify();
      }
    },

    /**
     * Register a listener that fires on state changes.
     * @param {(state: object) => void} listener
     * @returns {() => void} Unsubscribe function
     */
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /**
     * Get the current normalized snapshot.
     * @returns {object}
     */
    getSnapshot() {
      return state.snapshot;
    },

    /**
     * Get the full derived board state (memoized).
     * @returns {BoardState}
     */
    getBoardState() {
      return deriveBoardState(state);
    },

    /**
     * Find a task by ID in the current snapshot.
     * @param {string} taskId
     * @returns {object|null}
     */
    getTaskById(taskId) {
      return state.snapshot.tasks.find((task) => task.id === taskId) ?? null;
    },

    /**
     * Find a subtask by ID in the current snapshot.
     * @param {string} subtaskId
     * @returns {object|null}
     */
    getSubtaskById(subtaskId) {
      return state.snapshot.subtasks.find((subtask) => subtask.id === subtaskId) ?? null;
    },

    /**
     * Replace the snapshot with a new one (e.g. after server response).
     * @param {object} nextRawSnapshot
     */
    replaceSnapshot(nextRawSnapshot) {
      state.snapshot = normalize(nextRawSnapshot);
      syncState();
      persist();
      notify();
    },

    /** Persist navigational state to localStorage. */
    persist,

    /**
     * Reconcile state with a patch and return derived board state.
     * @param {object} [patch]
     * @returns {BoardState}
     */
    syncState,

    /**
     * Get visible epics from memoized selector.
     * @returns {object[]}
     */
    getVisibleEpics() {
      return selectVisibleEpics(state);
    },

    /**
     * Get visible tasks from memoized selector.
     * @returns {object[]}
     */
    getVisibleTasks() {
      return selectVisibleTasks(state);
    },

    /**
     * Get selected epic from memoized selector.
     * @returns {object|null}
     */
    getSelectedEpic() {
      return selectSelectedEpic(state);
    },

    /**
     * Get selected task from memoized selector.
     * @returns {object|null}
     */
    getSelectedTask() {
      return deriveBoardState(state).selectedTask;
    },
  };
}
