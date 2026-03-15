const THEME_STORAGE_KEY = "trekoon-board-theme";
const STATE_STORAGE_KEY = "trekoon-board-state";
const SESSION_TOKEN_STORAGE_KEY = "trekoon-board-session-token";
const SEARCH_FOCUS_KEYS = new Set(["/", "s"]);
const VIEW_MODES = ["kanban", "list"];
const STATUS_ORDER = ["todo", "blocked", "in_progress", "done"];
const STATUS_LABELS = {
  todo: "Todo",
  blocked: "Blocked",
  in_progress: "In progress",
  done: "Done",
};

const appElement = document.querySelector("#app");

function readSessionTokenFromStorage() {
  try {
    const storedToken = sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "";
    return storedToken.trim();
  } catch {
    return "";
  }
}

function persistSessionToken(token) {
  try {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeSession() {
  const url = new URL(window.location.href);
  const queryToken = (url.searchParams.get("token") || "").trim();
  if (queryToken.length > 0) {
    return {
      token: queryToken,
      shouldScrubAddressBar: persistSessionToken(queryToken),
    };
  }

  return {
    token: readSessionTokenFromStorage(),
    shouldScrubAddressBar: false,
  };
}

function scrubTokenFromAddressBar() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token") || typeof window.history?.replaceState !== "function") {
    return;
  }

  url.searchParams.delete("token");
  const nextUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState(window.history.state, document.title, nextUrl || "/");
}

function normalizeStatus(rawStatus) {
  if (rawStatus === "in-progress") return "in_progress";
  if (rawStatus === "todo" || rawStatus === "blocked" || rawStatus === "in_progress" || rawStatus === "done") {
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

function deriveCounts(tasks) {
  return STATUS_ORDER.reduce((counts, status) => {
    counts[status] = tasks.filter((task) => task.status === status).length;
    return counts;
  }, {});
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

function cloneSnapshot(snapshot) {
  if (typeof structuredClone === "function") {
    return structuredClone(snapshot);
  }

  return JSON.parse(JSON.stringify(snapshot));
}

function readNodeLabel(kind, title) {
  if (kind === "task") {
    return `Task: ${title}`;
  }

  if (kind === "subtask") {
    return `Subtask: ${title}`;
  }

  return title;
}

function normalizeSnapshot(rawSnapshot) {
  const rawEpics = normalizeArray(rawSnapshot?.epics);
  const rawTasks = normalizeArray(rawSnapshot?.tasks);
  const rawSubtasks = normalizeArray(rawSnapshot?.subtasks);
  const rawDependencies = normalizeArray(rawSnapshot?.dependencies);
  const taskIndex = new Map();
  const subtaskIndex = new Map();

  const tasks = rawTasks.map((task) => {
    const normalizedTask = {
      id: getId(task),
      kind: "task",
      epicId: task.epicId ?? task.epic?.id ?? null,
      title: String(task.title ?? "Untitled task"),
      description: String(task.description ?? ""),
      status: normalizeStatus(task.status),
      createdAt: Number(task.createdAt ?? Date.now()),
      updatedAt: Number(task.updatedAt ?? task.createdAt ?? Date.now()),
      blockedBy: [],
      blocks: [],
      dependencyIds: [],
      dependentIds: [],
      subtasks: [],
      searchText: "",
    };

    taskIndex.set(normalizedTask.id, normalizedTask);
    return normalizedTask;
  });

  const subtasks = rawSubtasks.map((subtask) => {
    const normalizedSubtask = {
      id: getId(subtask),
      kind: "subtask",
      taskId: subtask.taskId ?? subtask.task?.id ?? null,
      title: String(subtask.title ?? "Untitled subtask"),
      description: String(subtask.description ?? ""),
      status: normalizeStatus(subtask.status),
      createdAt: Number(subtask.createdAt ?? Date.now()),
      updatedAt: Number(subtask.updatedAt ?? subtask.createdAt ?? Date.now()),
      blockedBy: [],
      blocks: [],
      dependencyIds: [],
      dependentIds: [],
      searchText: "",
    };

    subtaskIndex.set(normalizedSubtask.id, normalizedSubtask);
    return normalizedSubtask;
  });

  for (const subtask of subtasks) {
    const parentTask = taskIndex.get(subtask.taskId);
    if (parentTask) {
      parentTask.subtasks.push(subtask);
    }
  }

  const dependencies = rawDependencies.map((dependency) => ({
    id: getId(dependency),
    sourceId: String(dependency.sourceId ?? ""),
    sourceKind: dependency.sourceKind === "subtask" ? "subtask" : "task",
    dependsOnId: String(dependency.dependsOnId ?? ""),
    dependsOnKind: dependency.dependsOnKind === "subtask" ? "subtask" : "task",
  }));

  const lookupNode = (kind, id) => {
    if (kind === "subtask") {
      return subtaskIndex.get(id) ?? null;
    }

    return taskIndex.get(id) ?? null;
  };

  for (const dependency of dependencies) {
    const source = lookupNode(dependency.sourceKind, dependency.sourceId);
    const target = lookupNode(dependency.dependsOnKind, dependency.dependsOnId);
    if (source) {
      source.blockedBy.push(dependency.dependsOnId);
      source.dependencyIds.push(dependency.id);
    }
    if (target) {
      target.blocks.push(dependency.sourceId);
      target.dependentIds.push(dependency.id);
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

  for (const subtask of subtasks) {
    subtask.searchText = [subtask.title, subtask.description, subtask.status].join(" ").toLowerCase();
  }

  for (const task of tasks) {
    task.searchText = [
      task.title,
      task.description,
      task.status,
      ...task.subtasks.map((subtask) => `${subtask.title} ${subtask.description} ${subtask.status}`),
    ].join(" ").toLowerCase();
  }

  return {
    generatedAt: rawSnapshot?.generatedAt ?? null,
    epics,
    tasks,
    subtasks,
    dependencies,
  };
}

function createStore(snapshot) {
  const storedState = readStoredState();
  const store = {
    snapshot,
    epicFilter: storedState.epicFilter ?? "ALL",
    search: storedState.search ?? "",
    view: VIEW_MODES.includes(storedState.view) ? storedState.view : "kanban",
    selectedTaskId: storedState.selectedTaskId ?? null,
    activeColumn: storedState.activeColumn ?? "todo",
    theme: readThemePreference(),
    focusedEpicIndex: 0,
    inlineTaskId: storedState.inlineTaskId ?? null,
    notice: null,
    isMutating: false,
  };

  const persist = () => {
    writeStoredState({
      epicFilter: store.epicFilter,
      search: store.search,
      view: store.view,
      selectedTaskId: store.selectedTaskId,
      activeColumn: store.activeColumn,
      inlineTaskId: store.inlineTaskId,
    });
  };

  const getTaskById = (taskId) => store.snapshot.tasks.find((task) => task.id === taskId) ?? null;
  const getSubtaskById = (subtaskId) => store.snapshot.subtasks.find((subtask) => subtask.id === subtaskId) ?? null;
  const getSelectedTask = () => getTaskById(store.selectedTaskId);

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

  const replaceSnapshot = (nextSnapshot) => {
    store.snapshot = normalizeSnapshot(nextSnapshot);
    if (!getTaskById(store.selectedTaskId)) {
      store.selectedTaskId = getVisibleTasks()[0]?.id ?? store.snapshot.tasks[0]?.id ?? null;
    }
    if (store.inlineTaskId && !getTaskById(store.inlineTaskId)) {
      store.inlineTaskId = null;
    }
    persist();
  };

  return {
    store,
    persist,
    getTaskById,
    getSubtaskById,
    getSelectedTask,
    getVisibleTasks,
    getVisibleEpics,
    replaceSnapshot,
  };
}

function createApi(model) {
  const { token: sessionToken } = resolveRuntimeSession();

  async function request(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (sessionToken.length > 0) {
      headers.set("authorization", `Bearer ${sessionToken}`);
    }
    if (options.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(path, { ...options, headers });
    const payload = await response.json();
    if (!payload?.ok) {
      const message = payload?.error?.message || "Board request failed";
      const error = new Error(message);
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      throw error;
    }

    return payload.data;
  }

  async function runMutation({ optimistic, request: mutationRequest, successMessage }) {
    if (model.store.isMutating) {
      return;
    }

    const previousSnapshot = cloneSnapshot(model.store.snapshot);
    model.store.notice = null;
    model.store.isMutating = true;

    if (typeof optimistic === "function") {
      model.store.snapshot = optimistic(cloneSnapshot(model.store.snapshot));
      renderBoard(model);
      attachInteractions(model, api);
    }

    try {
      const data = await mutationRequest();
      if (data?.snapshot) {
        model.replaceSnapshot(data.snapshot);
      }
      model.store.notice = successMessage ? { type: "success", message: successMessage } : null;
    } catch (error) {
      model.replaceSnapshot(previousSnapshot);
      model.store.notice = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      model.store.isMutating = false;
      renderBoard(model);
      attachInteractions(model, api);
    }
  }

  const api = {
    patchTask(taskId, updates, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Task saved.",
        request: () => request(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },
    patchSubtask(subtaskId, updates, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Subtask saved.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },
    addDependency(sourceId, dependsOnId, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Dependency added.",
        request: () => request("/api/dependencies", {
          method: "POST",
          body: JSON.stringify({ sourceId, dependsOnId }),
        }),
      });
    },
    removeDependency(sourceId, dependsOnId, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Dependency removed.",
        request: () => request(`/api/dependencies?sourceId=${encodeURIComponent(sourceId)}&dependsOnId=${encodeURIComponent(dependsOnId)}`, {
          method: "DELETE",
        }),
      });
    },
  };

  return api;
}

function updateTaskInSnapshot(snapshot, taskId, updates) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const task = nextSnapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return snapshot;
  }

  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.status !== undefined) task.status = updates.status;
  task.updatedAt = Date.now();
  return normalizeSnapshot(nextSnapshot);
}

function updateSubtaskInSnapshot(snapshot, subtaskId, updates) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const subtask = nextSnapshot.subtasks.find((candidate) => candidate.id === subtaskId);
  if (!subtask) {
    return snapshot;
  }

  if (updates.title !== undefined) subtask.title = updates.title;
  if (updates.description !== undefined) subtask.description = updates.description;
  if (updates.status !== undefined) subtask.status = updates.status;
  subtask.updatedAt = Date.now();
  return normalizeSnapshot(nextSnapshot);
}

function addDependencyInSnapshot(snapshot, sourceId, dependsOnId) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const duplicate = normalizeArray(nextSnapshot.dependencies).some(
    (dependency) => dependency.sourceId === sourceId && dependency.dependsOnId === dependsOnId,
  );
  if (!duplicate) {
    normalizeArray(nextSnapshot.dependencies).push({
      id: crypto.randomUUID(),
      sourceId,
      sourceKind: nextSnapshot.subtasks.some((subtask) => subtask.id === sourceId) ? "subtask" : "task",
      dependsOnId,
      dependsOnKind: nextSnapshot.subtasks.some((subtask) => subtask.id === dependsOnId) ? "subtask" : "task",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return normalizeSnapshot(nextSnapshot);
}

function removeDependencyInSnapshot(snapshot, sourceId, dependsOnId) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.dependencies = normalizeArray(nextSnapshot.dependencies).filter(
    (dependency) => !(dependency.sourceId === sourceId && dependency.dependsOnId === dependsOnId),
  );
  return normalizeSnapshot(nextSnapshot);
}

function renderStatusSelect(name, selectedStatus) {
  return `
    <select name="${escapeHtml(name)}">
      ${STATUS_ORDER.map((status) => `
        <option value="${escapeHtml(status)}" ${selectedStatus === status ? "selected" : ""}>${escapeHtml(STATUS_LABELS[status] ?? status)}</option>
      `).join("")}
    </select>
  `;
}

function renderNotice(notice) {
  if (!notice) {
    return "";
  }

  return `
    <section class="board-panel" aria-live="polite">
      <span class="board-pill">${notice.type === "error" ? "Action blocked" : "Saved"}</span>
      <p>${escapeHtml(notice.message)}</p>
    </section>
  `;
}

function renderEpicOption(epic, selected, isSynthetic) {
  const counts = epic.counts || { todo: 0, blocked: 0, in_progress: 0, done: 0 };
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
        <span class="board-chip">Todo ${counts.todo ?? 0}</span>
        <span class="board-chip">Blocked ${counts.blocked ?? 0}</span>
        <span class="board-chip">Doing ${counts.in_progress ?? 0}</span>
        <span class="board-chip">Done ${counts.done ?? 0}</span>
      </div>
    </button>
  `;
}

function renderTaskCard(task, selected) {
  return `
    <article
      class="board-task-card ${selected ? "is-selected" : ""}"
      tabindex="0"
      draggable="true"
      data-task-id="${escapeHtml(task.id)}"
      data-draggable-task="true"
    >
      <div class="board-task-tags">
        <span class="board-status-pill">${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
        <span class="board-chip">${task.subtasks.length} subtasks</span>
        <span class="board-chip">${task.blockedBy.length} deps</span>
      </div>
      <strong>${escapeHtml(task.title)}</strong>
      <p class="board-muted">${escapeHtml(task.description || "No task description provided.")}</p>
    </article>
  `;
}

function renderListRow(task, selected, isEditing) {
  return `
    <article class="board-list-row ${selected ? "is-selected" : ""}" data-task-id="${escapeHtml(task.id)}">
      <div>
        <strong>${escapeHtml(task.title)}</strong>
        <p class="board-muted">${escapeHtml(task.description || "No task description provided.")}</p>
      </div>
      <span>${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
      <span>${task.subtasks.length}</span>
      <span>${escapeHtml(formatDate(task.updatedAt))}</span>
      <div class="board-legend">
        <button type="button" class="board-button" data-select-task="${escapeHtml(task.id)}">Open</button>
        <button type="button" class="board-button" data-inline-edit-task="${escapeHtml(task.id)}">${isEditing ? "Hide edit" : "Inline edit"}</button>
      </div>
      ${isEditing ? `
        <form data-task-form="${escapeHtml(task.id)}">
          <label>
            <span>Title</span>
            <input name="title" value="${escapeHtml(task.title)}" required />
          </label>
          <label>
            <span>Description</span>
            <textarea name="description" rows="3">${escapeHtml(task.description)}</textarea>
          </label>
          <label>
            <span>Status</span>
            ${renderStatusSelect("status", task.status)}
          </label>
          <button type="submit" class="board-button">Save task</button>
        </form>
      ` : ""}
    </article>
  `;
}

function renderDependencyOptions(task, snapshot) {
  const existing = new Set(task.blockedBy);
  return [
    ...snapshot.tasks.map((candidate) => ({ id: candidate.id, kind: "task", title: candidate.title })),
    ...snapshot.subtasks.map((candidate) => ({ id: candidate.id, kind: "subtask", title: candidate.title })),
  ]
    .filter((candidate) => candidate.id !== task.id)
    .filter((candidate) => !existing.has(candidate.id))
    .map((candidate) => `
      <option value="${escapeHtml(candidate.id)}">${escapeHtml(readNodeLabel(candidate.kind, candidate.title))}</option>
    `)
    .join("");
}

function lookupNode(snapshot, id) {
  return snapshot.tasks.find((task) => task.id === id)
    ?? snapshot.subtasks.find((subtask) => subtask.id === id)
    ?? null;
}

function renderDependencyList(task, snapshot) {
  if (task.blockedBy.length === 0) {
    return renderEmptyState("No dependencies", "Add blockers here to keep task transitions honest.");
  }

  return task.blockedBy.map((dependencyId) => {
    const dependency = lookupNode(snapshot, dependencyId);
    return `
      <article class="board-task-card">
        <div class="board-task-tags">
          <span class="board-status-pill">${escapeHtml(STATUS_LABELS[dependency?.status] ?? dependency?.status ?? "Unknown")}</span>
        </div>
        <strong>${escapeHtml(readNodeLabel(dependency?.kind ?? "task", dependency?.title ?? dependencyId))}</strong>
        <p class="board-muted">${escapeHtml(dependency?.description || "No description provided.")}</p>
        <button type="button" class="board-button" data-remove-dependency-source="${escapeHtml(task.id)}" data-remove-dependency-target="${escapeHtml(dependencyId)}">Remove dependency</button>
      </article>
    `;
  }).join("");
}

function renderDrawer(task, epics, snapshot) {
  const epic = epics.find((candidate) => candidate.id === task.epicId) ?? null;
  const dependencyOptions = renderDependencyOptions(task, snapshot);
  const isMutating = snapshot === undefined ? false : false;
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
        <strong>Edit task</strong>
        <form data-task-form="${escapeHtml(task.id)}">
          <label>
            <span>Title</span>
            <input name="title" value="${escapeHtml(task.title)}" required />
          </label>
          <label>
            <span>Description</span>
            <textarea name="description" rows="4">${escapeHtml(task.description)}</textarea>
          </label>
          <label>
            <span>Status</span>
            ${renderStatusSelect("status", task.status)}
          </label>
          <button type="submit" class="board-button">Save task</button>
        </form>
      </section>
      <section>
        <strong>Dependencies</strong>
        <form data-dependency-form="${escapeHtml(task.id)}">
          <label>
            <span>Add dependency</span>
            <select name="dependsOnId" required>
              <option value="">Select a task or subtask</option>
              ${dependencyOptions}
            </select>
          </label>
          <button type="submit" class="board-button">Add dependency</button>
        </form>
        ${renderDependencyList(task, snapshot)}
      </section>
      <section>
        <strong>Subtasks</strong>
        ${task.subtasks.length > 0 ? task.subtasks.map((subtask) => `
          <form class="board-task-card" data-subtask-form="${escapeHtml(subtask.id)}">
            <div class="board-task-tags">
              <span class="board-status-pill">${escapeHtml(STATUS_LABELS[subtask.status] ?? subtask.status)}</span>
            </div>
            <label>
              <span>Title</span>
            <input name="title" value="${escapeHtml(subtask.title)}" required />
            </label>
            <label>
              <span>Description</span>
            <textarea name="description" rows="3">${escapeHtml(subtask.description)}</textarea>
            </label>
            <label>
              <span>Status</span>
              ${renderStatusSelect("status", subtask.status)}
            </label>
            <button type="submit" class="board-button">Save subtask</button>
          </form>
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

function renderBoard(model) {
  const { store, getSelectedTask, getVisibleEpics, getVisibleTasks } = model;
  const mutationDisabled = store.isMutating ? "disabled" : "";
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
        <div class="board-column__tasks" id="column-${status}" data-drop-status="${escapeHtml(status)}">${content}</div>
      </section>
    `;
  }).join("");

  const listRows = visibleTasks.length === 0
    ? renderEmptyState("No matching tasks", "Nothing in this slice matches the active search and epic filters.", "/")
    : visibleTasks.map((task) => renderListRow(task, selectedTask?.id === task.id, store.inlineTaskId === task.id)).join("");

  appElement.innerHTML = `
    ${renderNotice(store.notice)}
    <div class="board-root">
      <aside class="board-panel board-rail" aria-label="Epic rail">
        <section class="board-brand">
          <span class="board-pill">Persistent epic rail</span>
          <h1>Board</h1>
          <p>Browse work fast with saved context, keyboard shortcuts, inline edits, and in-place task management.</p>
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
            ${store.isMutating ? `<span class="board-chip">Saving…</span>` : ""}
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
         <span class="board-chip">Drag cards across columns</span>
            <span class="board-chip">Inline edit in list view</span>
            <span class="board-chip">Drawer edits stay live</span>
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
                    <span>Actions</span>
                  </div>
                  <div class="board-list__rows">${listRows}</div>
                </div>`}
        </div>
      </section>

      <aside class="board-panel board-drawer" aria-label="Task drawer">
         ${selectedTask ? renderDrawer(selectedTask, store.snapshot.epics, store.snapshot, mutationDisabled) : renderDrawerEmpty()}
      </aside>
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

function attachInteractions(model, api) {
  const { store, persist, getVisibleTasks, getTaskById } = model;

  document.querySelector("[data-action='toggle-theme']")?.addEventListener("click", () => {
    store.theme = store.theme === "dark" ? "light" : "dark";
    applyTheme(store.theme);
    renderBoard(model);
    attachInteractions(model, api);
  });

  document.querySelector("#board-search-input")?.addEventListener("input", (event) => {
    store.search = event.target.value;
    persist();
    renderBoard(model);
    attachInteractions(model, api);
    document.querySelector("#board-search-input")?.focus();
  });

  document.querySelectorAll("[data-epic-id]").forEach((button) => {
    button.addEventListener("click", () => {
      store.epicFilter = button.dataset.epicId || "ALL";
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      store.view = button.dataset.view;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-task-id]").forEach((node) => {
    node.addEventListener("click", () => {
      const taskId = node.dataset.taskId;
      if (!taskId) {
        return;
      }
      store.selectedTaskId = taskId;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-select-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      store.selectedTaskId = button.dataset.selectTask;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-inline-edit-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      store.inlineTaskId = store.inlineTaskId === button.dataset.inlineEditTask ? null : button.dataset.inlineEditTask;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-task-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }
      const taskId = form.dataset.taskForm;
      const formData = new FormData(form);
      const updates = {
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        status: normalizeStatus(String(formData.get("status") || "todo")),
      };
      api.patchTask(taskId, updates, (snapshot) => updateTaskInSnapshot(snapshot, taskId, updates));
    });
  });

  document.querySelectorAll("[data-subtask-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }
      const subtaskId = form.dataset.subtaskForm;
      const formData = new FormData(form);
      const updates = {
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        status: normalizeStatus(String(formData.get("status") || "todo")),
      };
      api.patchSubtask(subtaskId, updates, (snapshot) => updateSubtaskInSnapshot(snapshot, subtaskId, updates));
    });
  });

  document.querySelectorAll("[data-dependency-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }
      const sourceId = form.dataset.dependencyForm;
      const formData = new FormData(form);
      const dependsOnId = String(formData.get("dependsOnId") || "").trim();
      if (!dependsOnId) {
        store.notice = { type: "error", message: "Choose a dependency target first." };
        renderBoard(model);
        attachInteractions(model, api);
        return;
      }

      api.addDependency(sourceId, dependsOnId, (snapshot) => addDependencyInSnapshot(snapshot, sourceId, dependsOnId));
    });
  });

  document.querySelectorAll("[data-remove-dependency-source]").forEach((button) => {
    button.addEventListener("click", () => {
      if (store.isMutating) {
        return;
      }
      const sourceId = button.dataset.removeDependencySource;
      const dependsOnId = button.dataset.removeDependencyTarget;
      api.removeDependency(sourceId, dependsOnId, (snapshot) => removeDependencyInSnapshot(snapshot, sourceId, dependsOnId));
    });
  });

  document.querySelectorAll("[data-draggable-task]").forEach((card) => {
    card.addEventListener("dragstart", (event) => {
      if (store.isMutating) {
        event.preventDefault();
        return;
      }
      const taskId = card.dataset.taskId;
      if (!taskId) {
        return;
      }
      event.dataTransfer?.setData("text/task-id", taskId);
      event.dataTransfer?.setData("text/plain", taskId);
    });
  });

  document.querySelectorAll("[data-drop-status]").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
    });
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }
      const taskId = event.dataTransfer?.getData("text/task-id") || event.dataTransfer?.getData("text/plain");
      const nextStatus = column.dataset.dropStatus;
      const task = getTaskById(taskId);
      if (!task || !nextStatus || task.status === nextStatus) {
        return;
      }
      store.selectedTaskId = taskId;
      persist();
      api.patchTask(taskId, { status: nextStatus }, (snapshot) => updateTaskInSnapshot(snapshot, taskId, { status: nextStatus }));
    });
  });

  window.onkeydown = (event) => {
    const activeElement = document.activeElement;
    const tagName = activeElement?.tagName?.toLowerCase();
    const isTypingTarget = tagName === "input" || tagName === "textarea" || tagName === "select";
    const visibleTasks = getVisibleTasks();
    const currentIndex = visibleTasks.findIndex((task) => task.id === store.selectedTaskId);

    if (SEARCH_FOCUS_KEYS.has(event.key.toLowerCase()) && activeElement?.id !== "board-search-input" && !isTypingTarget) {
      event.preventDefault();
      document.querySelector("#board-search-input")?.focus();
      return;
    }

    if (event.key === "Escape") {
      if (activeElement?.id === "board-search-input") {
        activeElement.blur();
      } else {
        store.selectedTaskId = null;
        store.inlineTaskId = null;
        persist();
        renderBoard(model);
        attachInteractions(model, api);
      }
      return;
    }

    if (isTypingTarget || visibleTasks.length === 0) return;

    if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") {
      event.preventDefault();
      const nextTask = visibleTasks[Math.min(currentIndex + 1, visibleTasks.length - 1)] ?? visibleTasks[0];
      store.selectedTaskId = nextTask.id;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
      return;
    }

    if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") {
      event.preventDefault();
      const previousTask = visibleTasks[Math.max(currentIndex - 1, 0)] ?? visibleTasks[0];
      store.selectedTaskId = previousTask.id;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
      return;
    }

    if (event.key === "Enter" && currentIndex >= 0) {
      event.preventDefault();
      document.querySelector(".board-drawer")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };
}

async function boot() {
  try {
    applyTheme(readThemePreference());
    const runtimeSession = resolveRuntimeSession();
    if (runtimeSession.shouldScrubAddressBar) {
      scrubTokenFromAddressBar();
    }

    const headers = new Headers();
    if (runtimeSession.token.length > 0) {
      headers.set("authorization", `Bearer ${runtimeSession.token}`);
    }

    let snapshotPayload = readJsonScript("trekoon-board-snapshot") ?? {};
    if (runtimeSession.token.length > 0) {
      const response = await fetch("/api/snapshot", {
        headers,
      });
      const payload = await response.json();
      if (!payload?.ok) {
        const message = payload?.error?.message || "Board request failed";
        throw new Error(message);
      }
      snapshotPayload = payload?.data?.snapshot ?? {};
    }

    const snapshot = normalizeSnapshot(snapshotPayload);

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
    const api = createApi(model);
    applyTheme(model.store.theme);
    renderBoard(model);
    attachInteractions(model, api);
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

boot();
