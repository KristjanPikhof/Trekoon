const THEME_STORAGE_KEY = "trekoon-board-theme";
const STATE_STORAGE_KEY = "trekoon-board-state";
const SEARCH_FOCUS_KEYS = new Set(["/", "s"]);
const VIEW_MODES = ["kanban", "list"];
const STATUS_ORDER = ["in_progress", "todo", "done"];
const STATUS_LABELS = {
  in_progress: "In progress",
  todo: "Todo",
  done: "Done",
};

const appElement = document.querySelector("#app");

function normalizeStatus(rawStatus) {
  if (rawStatus === "in-progress") return "in_progress";
  if (rawStatus === "in_progress" || rawStatus === "todo" || rawStatus === "done") {
    return rawStatus;
  }

  return "todo";
}

function readJsonScript(scriptId) {
  const script = document.getElementById(scriptId);
  if (!script) {
    return null;
  }

  try {
    return JSON.parse(script.textContent || "null");
  } catch (error) {
    throw new Error(`Failed to parse ${scriptId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function getId(record) {
  return typeof record?.id === "string" && record.id.length > 0 ? record.id : crypto.randomUUID();
}

function slugifyLabel(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveCounts(tasks) {
  return STATUS_ORDER.reduce((counts, status) => {
    counts[status] = tasks.filter((task) => task.status === status).length;
    return counts;
  }, {});
}

function normalizeSnapshot(rawSnapshot) {
  const rawEpics = normalizeArray(rawSnapshot?.epics);
  const rawTasks = normalizeArray(rawSnapshot?.tasks);
  const rawSubtasks = normalizeArray(rawSnapshot?.subtasks);
  const taskIndex = new Map();

  const tasks = rawTasks.map((task) => {
    const normalizedTask = {
      id: getId(task),
      epicId: task.epicId ?? task.epic?.id ?? null,
      title: String(task.title ?? "Untitled task"),
      description: String(task.description ?? ""),
      status: normalizeStatus(task.status),
      createdAt: Number(task.createdAt ?? Date.now()),
      updatedAt: Number(task.updatedAt ?? task.createdAt ?? Date.now()),
      blockedBy: normalizeArray(task.blockedBy ?? task.dependencies ?? task.dependsOn).map(String),
      blocks: normalizeArray(task.blocks).map(String),
      subtasks: [],
      searchText: "",
    };

    taskIndex.set(normalizedTask.id, normalizedTask);
    return normalizedTask;
  });

  const subtasks = rawSubtasks.map((subtask) => ({
    id: getId(subtask),
    taskId: subtask.taskId ?? subtask.task?.id ?? null,
    title: String(subtask.title ?? "Untitled subtask"),
    description: String(subtask.description ?? ""),
    status: normalizeStatus(subtask.status),
  }));

  for (const subtask of subtasks) {
    const parentTask = taskIndex.get(subtask.taskId);
    if (parentTask) {
      parentTask.subtasks.push(subtask);
    }
  }

  const epics = rawEpics.map((epic) => {
    const epicId = getId(epic);
    const epicTasks = tasks.filter((task) => task.epicId === epicId);
    const normalizedEpic = {
      id: epicId,
      title: String(epic.title ?? "Untitled epic"),
      description: String(epic.description ?? ""),
      status: String(epic.status ?? "todo"),
      createdAt: Number(epic.createdAt ?? Date.now()),
      updatedAt: Number(epic.updatedAt ?? epic.createdAt ?? Date.now()),
      taskIds: epicTasks.map((task) => task.id),
      counts: deriveCounts(epicTasks),
      searchText: "",
    };

    normalizedEpic.searchText = [normalizedEpic.title, normalizedEpic.description, ...epicTasks.map((task) => task.title)].join(" ").toLowerCase();
    return normalizedEpic;
  });

  for (const task of tasks) {
    task.searchText = [
      task.title,
      task.description,
      task.status,
      ...task.subtasks.map((subtask) => `${subtask.title} ${subtask.description} ${subtask.status}`),
    ]
      .join(" ")
      .toLowerCase();
  }

  return {
    generatedAt: rawSnapshot?.generatedAt ?? null,
    epics,
    tasks,
    subtasks,
  };
}

function readStoredState() {
  try {
    return JSON.parse(localStorage.getItem(STATE_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function writeStoredState(nextState) {
  localStorage.setItem(STATE_STORAGE_KEY, JSON.stringify(nextState));
}

function readThemePreference() {
  const storedTheme = localStorage.getItem(THEME_STORAGE_KEY);
  return storedTheme === "light" || storedTheme === "dark" ? storedTheme : "dark";
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

function formatDate(timestamp) {
  if (!timestamp) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderEmptyState(title, description, shortcut) {
  return `
    <div class="board-empty">
      <strong>${escapeHtml(title)}</strong>
      <p>${escapeHtml(description)}</p>
      ${shortcut ? `<p class="board-hint">Try <span class="board-kbd">${escapeHtml(shortcut)}</span></p>` : ""}
    </div>
  `;
}

function createStore(snapshot) {
  const storedState = readStoredState();
  const store = {
    snapshot,
    epicFilter: storedState.epicFilter ?? "ALL",
    search: storedState.search ?? "",
    view: VIEW_MODES.includes(storedState.view) ? storedState.view : "kanban",
    selectedTaskId: storedState.selectedTaskId ?? null,
    activeColumn: storedState.activeColumn ?? "in_progress",
    theme: readThemePreference(),
    focusedEpicIndex: 0,
  };

  const persist = () => {
    writeStoredState({
      epicFilter: store.epicFilter,
      search: store.search,
      view: store.view,
      selectedTaskId: store.selectedTaskId,
      activeColumn: store.activeColumn,
    });
  };

  const getSelectedTask = () => store.snapshot.tasks.find((task) => task.id === store.selectedTaskId) ?? null;

  const getVisibleTasks = () => {
    const query = store.search.trim().toLowerCase();
    return store.snapshot.tasks
      .filter((task) => store.epicFilter === "ALL" || task.epicId === store.epicFilter)
      .filter((task) => query.length === 0 || task.searchText.includes(query));
  };

  const getVisibleEpics = () => {
    const query = store.search.trim().toLowerCase();
    if (query.length === 0) return store.snapshot.epics;

    return store.snapshot.epics.filter((epic) => epic.searchText.includes(query));
  };

  return {
    store,
    persist,
    getSelectedTask,
    getVisibleTasks,
    getVisibleEpics,
  };
}

function renderBoard(model) {
  const { store, getSelectedTask, getVisibleEpics, getVisibleTasks } = model;
  const visibleEpics = getVisibleEpics();
  const visibleTasks = getVisibleTasks();
  const selectedTask = getSelectedTask() ?? visibleTasks[0] ?? null;

  if (!store.selectedTaskId && selectedTask) {
    store.selectedTaskId = selectedTask.id;
    model.persist();
  }

  const selectedEpic = store.epicFilter === "ALL"
    ? null
    : store.snapshot.epics.find((epic) => epic.id === store.epicFilter) ?? null;

  const columnsMarkup = STATUS_ORDER.map((status) => {
    const columnTasks = visibleTasks.filter((task) => task.status === status);
    const columnTitle = STATUS_LABELS[status] ?? status;
    const content = columnTasks.length === 0
      ? renderEmptyState(`No ${columnTitle.toLowerCase()} work`, "Adjust search or switch epics to inspect more tasks.")
      : columnTasks
          .map((task) => renderTaskCard(task, selectedTask?.id === task.id))
          .join("");

    return `
      <section class="board-column" aria-labelledby="column-${status}">
        <header>
          <div class="board-status-pill">${escapeHtml(columnTitle)} · ${columnTasks.length}</div>
        </header>
        <div class="board-column__tasks" id="column-${status}">${content}</div>
      </section>
    `;
  }).join("");

  const listRows = visibleTasks.length === 0
    ? renderEmptyState("No matching tasks", "Nothing in this slice matches the active search and epic filters.", "/")
    : visibleTasks.map((task) => renderListRow(task, selectedTask?.id === task.id)).join("");

  appElement.innerHTML = `
    <div class="board-root">
      <aside class="board-panel board-rail" aria-label="Epic rail">
        <section class="board-brand">
          <span class="board-pill">Persistent epic rail</span>
          <h1>Board</h1>
          <p>Browse work fast with saved context, keyboard shortcuts, and a focused split-view workspace.</p>
        </section>

        <section class="board-toolbar">
          <label class="board-search" aria-label="Search tasks and epics">
            <span class="board-kbd">/</span>
            <input id="board-search-input" type="search" placeholder="Search epics, tasks, subtasks" value="${escapeHtml(store.search)}" />
          </label>
          <button type="button" class="board-button" data-action="toggle-theme">${store.theme === "dark" ? "Light" : "Dark"}</button>
        </section>

        <section class="board-legend">
          <span class="board-chip">All epics by default</span>
          <span class="board-chip">${visibleTasks.length} visible tasks</span>
        </section>

        <section class="board-epics" role="listbox" aria-label="Epics" tabindex="0">
          ${renderEpicOption({ id: "ALL", title: "All epics", description: "Everything in the current board snapshot.", counts: deriveCounts(visibleTasks) }, store.epicFilter === "ALL", true)}
          ${visibleEpics.map((epic) => renderEpicOption(epic, store.epicFilter === epic.id, false)).join("")}
        </section>
      </aside>

      <section class="board-panel board-workspace" aria-label="Workspace">
        <header class="board-headline">
          <span class="board-pill">${selectedEpic ? "Filtered epic" : "All work"}</span>
          <h2>${escapeHtml(selectedEpic?.title ?? "All epics")}</h2>
          <p>${escapeHtml(selectedEpic?.description || "Cross-epic view with context-preserving navigation between rail, workspace, and drawer.")}</p>
        </header>

        <div class="board-workspace__toolbar">
          <div class="board-tabs" role="tablist" aria-label="Board views">
            ${VIEW_MODES.map((view) => `<button class="board-tab" type="button" role="tab" aria-selected="${store.view === view}" data-view="${view}">${view === "kanban" ? "Kanban" : "List"}</button>`).join("")}
          </div>
          <div class="board-legend">
            <span class="board-chip">Enter opens drawer</span>
            <span class="board-chip">J/K move selection</span>
            <span class="board-chip">Esc clears drawer</span>
          </div>
        </div>

        <div class="board-content">
          ${store.view === "kanban"
            ? `<div class="board-kanban">${columnsMarkup}</div>`
            : `
                <div class="board-list">
                  <div class="board-list__header">
                    <span>Task</span>
                    <span>Status</span>
                    <span>Subtasks</span>
                    <span>Updated</span>
                  </div>
                  <div class="board-list__rows">${listRows}</div>
                </div>`}
        </div>
      </section>

      <aside class="board-panel board-drawer" aria-label="Task drawer">
        ${selectedTask ? renderDrawer(selectedTask, store.snapshot.epics) : renderDrawerEmpty()}
      </aside>
    </div>
  `;
}

function renderEpicOption(epic, selected, isSynthetic) {
  const counts = epic.counts || { in_progress: 0, todo: 0, done: 0 };
  return `
    <button
      type="button"
      class="board-epic"
      role="option"
      aria-current="${selected}"
      data-epic-id="${escapeHtml(epic.id)}"
      data-synthetic="${isSynthetic}"
    >
      <div>
        <strong>${escapeHtml(epic.title)}</strong>
        <p class="board-muted">${escapeHtml(epic.description || "No epic description yet.")}</p>
      </div>
      <div class="board-legend">
        <span class="board-chip">Doing ${counts.in_progress ?? 0}</span>
        <span class="board-chip">Todo ${counts.todo ?? 0}</span>
        <span class="board-chip">Done ${counts.done ?? 0}</span>
      </div>
    </button>
  `;
}

function renderTaskCard(task, selected) {
  return `
    <article class="board-task-card ${selected ? "is-selected" : ""}" tabindex="0" data-task-id="${escapeHtml(task.id)}">
      <div class="board-task-tags">
        <span class="board-status-pill">${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
        <span class="board-chip">${task.subtasks.length} subtasks</span>
      </div>
      <strong>${escapeHtml(task.title)}</strong>
      <p class="board-muted">${escapeHtml(task.description || "No task description provided.")}</p>
    </article>
  `;
}

function renderListRow(task, selected) {
  return `
    <button type="button" class="board-list-row ${selected ? "is-selected" : ""}" data-task-id="${escapeHtml(task.id)}">
      <span>
        <strong>${escapeHtml(task.title)}</strong>
        <p class="board-muted">${escapeHtml(task.description || "No task description provided.")}</p>
      </span>
      <span>${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
      <span>${task.subtasks.length}</span>
      <span>${escapeHtml(formatDate(task.updatedAt))}</span>
    </button>
  `;
}

function renderDrawer(task, epics) {
  const epic = epics.find((candidate) => candidate.id === task.epicId) ?? null;
  return `
    <header class="board-drawer__header">
      <span class="board-pill">Task drawer</span>
      <h3>${escapeHtml(task.title)}</h3>
      <p class="board-muted">${escapeHtml(task.description || "No task description provided.")}</p>
      <div class="board-drawer__actions">
        <span class="board-chip">Epic ${escapeHtml(epic?.title ?? "Unknown")}</span>
        <span class="board-chip">${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
      </div>
    </header>
    <div class="board-drawer__body">
      <section>
        <div class="board-meta-grid">
          <span class="board-chip">Updated ${escapeHtml(formatDate(task.updatedAt))}</span>
          <span class="board-chip">Depends on ${task.blockedBy.length}</span>
          <span class="board-chip">Blocks ${task.blocks.length}</span>
        </div>
      </section>
      <section>
        <strong>Subtasks</strong>
        ${task.subtasks.length > 0 ? task.subtasks.map((subtask) => `
          <article class="board-task-card">
            <div class="board-task-tags">
              <span class="board-status-pill">${escapeHtml(STATUS_LABELS[subtask.status] ?? subtask.status)}</span>
            </div>
            <strong>${escapeHtml(subtask.title)}</strong>
            <p class="board-muted">${escapeHtml(subtask.description || "No subtask description provided.")}</p>
          </article>
        `).join("") : renderEmptyState("No subtasks", "This task does not have subtasks in the current snapshot.")}
      </section>
    </div>
  `;
}

function renderDrawerEmpty() {
  return `
    <header class="board-drawer__header">
      <span class="board-pill">Task drawer</span>
      <h3>No task selected</h3>
      <p class="board-muted">Select a card or list row to inspect dependencies, subtasks, and context.</p>
    </header>
    <div class="board-drawer__body">
      ${renderEmptyState("Nothing selected", "Use arrow keys, J/K, or Enter to move through visible tasks.", "Enter")}
    </div>
  `;
}

function renderError(message) {
  appElement.innerHTML = `
    <section class="board-state">
      <span class="board-pill">Board error</span>
      <h1>Could not load the board snapshot</h1>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
}

function attachInteractions(model) {
  const { store, persist, getVisibleTasks } = model;

  document.querySelector("[data-action='toggle-theme']")?.addEventListener("click", () => {
    store.theme = store.theme === "dark" ? "light" : "dark";
    applyTheme(store.theme);
    renderBoard(model);
    attachInteractions(model);
  });

  document.querySelector("#board-search-input")?.addEventListener("input", (event) => {
    store.search = event.target.value;
    persist();
    renderBoard(model);
    attachInteractions(model);
    document.querySelector("#board-search-input")?.focus();
  });

  document.querySelectorAll("[data-epic-id]").forEach((button) => {
    button.addEventListener("click", () => {
      store.epicFilter = button.dataset.epicId || "ALL";
      persist();
      renderBoard(model);
      attachInteractions(model);
    });
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      store.view = button.dataset.view;
      persist();
      renderBoard(model);
      attachInteractions(model);
    });
  });

  document.querySelectorAll("[data-task-id]").forEach((button) => {
    button.addEventListener("click", () => {
      store.selectedTaskId = button.dataset.taskId;
      persist();
      renderBoard(model);
      attachInteractions(model);
    });
  });

  window.onkeydown = (event) => {
    const activeElement = document.activeElement;
    const visibleTasks = getVisibleTasks();
    const currentIndex = visibleTasks.findIndex((task) => task.id === store.selectedTaskId);

    if (SEARCH_FOCUS_KEYS.has(event.key.toLowerCase()) && activeElement?.id !== "board-search-input") {
      event.preventDefault();
      document.querySelector("#board-search-input")?.focus();
      return;
    }

    if (event.key === "Escape") {
      if (activeElement?.id === "board-search-input") {
        activeElement.blur();
      } else {
        store.selectedTaskId = null;
        persist();
        renderBoard(model);
        attachInteractions(model);
      }
      return;
    }

    if (visibleTasks.length === 0) return;

    if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      const nextTask = visibleTasks[Math.min(currentIndex + 1, visibleTasks.length - 1)] ?? visibleTasks[0];
      store.selectedTaskId = nextTask.id;
      persist();
      renderBoard(model);
      attachInteractions(model);
      return;
    }

    if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      const previousTask = visibleTasks[Math.max(currentIndex - 1, 0)] ?? visibleTasks[0];
      store.selectedTaskId = previousTask.id;
      persist();
      renderBoard(model);
      attachInteractions(model);
      return;
    }

    if (event.key === "Enter" && currentIndex >= 0) {
      event.preventDefault();
      document.querySelector(".board-drawer")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
}

function boot() {
  try {
    applyTheme(readThemePreference());
    const snapshot = normalizeSnapshot(readJsonScript("trekoon-board-snapshot") ?? {});

    if (snapshot.epics.length === 0 && snapshot.tasks.length === 0) {
      appElement.innerHTML = `
        <section class="board-state">
          <span class="board-pill">Board ready</span>
          <h1>No work has been published yet</h1>
          <p>Once the board snapshot is installed into <code>.trekoon/board</code>, epics and tasks will appear here.</p>
        </section>
      `;
      return;
    }

    const model = createStore(snapshot);
    applyTheme(model.store.theme);
    renderBoard(model);
    attachInteractions(model);
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

boot();
