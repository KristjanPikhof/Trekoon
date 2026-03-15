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

const NAV_ITEMS = [
  { id: "epics", label: "Epics", icon: "layers" },
  { id: "board", label: "Board", icon: "view_kanban" },
  { id: "detail", label: "Detail", icon: "assignment" },
];

const STATUS_BADGE_STYLES = {
  todo: "border-white/10 bg-white/[0.05] text-[var(--board-text-muted)]",
  blocked: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  in_progress: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  done: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  default: "border-[var(--board-border)] bg-white/[0.04] text-[var(--board-text-muted)]",
};

function cx(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

function renderIcon(name, className = "") {
  return `<span class="${cx("material-symbols-rounded shrink-0", className)}" aria-hidden="true">${name}</span>`;
}

function panelClasses(extra = "") {
  return cx(
    "rounded-[28px] border border-[var(--board-border)] bg-[var(--board-surface)] shadow-panel",
    extra,
  );
}

function secondaryPanelClasses(extra = "") {
  return cx(
    "rounded-[24px] border border-[var(--board-border)] bg-[var(--board-surface-2)]",
    extra,
  );
}

function buttonClasses(options = {}) {
  const kind = options.kind ?? "secondary";
  const iconOnly = options.iconOnly ?? false;

  return cx(
    "inline-flex items-center justify-center gap-2 rounded-2xl border text-sm font-medium transition duration-200",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-bg)]",
    iconOnly ? "h-10 w-10 px-0" : "min-h-10 px-4 py-2.5",
    kind === "primary"
      ? "border-[var(--board-accent)] bg-[var(--board-accent)] text-white hover:bg-[var(--board-accent-strong)] hover:border-[var(--board-accent-strong)]"
      : "border-[var(--board-border)] bg-white/[0.04] text-[var(--board-text)] hover:bg-white/[0.08] hover:border-[var(--board-border-strong)]",
  );
}

function fieldClasses() {
  return cx(
    "w-full rounded-2xl border border-[var(--board-border)] bg-[var(--board-surface-2)] px-3.5 py-3 text-sm text-[var(--board-text)] shadow-sm transition",
    "placeholder:text-[var(--board-text-soft)] focus:border-[var(--board-border-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--board-accent-soft)]",
    "disabled:cursor-not-allowed disabled:opacity-60",
  );
}

function sectionLabelClasses() {
  return "text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--board-text-soft)]";
}

function neutralChipClasses() {
  return "inline-flex items-center gap-1 rounded-full border border-[var(--board-border)] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-[var(--board-text-muted)]";
}

function metricCardClasses() {
  return panelClasses("p-4 sm:p-5");
}

function statusBadgeClasses(status) {
  return cx(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
    STATUS_BADGE_STYLES[normalizeStatus(status)] ?? STATUS_BADGE_STYLES.default,
  );
}

function renderStatusBadge(rawStatus, label = readStatusLabel(rawStatus)) {
  return `<span class="${statusBadgeClasses(rawStatus)}">${escapeHtml(label)}</span>`;
}

function renderMetricCard(icon, label, value, detail) {
  return `
    <section class="${metricCardClasses()}">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="${sectionLabelClasses()}">${escapeHtml(label)}</p>
          <p class="mt-3 text-2xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(value)}</p>
          <p class="mt-2 text-sm text-[var(--board-text-muted)]">${escapeHtml(detail)}</p>
        </div>
        <div class="flex h-11 w-11 items-center justify-center rounded-2xl bg-[var(--board-accent-soft)] text-[var(--board-accent)] ring-1 ring-[var(--board-border-strong)]">
          ${renderIcon(icon, "text-[20px]")}
        </div>
      </div>
    </section>
  `;
}

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

function readStatusLabel(rawStatus) {
  if (typeof rawStatus !== "string" || rawStatus.trim().length === 0) {
    return "Unknown";
  }

  if (rawStatus === "todo" || rawStatus === "blocked" || rawStatus === "in_progress" || rawStatus === "done" || rawStatus === "in-progress") {
    return STATUS_LABELS[normalizeStatus(rawStatus)] ?? rawStatus;
  }

  return rawStatus.replaceAll("_", " ").replaceAll("-", " ");
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
    <div class="rounded-[24px] border border-dashed border-[var(--board-border-strong)] bg-[var(--board-accent-soft)]/40 px-5 py-6 text-center">
      <strong class="block text-base font-semibold text-[var(--board-text)]">${escapeHtml(title)}</strong>
      <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(description)}</p>
      ${shortcut
        ? `<p class="mt-3 text-xs text-[var(--board-text-soft)]">Try <span class="inline-flex items-center rounded-lg border border-[var(--board-border)] bg-white/[0.04] px-2 py-1 font-medium text-[var(--board-text-muted)]">${escapeHtml(shortcut)}</span></p>`
        : ""}
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
    createSubtask(input, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Subtask added.",
        request: () => request("/api/subtasks", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      });
    },
    deleteSubtask(subtaskId, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Subtask removed.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "DELETE",
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

function createSubtaskInSnapshot(snapshot, input) {
  const nextSnapshot = cloneSnapshot(snapshot);
  normalizeArray(nextSnapshot.subtasks).push({
    id: crypto.randomUUID(),
    taskId: input.taskId,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "todo",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return normalizeSnapshot(nextSnapshot);
}

function deleteSubtaskInSnapshot(snapshot, subtaskId) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.subtasks = normalizeArray(nextSnapshot.subtasks).filter((candidate) => candidate.id !== subtaskId);
  nextSnapshot.dependencies = normalizeArray(nextSnapshot.dependencies).filter(
    (dependency) => dependency.sourceId !== subtaskId && dependency.dependsOnId !== subtaskId,
  );
  return normalizeSnapshot(nextSnapshot);
}

function renderStatusSelect(name, selectedStatus, disabled = false) {
  return `
    <select class="${fieldClasses()}" name="${escapeHtml(name)}" ${disabled ? "disabled" : ""}>
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
    <section class="${panelClasses("mb-4 flex items-start gap-3 p-4 sm:p-5")}" aria-live="polite">
      <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${notice.type === "error" ? "bg-red-500/10 text-red-300 ring-1 ring-red-500/20" : "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20"}">
        ${renderIcon(notice.type === "error" ? "warning" : "check_circle", "text-[20px]")}
      </div>
      <div class="min-w-0">
        <p class="${sectionLabelClasses()}">${notice.type === "error" ? "Action blocked" : "Saved"}</p>
        <p class="mt-1 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(notice.message)}</p>
      </div>
    </section>
  `;
}

function renderDescriptionPreview(description, className = "mt-1 text-sm leading-6 text-[var(--board-text-muted)]") {
  if (!description || description.trim().length === 0) {
    return "";
  }

  return `<p class="${escapeHtml(className)}">${escapeHtml(description)}</p>`;
}

function renderEpicCountSummary(epic) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  const counts = epic.counts || { todo: 0, blocked: 0, in_progress: 0, done: 0 };

  return `
    <span class="${neutralChipClasses()}">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
    <span class="${neutralChipClasses()}">${counts.in_progress ?? 0} doing</span>
    <span class="${neutralChipClasses()}">${counts.done ?? 0} done</span>
  `;
}

function renderEpicSidebarItem(epic, selected) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  return `
    <button
      type="button"
      class="board-sidebar-item ${cx(
        "w-full rounded-2xl border px-3.5 py-3 text-left transition duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
        selected
          ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] text-[var(--board-text)] shadow-focus"
          : "border-[var(--board-border)] bg-white/[0.03] text-[var(--board-text-muted)] hover:border-[var(--board-border-strong)] hover:bg-white/[0.06]",
      )}"
      aria-current="${selected}"
      data-open-epic="${escapeHtml(epic.id)}"
    >
      <div class="flex items-start gap-3">
        <div class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${selected ? "bg-[var(--board-accent)] text-white" : "bg-[var(--board-surface-3)] text-[var(--board-accent)]"}">
          ${renderIcon("folder", "text-[18px]")}
        </div>
        <div class="min-w-0">
          <strong class="block truncate text-sm font-semibold text-[var(--board-text)]">${escapeHtml(epic.title)}</strong>
          <span class="mt-1 block text-xs text-[var(--board-text-soft)]">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
        </div>
      </div>
    </button>
  `;
}

function renderEpicRow(epic, selected) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  return `
    <button
      type="button"
      class="board-epic-row ${cx(
        "grid w-full gap-4 rounded-3xl border px-4 py-4 text-left transition duration-200 md:grid-cols-[minmax(0,1.8fr)_140px_90px_170px_84px] md:items-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
        selected
          ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] shadow-focus"
          : "border-[var(--board-border)] bg-white/[0.02] hover:border-[var(--board-border-strong)] hover:bg-white/[0.04]",
      )}"
      data-open-epic="${escapeHtml(epic.id)}"
      aria-current="${selected}"
    >
      <div class="board-epic-row__summary min-w-0">
        <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--board-text-soft)]">
          <span class="${neutralChipClasses()}">${escapeHtml(epic.id)}</span>
        </div>
        <strong class="mt-3 block text-base font-semibold leading-6 text-[var(--board-text)]">${escapeHtml(epic.title)}</strong>
        ${renderDescriptionPreview(epic.description)}
      </div>
      <div class="flex items-center md:justify-start">${renderStatusBadge(epic.status ?? "todo", readStatusLabel(epic.status ?? "Epic"))}</div>
      <span class="text-sm font-medium text-[var(--board-text-muted)]">${totalTasks}</span>
      <span class="text-sm text-[var(--board-text-muted)]">${escapeHtml(formatDate(epic.updatedAt))}</span>
      <span class="inline-flex items-center gap-1 text-sm font-medium text-[var(--board-accent)]">Open ${renderIcon("chevron_right", "text-[16px]")}</span>
    </button>
  `;
}

function renderTaskMeta(task, includeStatus = false) {
  return `
    ${includeStatus ? renderStatusBadge(task.status) : ""}
    <span class="${neutralChipClasses()}">${task.subtasks.length} subtask${task.subtasks.length === 1 ? "" : "s"}</span>
    ${task.blockedBy.length > 0 ? `<span class="${neutralChipClasses()}">${task.blockedBy.length} blocker${task.blockedBy.length === 1 ? "" : "s"}</span>` : ""}
  `;
}

function renderTaskCard(task, selected, isMutating = false) {
  return `
    <article
      class="board-task-card ${cx(
        "rounded-3xl border p-4 transition duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
        selected
          ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] shadow-focus"
          : "border-[var(--board-border)] bg-[var(--board-surface-2)] shadow-[0_10px_30px_rgba(0,0,0,0.18)] hover:-translate-y-0.5 hover:border-[var(--board-border-strong)] hover:shadow-lift",
      )}"
      tabindex="0"
      draggable="${isMutating ? "false" : "true"}"
      data-task-id="${escapeHtml(task.id)}"
      data-draggable-task="true"
      role="button"
      aria-pressed="${selected}"
    >
      <div class="flex items-start justify-between gap-3">
        ${renderStatusBadge(task.status)}
        <span class="text-xs uppercase tracking-[0.16em] text-[var(--board-text-soft)]">Task</span>
      </div>
      <strong class="mt-4 block text-base font-semibold leading-6 text-[var(--board-text)]">${escapeHtml(task.title)}</strong>
      ${renderDescriptionPreview(task.description, "mt-2 overflow-hidden text-sm leading-6 text-[var(--board-text-muted)] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:3]")}
      <div class="mt-4 flex flex-wrap gap-2">${renderTaskMeta(task)}</div>
    </article>
  `;
}

function renderListRow(task, selected) {
  return `
    <article
      class="board-list-row ${cx(
        "grid gap-4 rounded-3xl border px-4 py-4 transition duration-200 md:grid-cols-[minmax(0,1.8fr)_140px_90px_170px] md:items-center",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
        selected
          ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] shadow-focus"
          : "border-[var(--board-border)] bg-white/[0.02] hover:border-[var(--board-border-strong)] hover:bg-white/[0.04]",
      )}"
      data-task-id="${escapeHtml(task.id)}"
      tabindex="0"
      role="button"
      aria-pressed="${selected}"
    >
      <div class="board-list-row__summary min-w-0">
        <strong class="block text-sm font-semibold text-[var(--board-text)] sm:text-base">${escapeHtml(task.title)}</strong>
        ${renderDescriptionPreview(task.description)}
      </div>
      <span>${renderStatusBadge(task.status)}</span>
      <span class="text-sm font-medium text-[var(--board-text-muted)]">${task.subtasks.length}</span>
      <span class="text-sm text-[var(--board-text-muted)]">${escapeHtml(formatDate(task.updatedAt))}</span>
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
      <article class="grid gap-4 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div class="min-w-0">
          <strong class="block text-sm font-semibold text-[var(--board-text)]">${escapeHtml(readNodeLabel(dependency?.kind ?? "task", dependency?.title ?? dependencyId))}</strong>
          ${renderDescriptionPreview(dependency?.description ?? "")}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${renderStatusBadge(dependency?.status ?? "todo", readStatusLabel(dependency?.status ?? "Unknown"))}
          <button type="button" class="${buttonClasses()}" data-remove-dependency-source="${escapeHtml(task.id)}" data-remove-dependency-target="${escapeHtml(dependencyId)}" ${isMutating ? "disabled" : ""}>Remove</button>
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
    <div class="space-y-3">
      ${task.subtasks.map((subtask) => `
        <article class="grid gap-4 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div class="min-w-0">
            <strong class="block text-sm font-semibold text-[var(--board-text)]">${escapeHtml(subtask.title)}</strong>
            ${renderDescriptionPreview(subtask.description)}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            ${renderStatusBadge(subtask.status)}
            <button type="button" class="${buttonClasses()}" data-open-subtask="${escapeHtml(subtask.id)}">Open</button>
            <button type="button" class="${buttonClasses()}" data-delete-subtask="${escapeHtml(subtask.id)}">Remove</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderCreateSubtaskForm(task, isMutating = false) {
  return `
    <form class="grid gap-4 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] p-4" data-create-subtask-form="${escapeHtml(task.id)}">
      <div>
        <span class="${sectionLabelClasses()}">Add subtask</span>
        <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">Create a new subtask directly from the task detail panel.</p>
      </div>
      <label class="grid gap-2">
        <span class="${sectionLabelClasses()}">Title</span>
        <input class="${fieldClasses()}" name="title" placeholder="Write tests" required ${isMutating ? "disabled" : ""} />
      </label>
      <label class="grid gap-2">
        <span class="${sectionLabelClasses()}">Description</span>
        <textarea class="${fieldClasses()} min-h-[96px]" name="description" rows="3" placeholder="Optional context for this subtask" ${isMutating ? "disabled" : ""}></textarea>
      </label>
      <label class="grid gap-2">
        <span class="${sectionLabelClasses()}">Status</span>
        ${renderStatusSelect("status", "todo", isMutating)}
      </label>
      <div class="flex justify-end">
        <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Add subtask</button>
      </div>
    </form>
  `;
}

function renderSubtaskModal(subtask, isMutating = false) {
  return `
    <div class="board-modal-backdrop fixed inset-0 z-40 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-md" data-close-subtask>
      <section class="board-modal ${panelClasses("grid max-h-[calc(100vh-2rem)] w-full max-w-2xl grid-rows-[auto_1fr] overflow-hidden p-5 sm:p-6")}" role="dialog" aria-modal="true" aria-labelledby="board-subtask-modal-title">
        <header class="board-modal__header border-b border-[var(--board-border)] pb-5">
          <div>
            <span class="${sectionLabelClasses()}">Subtask editor</span>
            <h3 id="board-subtask-modal-title" class="mt-2 text-xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(subtask.title)}</h3>
          </div>
          <button type="button" class="${buttonClasses()} mt-4 sm:mt-0" data-close-subtask>Close</button>
        </header>
        <div class="board-modal__body overflow-auto pt-5">
          <form class="grid gap-4" data-subtask-form="${escapeHtml(subtask.id)}">
            <label class="grid gap-2">
              <span class="${sectionLabelClasses()}">Title</span>
              <input class="${fieldClasses()}" name="title" value="${escapeHtml(subtask.title)}" required ${isMutating ? "disabled" : ""} />
            </label>
            <label class="grid gap-2">
              <span class="${sectionLabelClasses()}">Description</span>
              <textarea class="${fieldClasses()} min-h-[144px]" name="description" rows="5" ${isMutating ? "disabled" : ""}>${escapeHtml(subtask.description)}</textarea>
            </label>
            <label class="grid gap-2">
              <span class="${sectionLabelClasses()}">Status</span>
              ${renderStatusSelect("status", subtask.status, isMutating)}
            </label>
            <div class="board-modal__actions mt-2 flex flex-wrap justify-end gap-3">
              <button type="button" class="${buttonClasses()}" data-close-subtask>Cancel</button>
              <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Save subtask</button>
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
    <header class="board-drawer__header border-b border-[var(--board-border)] pb-5">
      <div class="board-drawer__title flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <span class="${sectionLabelClasses()}">Task detail</span>
          <h3 class="mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(task.title)}</h3>
        </div>
        <button type="button" class="${buttonClasses()} shrink-0" data-close-task>Close</button>
      </div>
      <div class="board-drawer__actions mt-4 flex flex-wrap gap-2">
        <span class="${neutralChipClasses()}">Epic ${escapeHtml(epic?.title ?? "Unknown")}</span>
        ${renderStatusBadge(task.status)}
      </div>
      ${task.description.trim().length > 0
        ? `<div class="board-drawer__description mt-4 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 text-sm leading-7 text-[var(--board-text-muted)]">${escapeHtml(task.description).replaceAll("\n", "<br />")}</div>`
        : `<p class="mt-4 text-sm leading-6 text-[var(--board-text-muted)]">No task description provided.</p>`}
    </header>
    <div class="board-drawer__body space-y-4 overflow-auto pt-5">
      <section class="${secondaryPanelClasses("p-4")}">
        <div class="board-meta-grid flex flex-wrap gap-2">
          <span class="${neutralChipClasses()}">Updated ${escapeHtml(formatDate(task.updatedAt))}</span>
          <span class="${neutralChipClasses()}">Depends on ${task.blockedBy.length}</span>
          <span class="${neutralChipClasses()}">Blocks ${task.blocks.length}</span>
        </div>
      </section>
      <details class="board-disclosure ${secondaryPanelClasses("p-4")}" open>
        <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Edit task</summary>
        <form class="mt-4 grid gap-4" data-task-form="${escapeHtml(task.id)}">
          <label class="grid gap-2">
            <span class="${sectionLabelClasses()}">Title</span>
            <input class="${fieldClasses()}" name="title" value="${escapeHtml(task.title)}" required ${isMutating ? "disabled" : ""} />
          </label>
          <label class="grid gap-2">
            <span class="${sectionLabelClasses()}">Description</span>
            <textarea class="${fieldClasses()} min-h-[120px]" name="description" rows="4" ${isMutating ? "disabled" : ""}>${escapeHtml(task.description)}</textarea>
          </label>
          <label class="grid gap-2">
            <span class="${sectionLabelClasses()}">Status</span>
            ${renderStatusSelect("status", task.status, isMutating)}
          </label>
          <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Save task</button>
        </form>
      </details>
      <details class="board-disclosure ${secondaryPanelClasses("p-4")}" open>
        <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Dependencies</summary>
        <form class="mt-4 grid gap-4" data-dependency-form="${escapeHtml(task.id)}">
          <label class="grid gap-2">
            <span class="${sectionLabelClasses()}">Add dependency</span>
            <select class="${fieldClasses()}" name="dependsOnId" required ${isMutating ? "disabled" : ""}>
              <option value="">Select a task or subtask</option>
              ${dependencyOptions}
            </select>
          </label>
          <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Add dependency</button>
        </form>
        <div class="board-inline-list mt-4 space-y-3">
          ${renderDependencyList(task, snapshot, isMutating)}
        </div>
      </details>
      <section class="${secondaryPanelClasses("p-4")}">
        <div class="board-section__header flex items-center justify-between gap-3">
          <strong class="text-sm font-semibold text-[var(--board-text)]">Subtasks</strong>
          <span class="${neutralChipClasses()}">${task.subtasks.length}</span>
        </div>
        <div class="mt-4 space-y-4">
          ${renderCreateSubtaskForm(task, isMutating)}
          ${renderSubtaskList(task)}
        </div>
      </section>
    </div>
  `;
}

function renderTaskModal(task, epics, snapshot, isMutating = false) {
  return `
    <div class="board-task-modal-backdrop fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-md" data-close-task>
      <section class="board-task-modal ${panelClasses("grid max-h-[calc(100vh-2rem)] w-full max-w-3xl grid-rows-[1fr] overflow-hidden p-5 sm:p-6")}" role="dialog" aria-modal="true" aria-labelledby="board-task-modal-title">
        <div class="min-h-0">
          ${renderDrawer(task, epics, snapshot, isMutating).replace("<h3 class=\"mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)]\">", "<h3 id=\"board-task-modal-title\" class=\"mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)]\">")}
        </div>
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
  const useTaskModal = Boolean(selectedTask && store.view === "kanban");
  const currentNav = selectedTask ? "detail" : screen === "tasks" ? "board" : "epics";
  const overallCounts = deriveCounts(store.snapshot.tasks);
  const completionRate = store.snapshot.tasks.length === 0
    ? 0
    : Math.round(((overallCounts.done ?? 0) / store.snapshot.tasks.length) * 100);

  if (screen !== store.screen) {
    store.screen = screen;
    model.persist();
  }

  const columnsMarkup = STATUS_ORDER.map((status) => {
    const columnTasks = visibleTasks.filter((task) => task.status === status);
    const columnTitle = readStatusLabel(status);
    const content = columnTasks.length === 0
      ? renderEmptyState(`No ${columnTitle.toLowerCase()} work`, "Adjust search or switch epics to inspect more tasks.")
      : columnTasks
          .map((task) => renderTaskCard(task, selectedTask?.id === task.id, store.isMutating))
          .join("");

    return `
      <section class="board-column ${secondaryPanelClasses("grid min-h-0 grid-rows-[auto_1fr] p-3 sm:p-4")}" aria-labelledby="column-${status}">
        <header class="flex items-center justify-between gap-3 border-b border-[var(--board-border)] pb-3">
          <div>
            <p class="${sectionLabelClasses()}">${escapeHtml(columnTitle)}</p>
            <div class="mt-2">${renderStatusBadge(status, `${columnTasks.length} item${columnTasks.length === 1 ? "" : "s"}`)}</div>
          </div>
          <div class="flex h-9 w-9 items-center justify-center rounded-2xl bg-white/[0.04] text-[var(--board-text-soft)]">
            ${renderIcon("add", "text-[18px]")}
          </div>
        </header>
        <div class="board-column__tasks mt-4 grid min-h-0 content-start gap-3 overflow-auto pr-1" id="column-${status}" data-drop-status="${escapeHtml(status)}">${content}</div>
      </section>
    `;
  }).join("");

  const listRows = visibleTasks.length === 0
    ? renderEmptyState("No matching tasks", "Nothing in this slice matches the active search and epic filters.", "/")
    : visibleTasks.map((task) => renderListRow(task, selectedTask?.id === task.id)).join("");

  const topbarMarkup = `
    <header class="sticky top-4 z-20 ${panelClasses("bg-[var(--board-shell)]/95 p-4 backdrop-blur-xl sm:p-5")}">
      <div class="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
          <div class="flex items-center gap-3">
            <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--board-accent-soft)] text-[var(--board-accent)] ring-1 ring-[var(--board-border-strong)]">
              ${renderIcon("rocket_launch", "text-[22px]")}
            </div>
            <div>
              <span class="${sectionLabelClasses()}">${screen === "tasks" ? "Task workspace" : "Product ops"}</span>
              <h1 class="mt-1 text-xl font-semibold tracking-tight text-[var(--board-text)] sm:text-2xl">Trekoon</h1>
            </div>
          </div>
          <nav class="flex flex-wrap items-center gap-2">
            ${NAV_ITEMS.map((item) => {
              const isActive = currentNav === item.id;
              const common = cx(
                "inline-flex items-center gap-2 rounded-2xl border px-3.5 py-2 text-sm font-medium transition",
                isActive
                  ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] text-[var(--board-text)]"
                  : "border-[var(--board-border)] bg-white/[0.03] text-[var(--board-text-muted)]",
              );

              if (item.id === "epics") {
                return `<button type="button" class="${common}" data-nav="epics">${renderIcon(item.icon, "text-[18px]")} ${escapeHtml(item.label)}</button>`;
              }

              if (item.id === "board") {
                return `<button type="button" class="${common}" data-nav-board="true" ${selectedEpic ? "" : "disabled"}>${renderIcon(item.icon, "text-[18px]")} ${escapeHtml(item.label)}</button>`;
              }

              return `<span class="${common}">${renderIcon(item.icon, "text-[18px]")} ${escapeHtml(item.label)}</span>`;
            }).join("")}
          </nav>
        </div>
        <div class="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-end">
          <label class="flex min-h-11 items-center gap-3 rounded-2xl border border-[var(--board-border)] bg-[var(--board-surface-2)] px-3.5 text-sm text-[var(--board-text-muted)] lg:min-w-[320px]" aria-label="Search tasks and epics">
            ${renderIcon("search", "text-[18px] text-[var(--board-text-soft)]")}
            <input id="board-search-input" class="w-full border-0 bg-transparent py-2 text-sm text-[var(--board-text)] outline-none placeholder:text-[var(--board-text-soft)]" type="search" placeholder="Search epics, tasks, subtasks" value="${escapeHtml(store.search)}" />
            <span class="inline-flex items-center rounded-lg border border-[var(--board-border)] bg-white/[0.04] px-2 py-1 text-[11px] font-medium text-[var(--board-text-soft)]">/</span>
          </label>
          <button type="button" class="${buttonClasses()}" data-action="toggle-theme">${renderIcon(store.theme === "dark" ? "light_mode" : "dark_mode", "text-[18px]")} ${store.theme === "dark" ? "Light" : "Dark"}</button>
          <div class="inline-flex items-center gap-3 rounded-2xl border border-[var(--board-border)] bg-white/[0.03] px-3.5 py-2.5 text-sm text-[var(--board-text-muted)]">
            <span class="flex h-9 w-9 items-center justify-center rounded-2xl bg-[var(--board-surface-3)] text-sm font-semibold text-[var(--board-text)]">JD</span>
            <div>
              <div class="font-medium text-[var(--board-text)]">Local board</div>
              <div class="text-xs text-[var(--board-text-soft)]">Repo workspace</div>
            </div>
          </div>
        </div>
      </div>
    </header>
  `;

  const epicsOverviewMarkup = `
    <div class="board-root board-root--epics grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]" >
      <section class="board-overview ${panelClasses("p-5 sm:p-6")}" aria-label="Epics overview">
        <header class="board-section-head flex flex-col gap-5 border-b border-[var(--board-border)] pb-5">
          <div>
            <span class="${sectionLabelClasses()}">Epics overview</span>
            <h2 class="mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)] sm:text-3xl">Manage high-level initiatives</h2>
            <p class="mt-3 max-w-3xl text-sm leading-6 text-[var(--board-text-muted)] sm:text-base">Open an epic to move into a focused task workspace with kanban, rows, and an integrated detail drawer.</p>
          </div>
          <div class="board-legend flex flex-wrap gap-2">
            <span class="${neutralChipClasses()}">${visibleEpics.length} visible epic${visibleEpics.length === 1 ? "" : "s"}</span>
            <span class="${neutralChipClasses()}">${store.snapshot.tasks.length} total tasks</span>
            ${store.isMutating ? `<span class="${neutralChipClasses()}">Saving…</span>` : ""}
          </div>
        </header>
        <div class="board-table mt-6 grid gap-4">
          <div class="board-table__header hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--board-text-soft)] md:grid md:grid-cols-[minmax(0,1.8fr)_140px_90px_170px_84px]">
            <span>Epic</span>
            <span>Status</span>
            <span>Tasks</span>
            <span>Updated</span>
            <span>Open</span>
          </div>
          <div class="board-table__rows space-y-3">
            ${visibleEpics.length === 0
              ? renderEmptyState("No matching epics", "Try a different search or publish more work to the board.", "/")
              : visibleEpics.map((epic) => renderEpicRow(epic, store.selectedEpicId === epic.id)).join("")}
          </div>
        </div>
      </section>
      <aside class="grid gap-4">
        ${renderMetricCard("pending_actions", "Active epics", String(visibleEpics.length), "Published epics currently visible in this board slice.")}
        ${renderMetricCard("task_alt", "Tasks in play", String(store.snapshot.tasks.length), `${overallCounts.in_progress ?? 0} in progress · ${overallCounts.blocked ?? 0} blocked.`)}
        ${renderMetricCard("query_stats", "Completion", `${completionRate}%`, `${overallCounts.done ?? 0} completed tasks in the current snapshot.`)}
      </aside>
    </div>
  `;

  const tasksWorkspaceMarkup = selectedEpic ? `
    <div class="board-root board-root--tasks ${selectedTask && !useTaskModal ? "has-detail" : ""} grid gap-5 ${selectedTask && !useTaskModal ? "2xl:grid-cols-[280px_minmax(0,1fr)_420px]" : "xl:grid-cols-[280px_minmax(0,1fr)]"}">
      <aside class="board-sidebar ${panelClasses("hidden p-4 xl:block")}" aria-label="Epic switcher">
        <header class="board-sidebar__header border-b border-[var(--board-border)] pb-4">
          <span class="${sectionLabelClasses()}">Epics</span>
          <h2 class="mt-2 text-lg font-semibold tracking-tight text-[var(--board-text)]">Switch epic</h2>
          <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">Titles only for faster navigation through dense workstreams.</p>
        </header>
        <div class="board-sidebar__list mt-4 grid content-start gap-2.5">
          ${store.snapshot.epics.map((epic) => renderEpicSidebarItem(epic, store.selectedEpicId === epic.id)).join("")}
        </div>
      </aside>

      <section class="board-workspace ${panelClasses("p-5 sm:p-6")}" aria-label="Workspace">
        <header class="board-section-head board-section-head--workspace flex flex-col gap-5 border-b border-[var(--board-border)] pb-5">
          <div>
            <span class="${sectionLabelClasses()}">Selected epic</span>
            <h2 class="mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)] sm:text-3xl">${escapeHtml(selectedEpic.title)}</h2>
            <p class="mt-3 max-w-3xl text-sm leading-6 text-[var(--board-text-muted)] sm:text-base">${escapeHtml(selectedEpic.description || "No epic description yet.")}</p>
          </div>
          <div class="board-workspace__toolbar flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <label class="board-select grid gap-2 xl:min-w-[280px]" aria-label="Choose epic">
              <span class="${sectionLabelClasses()}">Epic</span>
              <select class="${fieldClasses()}" id="board-epic-select">
                ${store.snapshot.epics.map((epic) => `
                  <option value="${escapeHtml(epic.id)}" ${store.selectedEpicId === epic.id ? "selected" : ""}>
                    ${escapeHtml(epic.title)}
                  </option>
                `).join("")}
              </select>
            </label>
            <div class="flex flex-col gap-3 xl:items-end">
              <div class="board-tabs inline-flex rounded-2xl border border-[var(--board-border)] bg-white/[0.03] p-1" role="tablist" aria-label="Board views">
                ${VIEW_MODES.map((view) => `<button class="${cx("rounded-2xl px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]", store.view === view ? "bg-[var(--board-accent-soft)] text-[var(--board-text)] shadow-[inset_0_0_0_1px_var(--board-border-strong)]" : "text-[var(--board-text-muted)] hover:text-[var(--board-text)]")}" type="button" role="tab" aria-selected="${store.view === view}" data-view="${view}">${renderIcon(view === "kanban" ? "view_kanban" : "list", "text-[18px]")} ${view === "kanban" ? "Kanban" : "Rows"}</button>`).join("")}
              </div>
              <div class="board-legend flex flex-wrap gap-2">
                ${renderEpicCountSummary(selectedEpic)}
                <span class="${neutralChipClasses()}">${visibleTasks.length} visible</span>
                <span class="${neutralChipClasses()}">Click a task to open details</span>
                ${store.view === "kanban" ? `<span class="${neutralChipClasses()}">Drag to move</span>` : ""}
                ${store.isMutating ? `<span class="${neutralChipClasses()}">Saving…</span>` : ""}
              </div>
            </div>
          </div>
        </header>

        <div class="board-content mt-6 min-h-0">
          ${store.view === "kanban"
            ? `<div class="board-kanban grid min-h-0 gap-4 md:grid-cols-2 2xl:grid-cols-4">${columnsMarkup}</div>`
            : `
                <div class="board-list grid gap-4">
                  <div class="board-list__header hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--board-text-soft)] md:grid md:grid-cols-[minmax(0,1.8fr)_140px_90px_170px]">
                    <span>Task</span>
                    <span>Status</span>
                    <span>Subtasks</span>
                    <span>Updated</span>
                  </div>
                  <div class="board-list__rows space-y-3">${listRows}</div>
                </div>`}
        </div>
      </section>

      ${selectedTask && !useTaskModal ? `
        <aside class="board-panel board-drawer is-open ${panelClasses("fixed inset-4 z-30 p-5 xl:static xl:inset-auto xl:p-5")}" aria-label="Task drawer">
          ${renderDrawer(selectedTask, store.snapshot.epics, store.snapshot, store.isMutating)}
        </aside>
      ` : ""}
    </div>
    ${useTaskModal ? renderTaskModal(selectedTask, store.snapshot.epics, store.snapshot, store.isMutating) : ""}
  ` : epicsOverviewMarkup;

  appElement.innerHTML = `
    ${renderNotice(store.notice)}
    <div class="board-layout mx-auto flex min-h-screen w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6 xl:px-8">
      ${topbarMarkup}
      ${screen === "tasks" ? tasksWorkspaceMarkup : epicsOverviewMarkup}
      ${selectedSubtask ? renderSubtaskModal(selectedSubtask, store.isMutating) : ""}
    </div>
  `;
}

function renderError(message) {
  appElement.innerHTML = `
    <section class="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10 sm:px-6">
      <div class="${panelClasses("w-full p-8 text-center")}">
        <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-300 ring-1 ring-red-500/20">
          ${renderIcon("warning", "text-[22px]")}
        </div>
        <span class="${sectionLabelClasses()}">Board error</span>
        <h1 class="mt-2 text-3xl font-semibold tracking-tight text-[var(--board-text)]">Could not load the board snapshot</h1>
        <p class="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[var(--board-text-muted)] sm:text-base">${escapeHtml(message)}</p>
      </div>
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

  document.querySelectorAll("[data-nav-board]").forEach((button) => {
    button.addEventListener("click", () => {
      const fallbackEpicId = store.selectedEpicId || store.snapshot.epics[0]?.id || null;
      if (!fallbackEpicId) {
        return;
      }

      store.screen = "tasks";
      store.selectedEpicId = fallbackEpicId;
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

  document.querySelectorAll("[data-close-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.currentTarget !== event.target && event.currentTarget?.classList?.contains("board-task-modal-backdrop")) {
        return;
      }
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

  document.querySelector(".board-task-modal")?.addEventListener("click", (event) => {
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

  document.querySelectorAll("[data-create-subtask-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }

      const taskId = form.dataset.createSubtaskForm;
      const formData = new FormData(form);
      const input = {
        taskId,
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        status: normalizeStatus(String(formData.get("status") || "todo")),
      };

      if (!taskId || input.title.length === 0) {
        store.notice = { type: "error", message: "Subtasks need a title before they can be added." };
        renderBoard(model);
        attachInteractions(model, api);
        return;
      }

      api.createSubtask(input, (snapshot) => createSubtaskInSnapshot(snapshot, input));
    });
  });

  document.querySelectorAll("[data-delete-subtask]").forEach((button) => {
    button.addEventListener("click", () => {
      if (store.isMutating) {
        return;
      }

      const subtaskId = button.dataset.deleteSubtask;
      if (!subtaskId) {
        return;
      }

      api.deleteSubtask(subtaskId, (snapshot) => deleteSubtaskInSnapshot(snapshot, subtaskId));
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
        if (store.notice) {
          store.notice = null;
          renderBoard(model);
          attachInteractions(model, api);
        }
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
      document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
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
        <section class="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10 sm:px-6">
          <div class="${panelClasses("w-full p-8 text-center")}">
            <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--board-accent-soft)] text-[var(--board-accent)] ring-1 ring-[var(--board-border-strong)]">
              ${renderIcon("inventory_2", "text-[22px]")}
            </div>
            <span class="${sectionLabelClasses()}">Board ready</span>
            <h1 class="mt-2 text-3xl font-semibold tracking-tight text-[var(--board-text)]">No work has been published yet</h1>
            <p class="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[var(--board-text-muted)] sm:text-base">Once the board snapshot is installed into <code class="rounded-lg border border-[var(--board-border)] bg-white/[0.04] px-2 py-1 text-[var(--board-text)]">.trekoon/board</code>, epics and tasks will appear here.</p>
          </div>
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
