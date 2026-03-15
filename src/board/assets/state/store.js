export const THEME_STORAGE_KEY = "trekoon-board-theme";
export const STATE_STORAGE_KEY = "trekoon-board-state";
export const VIEW_MODES = ["kanban", "list"];
export const STATUS_ORDER = ["todo", "blocked", "in_progress", "done"];

function normalizeSearch(value) {
  return typeof value === "string" ? value : "";
}

function deriveBoardState(snapshot, state) {
  const selectedEpic = snapshot.epics.find((epic) => epic.id === state.selectedEpicId) ?? null;
  const screen = state.screen === "tasks" && selectedEpic ? "tasks" : "epics";
  const selectedEpicId = selectedEpic?.id ?? null;
  const search = normalizeSearch(state.search);
  const searchQuery = search.trim().toLowerCase();
  const visibleEpics = searchQuery.length === 0
    ? snapshot.epics
    : snapshot.epics.filter((epic) => epic.searchText.includes(searchQuery));
  const tasksInScope = screen === "tasks" && selectedEpicId
    ? snapshot.tasks.filter((task) => task.epicId === selectedEpicId)
    : snapshot.tasks;
  const visibleTasks = searchQuery.length === 0
    ? tasksInScope
    : tasksInScope.filter((task) => task.searchText.includes(searchQuery));
  const selectedTask = visibleTasks.find((task) => task.id === state.selectedTaskId)
    ?? tasksInScope.find((task) => task.id === state.selectedTaskId)
    ?? null;
  const selectedTaskId = selectedTask && visibleTasks.some((task) => task.id === selectedTask.id)
    ? selectedTask.id
    : null;
  const selectedSubtask = selectedTaskId
    ? snapshot.subtasks.find(
      (subtask) => subtask.id === state.selectedSubtaskId && subtask.taskId === selectedTaskId,
    ) ?? null
    : null;
  const selectedSubtaskId = selectedSubtask?.id ?? null;
  const searchScope = screen === "tasks" && selectedEpic
    ? {
      kind: searchQuery.length > 0 ? "epic_search" : "epic",
      label: selectedEpic.title,
      summary: searchQuery.length > 0 ? `Searching ${selectedEpic.title}` : `Epic ${selectedEpic.title}`,
      detail: searchQuery.length > 0
        ? `${visibleTasks.length} matching task${visibleTasks.length === 1 ? "" : "s"} in this epic`
        : `${tasksInScope.length} task${tasksInScope.length === 1 ? "" : "s"} in this epic`,
    }
    : {
      kind: searchQuery.length > 0 ? "overview_search" : "overview",
      label: "All epics",
      summary: searchQuery.length > 0 ? "Searching all epics" : "Epic overview",
      detail: searchQuery.length > 0
        ? `${visibleEpics.length} matching epic${visibleEpics.length === 1 ? "" : "s"}`
        : `${snapshot.epics.length} epic${snapshot.epics.length === 1 ? "" : "s"} total`,
    };

  return {
    screen,
    selectedEpicId,
    selectedEpic,
    selectedTaskId,
    selectedTask: selectedTaskId ? selectedTask : null,
    selectedSubtaskId,
    selectedSubtask,
    search,
    searchQuery,
    searchScope,
    visibleEpics,
    visibleTasks,
  };
}

function reconcileBoardState(snapshot, state) {
  const derivedState = deriveBoardState(snapshot, state);
  return {
    screen: derivedState.screen,
    selectedEpicId: derivedState.selectedEpicId,
    search: derivedState.search,
    view: VIEW_MODES.includes(state.view) ? state.view : "kanban",
    selectedTaskId: derivedState.selectedTaskId,
    selectedSubtaskId: derivedState.selectedSubtaskId,
  };
}

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
  const store = {
    snapshot,
    screen: storedState.screen === "tasks" ? "tasks" : "epics",
    selectedEpicId: typeof storedState.selectedEpicId === "string" ? storedState.selectedEpicId : null,
    search: normalizeSearch(storedState.search),
    view: VIEW_MODES.includes(storedState.view) ? storedState.view : "kanban",
    selectedTaskId: typeof storedState.selectedTaskId === "string" ? storedState.selectedTaskId : null,
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
  const getBoardState = () => deriveBoardState(store.snapshot, store);
  const getSelectedEpic = () => getBoardState().selectedEpic;
  const getSelectedTask = () => getBoardState().selectedTask;
  const getVisibleTasks = () => getBoardState().visibleTasks;
  const getVisibleEpics = () => getBoardState().visibleEpics;

  const syncState = (patch = {}) => {
    const nextState = reconcileBoardState(store.snapshot, { ...store, ...patch });
    store.screen = nextState.screen;
    store.selectedEpicId = nextState.selectedEpicId;
    store.search = nextState.search;
    store.view = nextState.view;
    store.selectedTaskId = nextState.selectedTaskId;
    store.selectedSubtaskId = nextState.selectedSubtaskId;
    return getBoardState();
  };

  const replaceSnapshot = (nextSnapshot) => {
    store.snapshot = normalizeSnapshot(nextSnapshot);
    syncState();
    persist();
  };

  syncState();

  return {
    store,
    persist,
    getTaskById,
    getSubtaskById,
    getBoardState,
    getSelectedEpic,
    getSelectedTask,
    getVisibleTasks,
    getVisibleEpics,
    syncState,
    replaceSnapshot,
  };
}
