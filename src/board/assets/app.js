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

function renderStatusSelect(name, selectedStatus, disabled = false) {
  return `
    <select name="${escapeHtml(name)}" ${disabled ? "disabled" : ""}>
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

function renderDescriptionPreview(description, className = "board-summary") {
  if (!description || description.trim().length === 0) {
    return "";
  }

  return `<p class="${escapeHtml(className)}">${escapeHtml(description)}</p>`;
}

function renderEpicCountSummary(epic) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  const counts = epic.counts || { todo: 0, blocked: 0, in_progress: 0, done: 0 };

  return `
    <span class="board-chip">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
    <span class="board-chip">${counts.in_progress ?? 0} doing</span>
    <span class="board-chip">${counts.done ?? 0} done</span>
  `;
}

function renderEpicSidebarItem(epic, selected) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  return `
    <button
      type="button"
      class="board-sidebar-item ${selected ? "is-selected" : ""}"
      aria-current="${selected}"
      data-open-epic="${escapeHtml(epic.id)}"
    >
      <strong>${escapeHtml(epic.title)}</strong>
      <span>${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
    </button>
  `;
}

function renderEpicRow(epic, selected) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  return `
    <button
      type="button"
      class="board-epic-row ${selected ? "is-selected" : ""}"
      data-open-epic="${escapeHtml(epic.id)}"
      aria-current="${selected}"
    >
      <div class="board-epic-row__summary">
        <strong>${escapeHtml(epic.title)}</strong>
        ${renderDescriptionPreview(epic.description)}
      </div>
      <span class="board-status-pill">${escapeHtml(STATUS_LABELS[normalizeStatus(epic.status)] ?? epic.status ?? "Epic")}</span>
      <span class="board-epic-row__meta">${totalTasks}</span>
      <span class="board-epic-row__meta">${escapeHtml(formatDate(epic.updatedAt))}</span>
      <span class="board-epic-row__action">Open</span>
    </button>
  `;
}

function renderTaskMeta(task, includeStatus = false) {
  return `
    ${includeStatus ? `<span class="board-chip">${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>` : ""}
    <span class="board-chip">${task.subtasks.length} subtask${task.subtasks.length === 1 ? "" : "s"}</span>
    ${task.blockedBy.length > 0 ? `<span class="board-chip">${task.blockedBy.length} blocker${task.blockedBy.length === 1 ? "" : "s"}</span>` : ""}
  `;
}

function renderTaskCard(task, selected, isMutating = false) {
  return `
    <article
      class="board-task-card ${selected ? "is-selected" : ""}"
      tabindex="0"
      draggable="${isMutating ? "false" : "true"}"
      data-task-id="${escapeHtml(task.id)}"
      data-draggable-task="true"
      role="button"
      aria-pressed="${selected}"
    >
      <strong>${escapeHtml(task.title)}</strong>
      ${renderDescriptionPreview(task.description)}
      <div class="board-task-meta">${renderTaskMeta(task)}</div>
    </article>
  `;
}

function renderListRow(task, selected) {
  return `
    <article
      class="board-list-row ${selected ? "is-selected" : ""}"
      data-task-id="${escapeHtml(task.id)}"
      tabindex="0"
      role="button"
      aria-pressed="${selected}"
    >
      <div class="board-list-row__summary">
        <strong>${escapeHtml(task.title)}</strong>
        ${renderDescriptionPreview(task.description)}
      </div>
      <span class="board-list-row__status">${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
      <span class="board-list-row__meta">${task.subtasks.length}</span>
      <span class="board-list-row__meta">${escapeHtml(formatDate(task.updatedAt))}</span>
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

function renderDependencyList(task, snapshot, isMutating = false) {
  if (task.blockedBy.length === 0) {
    return renderEmptyState("No dependencies", "Add blockers here to keep task transitions honest.");
  }

  return task.blockedBy.map((dependencyId) => {
    const dependency = lookupNode(snapshot, dependencyId);
    return `
      <article class="board-inline-row">
        <div>
          <strong>${escapeHtml(readNodeLabel(dependency?.kind ?? "task", dependency?.title ?? dependencyId))}</strong>
          ${renderDescriptionPreview(dependency?.description ?? "")}
        </div>
        <div class="board-inline-row__actions">
          <span class="board-status-pill">${escapeHtml(STATUS_LABELS[dependency?.status] ?? dependency?.status ?? "Unknown")}</span>
          <button type="button" class="board-button" data-remove-dependency-source="${escapeHtml(task.id)}" data-remove-dependency-target="${escapeHtml(dependencyId)}" ${isMutating ? "disabled" : ""}>Remove</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderSubtaskList(task) {
  if (task.subtasks.length === 0) {
    return renderEmptyState("No subtasks", "This task does not have subtasks in the current snapshot.");
  }

  return `
    <div class="board-inline-list">
      ${task.subtasks.map((subtask) => `
        <article class="board-inline-row">
          <div>
            <strong>${escapeHtml(subtask.title)}</strong>
            ${renderDescriptionPreview(subtask.description)}
          </div>
          <div class="board-inline-row__actions">
            <span class="board-status-pill">${escapeHtml(STATUS_LABELS[subtask.status] ?? subtask.status)}</span>
            <button type="button" class="board-button" data-open-subtask="${escapeHtml(subtask.id)}">Open</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderSubtaskModal(subtask, isMutating = false) {
  return `
    <div class="board-modal-backdrop" data-close-subtask>
      <section class="board-panel board-modal" role="dialog" aria-modal="true" aria-labelledby="board-subtask-modal-title">
        <header class="board-modal__header">
          <div>
            <span class="board-pill">Subtask</span>
            <h3 id="board-subtask-modal-title">${escapeHtml(subtask.title)}</h3>
          </div>
          <button type="button" class="board-button" data-close-subtask>Close</button>
        </header>
        <div class="board-modal__body">
          <form data-subtask-form="${escapeHtml(subtask.id)}">
            <label>
              <span>Title</span>
              <input name="title" value="${escapeHtml(subtask.title)}" required ${isMutating ? "disabled" : ""} />
            </label>
            <label>
              <span>Description</span>
              <textarea name="description" rows="5" ${isMutating ? "disabled" : ""}>${escapeHtml(subtask.description)}</textarea>
            </label>
            <label>
              <span>Status</span>
              ${renderStatusSelect("status", subtask.status, isMutating)}
            </label>
            <div class="board-modal__actions">
              <button type="submit" class="board-button" ${isMutating ? "disabled" : ""}>Save subtask</button>
              <button type="button" class="board-button" data-close-subtask>Cancel</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

function renderDrawer(task, epics, snapshot, isMutating = false) {
  const epic = epics.find((candidate) => candidate.id === task.epicId) ?? null;
  const dependencyOptions = renderDependencyOptions(task, snapshot);
  return `
    <header class="board-drawer__header">
      <div class="board-drawer__title">
        <div>
          <span class="board-pill">Task view</span>
          <h3>${escapeHtml(task.title)}</h3>
        </div>
        <button type="button" class="board-button" data-close-task>Close</button>
      </div>
      <div class="board-drawer__actions">
        <span class="board-chip">Epic ${escapeHtml(epic?.title ?? "Unknown")}</span>
        <span class="board-chip">${escapeHtml(STATUS_LABELS[task.status] ?? task.status)}</span>
      </div>
      ${task.description.trim().length > 0
        ? `<div class="board-drawer__description">${escapeHtml(task.description).replaceAll("\n", "<br />")}</div>`
        : `<p class="board-muted">No task description provided.</p>`}
    </header>
    <div class="board-drawer__body">
      <section class="board-section">
        <div class="board-meta-grid">
          <span class="board-chip">Updated ${escapeHtml(formatDate(task.updatedAt))}</span>
          <span class="board-chip">Depends on ${task.blockedBy.length}</span>
          <span class="board-chip">Blocks ${task.blocks.length}</span>
        </div>
      </section>
      <details class="board-disclosure">
        <summary>Edit task</summary>
        <form data-task-form="${escapeHtml(task.id)}">
          <label>
            <span>Title</span>
            <input name="title" value="${escapeHtml(task.title)}" required ${isMutating ? "disabled" : ""} />
          </label>
          <label>
            <span>Description</span>
            <textarea name="description" rows="4" ${isMutating ? "disabled" : ""}>${escapeHtml(task.description)}</textarea>
          </label>
          <label>
            <span>Status</span>
            ${renderStatusSelect("status", task.status, isMutating)}
          </label>
          <button type="submit" class="board-button" ${isMutating ? "disabled" : ""}>Save task</button>
        </form>
      </details>
      <details class="board-disclosure">
        <summary>Dependencies</summary>
        <form data-dependency-form="${escapeHtml(task.id)}">
          <label>
            <span>Add dependency</span>
            <select name="dependsOnId" required ${isMutating ? "disabled" : ""}>
              <option value="">Select a task or subtask</option>
              ${dependencyOptions}
            </select>
          </label>
          <button type="submit" class="board-button" ${isMutating ? "disabled" : ""}>Add dependency</button>
        </form>
        <div class="board-inline-list">
          ${renderDependencyList(task, snapshot, isMutating)}
        </div>
      </details>
      <section class="board-section">
        <div class="board-section__header">
          <strong>Subtasks</strong>
          <span class="board-chip">${task.subtasks.length}</span>
        </div>
        ${renderSubtaskList(task)}
      </section>
    </div>
  `;
}

function renderBoard(model) {
  const { store, getSelectedEpic, getSelectedTask, getSubtaskById, getVisibleEpics, getVisibleTasks } = model;
  const visibleEpics = getVisibleEpics();
  const visibleTasks = getVisibleTasks();
  const selectedEpic = getSelectedEpic();
  const selectedTask = getSelectedTask();
  const selectedSubtask = getSubtaskById(store.selectedSubtaskId);
  const screen = store.screen === "tasks" && selectedEpic ? "tasks" : "epics";

  if (screen !== store.screen) {
    store.screen = screen;
    model.persist();
  }

  const columnsMarkup = STATUS_ORDER.map((status) => {
    const columnTasks = visibleTasks.filter((task) => task.status === status);
    const columnTitle = STATUS_LABELS[status] ?? status;
    const content = columnTasks.length === 0
      ? renderEmptyState(`No ${columnTitle.toLowerCase()} work`, "Adjust search or switch epics to inspect more tasks.")
      : columnTasks
          .map((task) => renderTaskCard(task, selectedTask?.id === task.id, store.isMutating))
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
    : visibleTasks.map((task) => renderListRow(task, selectedTask?.id === task.id)).join("");

  const topbarMarkup = `
    <header class="board-panel board-topbar">
      <div class="board-topbar__identity">
        <span class="board-pill">${screen === "tasks" ? "Epic workspace" : "Epics overview"}</span>
        <h1>Trekoon board</h1>
        <p>${screen === "tasks"
          ? "Compact task board for moving work inside a selected epic."
          : "Start with an epic, then switch into a focused task board."}</p>
      </div>
      <div class="board-topbar__actions">
        ${screen === "tasks" ? `<button type="button" class="board-button" data-nav="epics">All epics</button>` : ""}
        <label class="board-search" aria-label="Search tasks and epics">
          <span class="board-kbd">/</span>
          <input id="board-search-input" type="search" placeholder="Search epics, tasks, subtasks" value="${escapeHtml(store.search)}" />
        </label>
        <button type="button" class="board-button" data-action="toggle-theme">${store.theme === "dark" ? "Light" : "Dark"}</button>
      </div>
    </header>
  `;

  const epicsOverviewMarkup = `
    <div class="board-root board-root--epics">
      <section class="board-panel board-overview" aria-label="Epics overview">
        <header class="board-section-head">
          <div>
            <span class="board-pill">Pick an epic</span>
            <h2>Epics</h2>
            <p>Open an epic to see a compact GitLab-style task board and list view.</p>
          </div>
          <div class="board-legend">
            <span class="board-chip">${visibleEpics.length} visible epic${visibleEpics.length === 1 ? "" : "s"}</span>
            <span class="board-chip">${store.snapshot.tasks.length} total tasks</span>
            ${store.isMutating ? `<span class="board-chip">Saving…</span>` : ""}
          </div>
        </header>
        <div class="board-table">
          <div class="board-table__header">
            <span>Epic</span>
            <span>Status</span>
            <span>Tasks</span>
            <span>Updated</span>
            <span></span>
          </div>
          <div class="board-table__rows">
            ${visibleEpics.length === 0
              ? renderEmptyState("No matching epics", "Try a different search or publish more work to the board.", "/")
              : visibleEpics.map((epic) => renderEpicRow(epic, store.selectedEpicId === epic.id)).join("")}
          </div>
        </div>
      </section>
    </div>
  `;

  const tasksWorkspaceMarkup = selectedEpic ? `
    <div class="board-root board-root--tasks ${selectedTask ? "has-detail" : ""}">
      <aside class="board-panel board-sidebar" aria-label="Epic switcher">
        <header class="board-sidebar__header">
          <span class="board-pill">Epics</span>
          <h2>Switch epic</h2>
          <p>Titles only for faster navigation.</p>
        </header>
        <div class="board-sidebar__list">
          ${store.snapshot.epics.map((epic) => renderEpicSidebarItem(epic, store.selectedEpicId === epic.id)).join("")}
        </div>
      </aside>

      <section class="board-panel board-workspace" aria-label="Workspace">
        <header class="board-section-head board-section-head--workspace">
          <div>
            <span class="board-pill">Selected epic</span>
            <h2>${escapeHtml(selectedEpic.title)}</h2>
            <p>${escapeHtml(selectedEpic.description || "No epic description yet.")}</p>
          </div>
          <div class="board-workspace__toolbar">
            <label class="board-select" aria-label="Choose epic">
              <span>Epic</span>
              <select id="board-epic-select">
                ${store.snapshot.epics.map((epic) => `
                  <option value="${escapeHtml(epic.id)}" ${store.selectedEpicId === epic.id ? "selected" : ""}>
                    ${escapeHtml(epic.title)}
                  </option>
                `).join("")}
              </select>
            </label>
            <div class="board-tabs" role="tablist" aria-label="Board views">
              ${VIEW_MODES.map((view) => `<button class="board-tab" type="button" role="tab" aria-selected="${store.view === view}" data-view="${view}">${view === "kanban" ? "Kanban" : "Rows"}</button>`).join("")}
            </div>
          </div>
          <div class="board-legend">
            ${renderEpicCountSummary(selectedEpic)}
            <span class="board-chip">${visibleTasks.length} visible</span>
            <span class="board-chip">Click a task to open details</span>
            ${store.view === "kanban" ? `<span class="board-chip">Drag to move</span>` : ""}
            ${store.isMutating ? `<span class="board-chip">Saving…</span>` : ""}
          </div>
        </header>

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

      ${selectedTask ? `
        <aside class="board-panel board-drawer is-open" aria-label="Task drawer">
          ${renderDrawer(selectedTask, store.snapshot.epics, store.snapshot, store.isMutating)}
        </aside>
      ` : ""}
    </div>
  ` : epicsOverviewMarkup;

  appElement.innerHTML = `
    ${renderNotice(store.notice)}
    <div class="board-layout">
      ${topbarMarkup}
      ${screen === "tasks" ? tasksWorkspaceMarkup : epicsOverviewMarkup}
      ${selectedSubtask ? renderSubtaskModal(selectedSubtask, store.isMutating) : ""}
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
    if (store.selectedTaskId && !getVisibleTasks().some((task) => task.id === store.selectedTaskId)) {
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
    }
    persist();
    renderBoard(model);
    attachInteractions(model, api);
    document.querySelector("#board-search-input")?.focus();
  });

  document.querySelectorAll("[data-open-epic]").forEach((button) => {
    button.addEventListener("click", () => {
      store.screen = "tasks";
      store.selectedEpicId = button.dataset.openEpic || null;
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelector("#board-epic-select")?.addEventListener("change", (event) => {
    store.screen = "tasks";
    store.selectedEpicId = event.target.value || null;
    store.selectedTaskId = null;
    store.selectedSubtaskId = null;
    persist();
    renderBoard(model);
    attachInteractions(model, api);
  });

  document.querySelector("[data-nav='epics']")?.addEventListener("click", () => {
    store.screen = "epics";
    store.selectedTaskId = null;
    store.selectedSubtaskId = null;
    persist();
    renderBoard(model);
    attachInteractions(model, api);
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

  document.querySelectorAll("[data-close-task]").forEach((button) => {
    button.addEventListener("click", () => {
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-open-subtask]").forEach((button) => {
    button.addEventListener("click", () => {
      store.selectedSubtaskId = button.dataset.openSubtask || null;
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelectorAll("[data-close-subtask]").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.currentTarget !== event.target && event.currentTarget?.classList?.contains("board-modal-backdrop")) {
        return;
      }
      store.selectedSubtaskId = null;
      renderBoard(model);
      attachInteractions(model, api);
    });
  });

  document.querySelector(".board-modal")?.addEventListener("click", (event) => {
    event.stopPropagation();
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
      store.selectedSubtaskId = subtaskId;
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
      } else if (store.selectedSubtaskId) {
        store.selectedSubtaskId = null;
        renderBoard(model);
        attachInteractions(model, api);
      } else if (store.selectedTaskId) {
        store.selectedTaskId = null;
        persist();
        renderBoard(model);
        attachInteractions(model, api);
      } else if (store.screen === "tasks") {
        store.screen = "epics";
        persist();
        renderBoard(model);
        attachInteractions(model, api);
      } else {
        store.notice = null;
      }
      return;
    }

    if (store.screen !== "tasks" || isTypingTarget || visibleTasks.length === 0) return;

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
      return;
    }

    if (event.key === "Enter" && currentIndex === -1 && visibleTasks[0]) {
      event.preventDefault();
      store.selectedTaskId = visibleTasks[0].id;
      persist();
      renderBoard(model);
      attachInteractions(model, api);
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
