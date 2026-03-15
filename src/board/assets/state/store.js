export const THEME_STORAGE_KEY = "trekoon-board-theme";
export const STATE_STORAGE_KEY = "trekoon-board-state";
export const VIEW_MODES = ["kanban", "list"];
export const STATUS_ORDER = ["todo", "blocked", "in_progress", "done"];

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

export function createStore(snapshot, options) {
  const { normalizeSnapshot } = options;
  const storedState = readStoredState();
  const selectedEpicId = typeof storedState.selectedEpicId === "string" ? storedState.selectedEpicId : null;
  const selectedTaskId = typeof storedState.selectedTaskId === "string" ? storedState.selectedTaskId : null;
  const store = {
    snapshot,
    screen: storedState.screen === "tasks" && selectedEpicId ? "tasks" : "epics",
    selectedEpicId,
    search: storedState.search ?? "",
    view: VIEW_MODES.includes(storedState.view) ? storedState.view : "kanban",
    selectedTaskId,
    selectedSubtaskId: null,
    theme: readThemePreference(),
    focusedEpicIndex: 0,
    notice: null,
    isMutating: false,
  };

  const persist = () => {
    writeStoredState({
      screen: store.screen,
      selectedEpicId: store.selectedEpicId,
      search: store.search,
      view: store.view,
      selectedTaskId: store.selectedTaskId,
    });
  };

  const getTaskById = (taskId) => store.snapshot.tasks.find((task) => task.id === taskId) ?? null;
  const getSubtaskById = (subtaskId) => store.snapshot.subtasks.find((subtask) => subtask.id === subtaskId) ?? null;
  const getSelectedEpic = () => store.snapshot.epics.find((epic) => epic.id === store.selectedEpicId) ?? null;
  const getSelectedTask = () => getTaskById(store.selectedTaskId);

  const getVisibleTasks = () => {
    const query = store.search.trim().toLowerCase();
    return store.snapshot.tasks
      .filter((task) => store.screen !== "tasks" || !store.selectedEpicId || task.epicId === store.selectedEpicId)
      .filter((task) => query.length === 0 || task.searchText.includes(query));
  };

  const getVisibleEpics = () => {
    const query = store.search.trim().toLowerCase();
    if (query.length === 0) return store.snapshot.epics;

    return store.snapshot.epics.filter((epic) => epic.searchText.includes(query));
  };

  const replaceSnapshot = (nextSnapshot) => {
    store.snapshot = normalizeSnapshot(nextSnapshot);
    if (store.selectedEpicId && !getSelectedEpic()) {
      store.selectedEpicId = null;
      store.screen = "epics";
    }
    if (!getTaskById(store.selectedTaskId)) {
      store.selectedTaskId = null;
    }
    if (store.selectedTaskId) {
      const selectedTask = getTaskById(store.selectedTaskId);
      if (store.selectedEpicId && selectedTask?.epicId !== store.selectedEpicId) {
        store.selectedTaskId = null;
      }
    }
    if (!getSubtaskById(store.selectedSubtaskId)) {
      store.selectedSubtaskId = null;
    }
    persist();
  };

  return {
    store,
    persist,
    getTaskById,
    getSubtaskById,
    getSelectedEpic,
    getSelectedTask,
    getVisibleTasks,
    getVisibleEpics,
    replaceSnapshot,
  };
}
