import { createBoardActions } from "./state/actions.js";
import { createApi } from "./state/api.js";
import { renderBoardTopbar } from "./components/BoardTopbar.js";
import { renderClampedText } from "./components/ClampedText.js";
import { renderEpicRow as renderEpicOverviewRow } from "./components/EpicRow.js";
import { renderEpicsOverview } from "./components/EpicsOverview.js";
import { renderWorkspaceHeader } from "./components/WorkspaceHeader.js";
import { applyTheme, createStore, readThemePreference, VIEW_MODES, STATUS_ORDER } from "./state/store.js";
import {
  createScrollAuthorityStack,
  resolveFocusSelector,
  resolveScrollAuthorityStack,
  restoreRuntimeState,
  SCROLL_AUTHORITY,
  syncOverlayScrollLock,
  syncScrollAuthority,
} from "./utils/dom.js";

const SESSION_TOKEN_STORAGE_KEY = "trekoon-board-session-token";
const SEARCH_FOCUS_KEYS = new Set(["/", "s"]);
const STATUS_LABELS = {
  todo: "Todo",
  blocked: "Blocked",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_BADGE_STYLES = {
  todo: "border-white/10 bg-white/[0.05] text-[var(--board-text-muted)]",
  blocked: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  in_progress: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  done: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  default: "border-[var(--board-border)] bg-white/[0.04] text-[var(--board-text-muted)]",
};

const ACTIVE_EPIC_STATUSES = new Set(["in_progress", "todo"]);
const SIDEBAR_EPIC_STATUS_PRIORITY = {
  in_progress: 0,
  todo: 1,
  blocked: 2,
  done: 3,
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

function isCompactViewport() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)")?.matches;
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

function statusBadgeClasses(status) {
  return cx(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
    STATUS_BADGE_STYLES[normalizeStatus(status)] ?? STATUS_BADGE_STYLES.default,
  );
}

function renderStatusBadge(rawStatus, label = readStatusLabel(rawStatus)) {
  return `<span class="${statusBadgeClasses(rawStatus)}">${escapeHtml(label)}</span>`;
}

let appElement = null;
const scrollAuthorityStack = createScrollAuthorityStack();
let searchReturnFocusState = null;

function resolveTaskDetailOwner(boardState, useTaskModal) {
  if (!boardState?.selectedTask) {
    return null;
  }

  return useTaskModal ? SCROLL_AUTHORITY.taskModal : SCROLL_AUTHORITY.inspector;
}

function rememberReturnFocus(owner, element) {
  if (!owner || !(element instanceof HTMLElement)) {
    return;
  }

  scrollAuthorityStack.rememberReturnFocus(owner, resolveFocusSelector(element));
}

function closeTopmostDisclosure(boardState, activeElement = document.activeElement) {
  const disclosureRoot = boardState?.selectedSubtaskId
    ? document.querySelector(".board-modal")
    : boardState?.selectedTaskId
      ? document.querySelector(".board-drawer, .board-task-modal")
      : document;

  if (!(disclosureRoot instanceof ParentNode)) {
    return false;
  }

  const openDisclosures = Array.from(disclosureRoot.querySelectorAll("details[open]"))
    .filter((disclosure) => disclosure instanceof HTMLDetailsElement);
  if (openDisclosures.length === 0) {
    return false;
  }

  let candidate = null;
  if (activeElement instanceof HTMLElement) {
    candidate = activeElement.closest("details[open]");
    if (candidate && !openDisclosures.includes(candidate)) {
      candidate = null;
    }
  }

  if (!(candidate instanceof HTMLDetailsElement)) {
    candidate = openDisclosures
      .map((disclosure, index) => ({
        disclosure,
        index,
        depth: disclosure.closest("details[open] details[open]") ? disclosure.parents?.length ?? 0 : 0,
      }))
      .sort((left, right) => {
        const leftDepth = left.disclosure.querySelectorAll("details[open]").length;
        const rightDepth = right.disclosure.querySelectorAll("details[open]").length;
        if (leftDepth !== rightDepth) {
          return rightDepth - leftDepth;
        }
        return right.index - left.index;
      })[0]?.disclosure ?? null;
  }

  if (!(candidate instanceof HTMLDetailsElement)) {
    return false;
  }

  candidate.open = false;
  candidate.querySelector(":scope > summary")?.focus({ preventScroll: true });
  return true;
}

function focusSearch(activeElement = document.activeElement) {
  if (activeElement instanceof HTMLElement && activeElement.id !== "board-search-input") {
    searchReturnFocusState = resolveFocusSelector(activeElement);
  }

  document.querySelector("#board-search-input")?.focus({ preventScroll: true });
}

function dismissSearch(boardState, activeElement = document.activeElement) {
  if (activeElement?.id !== "board-search-input") {
    return false;
  }

  restoreRuntimeState(appElement, {
    owner: boardState?.screen === "tasks" ? SCROLL_AUTHORITY.workspace : SCROLL_AUTHORITY.page,
    scrollState: [],
    fallbackTaskId: boardState?.selectedTaskId ?? null,
    fallbackEpicId: boardState?.selectedEpicId ?? null,
    returnFocusState: searchReturnFocusState,
    fallbackFocusSelectors: [
      "[data-nav-board]:not([disabled])",
      "[data-nav='epics']",
      "#board-epic-select",
      "[data-open-epic]",
    ],
  });
  searchReturnFocusState = null;
  return true;
}

function focusTaskDetail() {
  document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

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

function renderDescriptionBody(description, className = "text-sm leading-7 text-[var(--board-text-muted)]") {
  if (!description || description.trim().length === 0) {
    return `<p class="${escapeHtml(className)}">No description provided.</p>`;
  }

  return `<div class="${escapeHtml(className)}">${escapeHtml(description).replaceAll("\n", "<br />")}</div>`;
}

function shouldCollapseDescription(description) {
  if (!description) {
    return false;
  }

  const trimmed = description.trim();
  return trimmed.length > 260 || trimmed.split("\n").length > 5;
}

function renderDescriptionSection(title, description, options = {}) {
  const {
    open = false,
    compact = false,
    emptyText = "Add context so collaborators know what done looks like.",
  } = options;

  if (!description || description.trim().length === 0) {
    return `
      <section class="${secondaryPanelClasses("board-detail-card p-4")}">
        <div class="board-section__header flex items-center justify-between gap-3">
          <strong class="text-sm font-semibold text-[var(--board-text)]">${escapeHtml(title)}</strong>
          <span class="${neutralChipClasses()}">Empty</span>
        </div>
        <p class="mt-3 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(emptyText)}</p>
      </section>
    `;
  }

  if (!shouldCollapseDescription(description)) {
    return `
      <section class="${secondaryPanelClasses("board-detail-card p-4")}">
        <div class="board-section__header flex items-center justify-between gap-3">
          <strong class="text-sm font-semibold text-[var(--board-text)]">${escapeHtml(title)}</strong>
          <span class="${neutralChipClasses()}">${escapeHtml(`${description.trim().length} chars`)}</span>
        </div>
        <div class="mt-3 ${compact ? "board-detail-copy board-detail-copy--compact" : "board-detail-copy"}">
          ${renderDescriptionBody(description)}
        </div>
      </section>
    `;
  }

  return `
    <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" ${open ? "open" : ""}>
      <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
        <span>${escapeHtml(title)}</span>
        <span class="${neutralChipClasses()}">Long</span>
      </summary>
      <div class="mt-3 board-detail-copy ${compact ? "board-detail-copy--compact" : ""}">
        ${renderDescriptionBody(description)}
      </div>
    </details>
  `;
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

function compareEpicsForSidebar(leftEpic, rightEpic) {
  const leftStatus = normalizeStatus(leftEpic.status);
  const rightStatus = normalizeStatus(rightEpic.status);
  const statusDelta = (SIDEBAR_EPIC_STATUS_PRIORITY[leftStatus] ?? Number.MAX_SAFE_INTEGER)
    - (SIDEBAR_EPIC_STATUS_PRIORITY[rightStatus] ?? Number.MAX_SAFE_INTEGER);

  if (statusDelta !== 0) {
    return statusDelta;
  }

  const updatedDelta = Number(rightEpic.updatedAt ?? 0) - Number(leftEpic.updatedAt ?? 0);
  if (updatedDelta !== 0) {
    return updatedDelta;
  }

  return leftEpic.title.localeCompare(rightEpic.title);
}

function getSidebarEpics(epics, search) {
  const query = search.trim().toLowerCase();
  const visibleEpics = query.length === 0
    ? epics.filter((epic) => ACTIVE_EPIC_STATUSES.has(normalizeStatus(epic.status)))
    : epics.filter((epic) => epic.searchText.includes(query));

  return [...visibleEpics].sort(compareEpicsForSidebar);
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
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${renderStatusBadge(epic.status)}
            <span class="text-xs text-[var(--board-text-soft)]">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>
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

function hasLongTaskTitle(title) {
  if (!title) {
    return false;
  }

  const trimmed = title.trim();
  return trimmed.length > 72 || trimmed.split("\n").length > 2;
}

function renderTaskTextDisclosure(description, options = {}) {
  const {
    buttonLabel = "task description",
    className = "",
    lineClamp = 2,
  } = options;

  if (!description || description.trim().length === 0) {
    return "";
  }

  return renderClampedText({
    buttonLabel,
    className,
    escapeHtml,
    lineClamp,
    renderIcon,
    text: description,
  });
}

function renderTaskCard(task, selected, isMutating = false) {
  const longTitle = hasLongTaskTitle(task.title);

  return `
    <article
      class="board-task-card ${cx(
        "rounded-[22px] border p-3.5 transition duration-200 lg:p-4",
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
      <div class="board-task-card__header flex items-start justify-between gap-3">
        <div class="flex min-w-0 flex-wrap items-center gap-2">
          ${renderStatusBadge(task.status)}
          <span class="board-task-card__eyebrow text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--board-text-soft)]">${escapeHtml(formatDate(task.updatedAt))}</span>
        </div>
        ${longTitle ? `<span class="board-task-card__cue ${neutralChipClasses()}">Open for full title</span>` : ""}
      </div>
      <div class="board-task-card__body mt-3 grid gap-3">
        <strong class="board-task-card__title block text-sm font-semibold leading-5 text-[var(--board-text)] sm:text-[0.95rem]">${escapeHtml(task.title)}</strong>
        ${renderTaskTextDisclosure(task.description, {
          buttonLabel: "task description",
          className: "board-task-card__description text-sm leading-5 text-[var(--board-text-muted)]",
          lineClamp: 2,
        })}
      </div>
      <div class="board-task-card__footer mt-3 flex flex-wrap items-center gap-2.5">${renderTaskMeta(task)}</div>
    </article>
  `;
}

function renderListRow(task, selected) {
  const longTitle = hasLongTaskTitle(task.title);

  return `
    <article
      class="board-list-row ${cx(
        "grid gap-3 rounded-[22px] border px-4 py-3 transition duration-200 lg:grid-cols-[minmax(0,2fr)_150px_minmax(0,210px)_110px] lg:items-start",
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
        <div class="board-list-row__summary-head flex min-w-0 flex-wrap items-start justify-between gap-2">
          <strong class="board-list-row__title block min-w-0 text-sm font-semibold text-[var(--board-text)] sm:text-[0.98rem]">${escapeHtml(task.title)}</strong>
          ${longTitle ? `<span class="board-list-row__cue ${neutralChipClasses()}">Open</span>` : ""}
        </div>
        ${renderTaskTextDisclosure(task.description, {
          buttonLabel: "task row description",
          className: "board-list-row__description mt-2 text-sm leading-5 text-[var(--board-text-muted)]",
          lineClamp: 2,
        })}
      </div>
      <div class="board-list-row__status">${renderStatusBadge(task.status)}</div>
      <div class="board-list-row__meta flex min-w-0 flex-wrap gap-2">${renderTaskMeta(task)}</div>
      <span class="board-list-row__updated text-sm text-[var(--board-text-muted)]">${escapeHtml(formatDate(task.updatedAt))}</span>
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

function renderDependencyItems(task, snapshot, isMutating = false, dependencyIds = task.blockedBy) {
  if (dependencyIds.length === 0) {
    return renderEmptyState("No dependencies", "Add blockers here to keep task transitions honest.");
  }

  return dependencyIds.map((dependencyId) => {
    const dependency = lookupNode(snapshot, dependencyId);
    return `
      <article class="board-related-item grid gap-3 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div class="min-w-0">
          <strong class="block text-sm font-semibold text-[var(--board-text)]">${escapeHtml(readNodeLabel(dependency?.kind ?? "task", dependency?.title ?? dependencyId))}</strong>
          ${renderDescriptionPreview(dependency?.description ?? "", "board-related-item__description mt-2 text-sm leading-6 text-[var(--board-text-muted)]")}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${renderStatusBadge(dependency?.status ?? "todo", readStatusLabel(dependency?.status ?? "Unknown"))}
          <button type="button" class="${buttonClasses()}" data-remove-dependency-source="${escapeHtml(task.id)}" data-remove-dependency-target="${escapeHtml(dependencyId)}" ${isMutating ? "disabled" : ""}>Remove</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderDependencySection(task, snapshot, isMutating = false) {
  const visibleDependencies = task.blockedBy.slice(0, 3);
  const hiddenDependencies = task.blockedBy.slice(3);
  return `
    <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" ${task.blockedBy.length <= 2 ? "open" : ""}>
      <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
        <span>Dependencies</span>
        <span class="${neutralChipClasses()}">${task.blockedBy.length}</span>
      </summary>
      <form class="mt-4 grid gap-4" data-dependency-form="${escapeHtml(task.id)}">
        <label class="grid gap-2">
          <span class="${sectionLabelClasses()}">Add dependency</span>
          <select class="${fieldClasses()}" name="dependsOnId" required ${isMutating ? "disabled" : ""}>
            <option value="">Select a task or subtask</option>
            ${renderDependencyOptions(task, snapshot)}
          </select>
        </label>
        <div class="flex justify-end">
          <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Add dependency</button>
        </div>
      </form>
      <div class="board-inline-list mt-4 space-y-3">
        ${renderDependencyItems(task, snapshot, isMutating, visibleDependencies)}
      </div>
      ${hiddenDependencies.length > 0 ? `
          <details class="board-disclosure board-detail-nested mt-4 ${secondaryPanelClasses("p-3")}">
            <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Show ${hiddenDependencies.length} more ${hiddenDependencies.length === 1 ? "dependency" : "dependencies"}</summary>
          <div class="board-inline-list mt-3 space-y-3">
            ${renderDependencyItems(task, snapshot, isMutating, hiddenDependencies)}
          </div>
        </details>
      ` : ""}
    </details>
  `;
}

function renderSubtaskItems(subtasks) {
  if (subtasks.length === 0) {
    return renderEmptyState("No subtasks", "This task does not have subtasks in the current snapshot.");
  }

  return `
    <div class="space-y-3">
      ${subtasks.map((subtask) => `
        <article class="board-related-item grid gap-3 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div class="min-w-0">
            <strong class="block text-sm font-semibold text-[var(--board-text)]">${escapeHtml(subtask.title)}</strong>
            ${renderDescriptionPreview(subtask.description, "board-related-item__description mt-2 text-sm leading-6 text-[var(--board-text-muted)]")}
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

function renderSubtaskSection(task, isMutating = false) {
  const visibleSubtasks = task.subtasks.slice(0, 4);
  const hiddenSubtasks = task.subtasks.slice(4);
  const shouldOpen = task.subtasks.length <= 3;
  return `
    <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" ${shouldOpen ? "open" : ""}>
      <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
        <span>Subtasks</span>
        <span class="${neutralChipClasses()}">${task.subtasks.length}</span>
      </summary>
      <div class="mt-4 space-y-4">
        <details class="board-disclosure board-detail-nested ${secondaryPanelClasses("p-3")}" ${task.subtasks.length === 0 ? "open" : ""}>
          <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Add subtask</summary>
          <div class="mt-3">
            ${renderCreateSubtaskForm(task, isMutating)}
          </div>
        </details>
        ${renderSubtaskItems(visibleSubtasks)}
        ${hiddenSubtasks.length > 0 ? `
          <details class="board-disclosure board-detail-nested ${secondaryPanelClasses("p-3")}">
            <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Show ${hiddenSubtasks.length} more subtask${hiddenSubtasks.length === 1 ? "" : "s"}</summary>
            <div class="mt-3">
              ${renderSubtaskItems(hiddenSubtasks)}
            </div>
          </details>
        ` : ""}
      </div>
    </details>
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
      <section class="board-modal board-modal--sheet ${panelClasses("grid max-h-[calc(100dvh-2rem)] w-full grid-rows-[auto_1fr] overflow-hidden p-5 sm:p-6")}" role="dialog" aria-modal="true" aria-labelledby="board-subtask-modal-title">
        <header class="board-modal__header board-detail-surface__header border-b border-[var(--board-border)] pb-5">
          <div>
            <span class="${sectionLabelClasses()}">Subtask editor</span>
            <h3 id="board-subtask-modal-title" class="mt-2 text-xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(subtask.title)}</h3>
            <p class="mt-2 text-sm text-[var(--board-text-muted)]">Focused editing surface with its own scroll and sticky close action.</p>
          </div>
          <button type="button" class="${buttonClasses()} mt-4 sm:mt-0" data-close-subtask>Close</button>
        </header>
        <div class="board-modal__body board-detail-surface__body min-h-0 pt-5" data-scroll-surface="subtask-modal">
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

function renderTaskSurface(task, epics, snapshot, isMutating = false, options = {}) {
  const epic = epics.find((candidate) => candidate.id === task.epicId) ?? null;
  const {
    titleId = "",
    closeLabel = "Close",
    containerClassName = "board-detail-surface",
    detailEyebrow = "Task detail",
    scrollSurface = "inspector",
  } = options;

  return `
    <div class="${containerClassName} grid h-full min-h-0 grid-rows-[auto_1fr] overflow-hidden">
      <header class="board-detail-surface__header board-drawer__header border-b border-[var(--board-border)] pb-5">
        <div class="board-detail-surface__hero flex flex-col gap-4">
            <div class="board-detail-surface__title-row flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div class="min-w-0">
                <span class="${sectionLabelClasses()}">${escapeHtml(detailEyebrow)}</span>
                <h3 ${titleId ? `id="${escapeHtml(titleId)}"` : ""} class="mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(task.title)}</h3>
                <p class="board-detail-surface__context mt-2 text-sm text-[var(--board-text-muted)]">One dominant task surface with sticky context, close, and constrained internal scrolling.</p>
              </div>
            <button type="button" class="${buttonClasses()} shrink-0" data-close-task>${escapeHtml(closeLabel)}</button>
          </div>
          <div class="board-detail-surface__meta flex flex-wrap gap-2">
            <span class="${neutralChipClasses()}">Epic ${escapeHtml(epic?.title ?? "Unknown")}</span>
            ${renderStatusBadge(task.status)}
            <span class="${neutralChipClasses()}">${task.subtasks.length} subtask${task.subtasks.length === 1 ? "" : "s"}</span>
            <span class="${neutralChipClasses()}">${task.blockedBy.length} blocker${task.blockedBy.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </header>
      <div class="board-detail-surface__body board-drawer__body min-h-0 overscroll-contain pt-5 pr-1" data-scroll-surface="${escapeHtml(scrollSurface)}">
        <div class="board-detail-surface__stack space-y-4">
          <section class="${secondaryPanelClasses("board-detail-card p-4")}">
            <div class="board-detail-summary-grid grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div>
                <p class="${sectionLabelClasses()}">Updated</p>
                <p class="mt-2 text-sm font-medium text-[var(--board-text)]">${escapeHtml(formatDate(task.updatedAt))}</p>
              </div>
              <div>
                <p class="${sectionLabelClasses()}">Dependencies</p>
                <p class="mt-2 text-sm font-medium text-[var(--board-text)]">${task.blockedBy.length} blocking item${task.blockedBy.length === 1 ? "" : "s"}</p>
              </div>
              <div>
                <p class="${sectionLabelClasses()}">Outgoing</p>
                <p class="mt-2 text-sm font-medium text-[var(--board-text)]">${task.blocks.length} dependent item${task.blocks.length === 1 ? "" : "s"}</p>
              </div>
            </div>
          </section>
          ${renderDescriptionSection("Description", task.description, { open: false, compact: true })}
          <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" open>
            <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
              <span>Edit task</span>
              ${renderStatusBadge(task.status)}
            </summary>
            <form class="mt-4 grid gap-4" data-task-form="${escapeHtml(task.id)}">
              <label class="grid gap-2">
                <span class="${sectionLabelClasses()}">Title</span>
                <input class="${fieldClasses()}" name="title" value="${escapeHtml(task.title)}" required ${isMutating ? "disabled" : ""} />
              </label>
              <label class="grid gap-2">
                <span class="${sectionLabelClasses()}">Description</span>
                <textarea class="${fieldClasses()} min-h-[180px]" name="description" rows="7" ${isMutating ? "disabled" : ""}>${escapeHtml(task.description)}</textarea>
              </label>
              <label class="grid gap-2">
                <span class="${sectionLabelClasses()}">Status</span>
                ${renderStatusSelect("status", task.status, isMutating)}
              </label>
              <div class="board-detail-surface__actions flex flex-wrap justify-end gap-3">
                <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Save task</button>
              </div>
            </form>
          </details>
          ${renderDependencySection(task, snapshot, isMutating)}
          ${renderSubtaskSection(task, isMutating)}
        </div>
      </div>
    </div>
  `;
}

function renderTaskModal(task, epics, snapshot, isMutating = false) {
  const compactViewport = isCompactViewport();
  return `
    <div class="board-task-modal-backdrop fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-md" data-close-task>
      <section class="board-task-modal ${panelClasses("grid max-h-[calc(100dvh-2rem)] w-full grid-rows-[1fr] overflow-hidden p-5 sm:p-6")}" role="dialog" aria-modal="true" aria-labelledby="board-task-modal-title">
        <div class="h-full min-h-0 overflow-hidden">
          ${renderTaskSurface(task, epics, snapshot, isMutating, {
            titleId: "board-task-modal-title",
            closeLabel: compactViewport ? "Back to board" : "Close",
            containerClassName: "board-detail-surface board-detail-surface--modal",
            detailEyebrow: compactViewport ? "Task focus mode" : "Task detail",
            scrollSurface: "task-modal",
          })}
        </div>
      </section>
    </div>
  `;
}

function renderBoard(model) {
  const { store, getBoardState } = model;
  const boardState = getBoardState();
  const visibleEpics = boardState.visibleEpics;
  const sidebarEpics = getSidebarEpics(store.snapshot.epics, store.search);
  const visibleTasks = boardState.visibleTasks;
  const selectedEpic = boardState.selectedEpic;
  const selectedTask = boardState.selectedTask;
  const selectedSubtask = boardState.selectedSubtask;
  const screen = boardState.screen;
  const compactViewport = isCompactViewport();
  const useTaskModal = Boolean(selectedTask && (store.view === "kanban" || compactViewport));
  const currentNav = selectedTask ? "detail" : screen === "tasks" ? "board" : "epics";
  const primarySurfaceLabel = currentNav === "detail"
    ? "Detail"
    : screen === "tasks"
      ? "Board"
      : "Epics";
  const ownerStack = resolveScrollAuthorityStack(boardState, { useTaskModal });

  const columnsMarkup = STATUS_ORDER.map((status) => {
    const columnTasks = visibleTasks.filter((task) => task.status === status);
    const columnTitle = readStatusLabel(status);
    const content = columnTasks.length === 0
      ? renderEmptyState(`No ${columnTitle.toLowerCase()} work`, "Adjust search or switch epics to inspect more tasks.")
      : columnTasks
          .map((task) => renderTaskCard(task, selectedTask?.id === task.id, store.isMutating))
          .join("");

    return `
      <section class="board-column board-column--dense ${secondaryPanelClasses("flex min-h-[20rem] min-w-0 flex-col p-3")}" aria-labelledby="column-${status}">
        <header class="board-column__header flex items-start justify-between gap-3 border-b border-[var(--board-border)] pb-3">
          <div class="min-w-0">
            <p class="${sectionLabelClasses()}">${escapeHtml(columnTitle)}</p>
            <div class="mt-2 flex flex-wrap items-center gap-2">
              ${renderStatusBadge(status)}
              <span class="${neutralChipClasses()}">${columnTasks.length} item${columnTasks.length === 1 ? "" : "s"}</span>
            </div>
          </div>
          ${columnTasks.length > 0 ? `<span class="board-column__count text-xs font-medium text-[var(--board-text-soft)]">${columnTasks.length === 1 ? "1 task" : `${columnTasks.length} tasks`}</span>` : ""}
        </header>
        <div class="board-column__tasks mt-3 grid min-h-0 flex-1 content-start gap-2.5 overflow-auto pr-1 overscroll-contain" id="column-${status}" data-drop-status="${escapeHtml(status)}">${content}</div>
      </section>
    `;
  }).join("");

  const listRows = visibleTasks.length === 0
    ? renderEmptyState("No matching tasks", "Nothing in this slice matches the active search and epic filters.", "/")
    : visibleTasks.map((task) => renderListRow(task, selectedTask?.id === task.id)).join("");
  const workspaceLayoutClass = selectedTask && !useTaskModal
    ? "board-root--tasks board-root--detail board-root--detail-open"
    : "board-root--tasks";

  const topbarMarkup = renderBoardTopbar({
    buttonClasses,
    currentNav,
    escapeHtml,
    isCompactViewport: compactViewport,
    neutralChipClasses,
    renderIcon,
    screen,
    search: store.search,
    searchScope: boardState.searchScope,
    sectionLabelClasses,
    selectedEpic,
    theme: store.theme,
  });

  const epicsOverviewMarkup = renderEpicsOverview({
    panelClasses,
    renderEmptyState,
      renderEpicRow: (epic) => renderEpicOverviewRow({
      epic,
      escapeHtml,
      formatDate,
      neutralChipClasses,
      renderClampedText,
      renderIcon,
      renderStatusBadge,
        selected: boardState.selectedEpicId === epic.id,
      }),
    sectionLabelClasses,
    store,
    visibleEpics,
  });

  const tasksWorkspaceMarkup = selectedEpic ? `
    <div class="board-root ${workspaceLayoutClass} ${selectedTask && !useTaskModal ? "has-detail" : ""} h-full flex-1 min-h-0 grid gap-4 xl:gap-5" data-scroll-surface="workspace">
      <aside class="board-sidebar ${panelClasses("hidden h-full min-h-0 overflow-hidden p-4 xl:grid xl:grid-rows-[auto_1fr]")}" aria-label="Epic switcher">
        <header class="board-sidebar__header border-b border-[var(--board-border)] pb-4">
          <span class="${sectionLabelClasses()}">Epics</span>
          <h2 class="mt-2 text-lg font-semibold tracking-tight text-[var(--board-text)]">Switch epic</h2>
          <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">Showing active epics first: in progress, then todo.</p>
        </header>
        <div class="board-sidebar__list mt-4 grid min-h-0 content-start gap-2.5 overflow-auto pr-1 overscroll-contain">
          ${sidebarEpics.length === 0
            ? renderEmptyState("No active epics", "Todo and in-progress epics will appear here for quick switching.")
            : sidebarEpics.map((epic) => renderEpicSidebarItem(epic, boardState.selectedEpicId === epic.id)).join("")}
        </div>
      </aside>

      <section class="board-workspace ${panelClasses("grid h-full min-h-0 min-w-0 grid-rows-[auto_1fr] overflow-hidden p-5 sm:p-6")}" aria-label="Workspace">
        ${renderWorkspaceHeader({
          escapeHtml,
          fieldClasses,
          isCompactViewport: compactViewport,
          neutralChipClasses,
          primarySurfaceLabel,
          renderEpicCountSummary,
          renderIcon,
          renderStatusBadge,
            sectionLabelClasses,
            searchScope: boardState.searchScope,
            selectedEpic,
            snapshotEpics: store.snapshot.epics,
            store: {
              isMutating: store.isMutating,
              selectedEpicId: boardState.selectedEpicId,
              view: store.view,
            viewModes: VIEW_MODES.map((view) => ({
              active: store.view === view,
              classes: cx(
                "rounded-2xl px-4 py-2 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
                store.view === view ? "bg-[var(--board-accent-soft)] text-[var(--board-text)] shadow-[inset_0_0_0_1px_var(--board-border-strong)]" : "text-[var(--board-text-muted)] hover:text-[var(--board-text)]",
              ),
              icon: view === "kanban" ? "view_kanban" : "list",
              id: view,
              label: view === "kanban" ? "Kanban" : "Rows",
            })),
          },
          visibleTasks,
        })}

        <div class="board-content mt-6 h-full min-h-0 min-w-0 overflow-hidden">
          ${store.view === "kanban"
            ? `<div class="board-kanban board-kanban--dense h-full min-h-0 min-w-0 overflow-y-auto pr-1">${columnsMarkup}</div>`
            : `
                <div class="board-list board-list--dense grid h-full min-h-0 gap-4 grid-rows-[auto_1fr]">
                  <div class="board-list__header hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--board-text-soft)] lg:grid lg:grid-cols-[minmax(0,2fr)_150px_minmax(0,210px)_110px]">
                    <span>Task</span>
                    <span>Status</span>
                    <span>Workflow</span>
                    <span>Updated</span>
                  </div>
                  <div class="board-list__rows min-h-0 space-y-3 overflow-auto pr-1 overscroll-contain">${listRows}</div>
                </div>`}
        </div>
      </section>

      ${selectedTask && !useTaskModal ? `
        <aside class="board-panel board-drawer board-detail-surface-frame is-open ${panelClasses("fixed inset-4 z-30 grid h-full min-h-0 overflow-hidden p-5 xl:static xl:inset-auto xl:max-h-full xl:p-5")}" aria-label="Task inspector">
          ${renderTaskSurface(selectedTask, store.snapshot.epics, store.snapshot, store.isMutating, {
            closeLabel: "Close inspector",
            containerClassName: "board-detail-surface board-detail-surface--inspector",
            detailEyebrow: "Task inspector",
            scrollSurface: "inspector",
          })}
        </aside>
      ` : ""}
    </div>
    ${useTaskModal ? renderTaskModal(selectedTask, store.snapshot.epics, store.snapshot, store.isMutating) : ""}
  ` : epicsOverviewMarkup;

  appElement.innerHTML = `
    ${renderNotice(store.notice)}
    <div class="board-layout ${screen === "tasks" ? "board-layout--workspace" : "board-layout--overview"} mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6 xl:px-8 ${screen === "tasks" ? "h-[100dvh]" : "min-h-screen"}" data-scroll-surface="page">
      ${topbarMarkup}
      ${screen === "tasks" ? tasksWorkspaceMarkup : epicsOverviewMarkup}
      ${selectedSubtask ? renderSubtaskModal(selectedSubtask, store.isMutating) : ""}
    </div>
  `;

  syncScrollAuthority(appElement.querySelector(".board-layout"), ownerStack);
  syncOverlayScrollLock(Boolean(useTaskModal || selectedSubtask));
  return { ownerStack };
}

function renderError(message) {
  syncOverlayScrollLock(false);
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

function attachInteractions(model, api, rerender) {
  const { store, getBoardState } = model;
  const actions = createBoardActions({
    model,
    api,
    rerender,
    normalizeSnapshot,
    normalizeStatus,
    applyTheme,
    closeTopmostDisclosure,
    dismissSearch,
    focusSearch,
    focusTaskDetail,
    searchFocusKeys: SEARCH_FOCUS_KEYS,
  });

  document.querySelector("[data-action='toggle-theme']")?.addEventListener("click", () => {
    actions.toggleTheme();
  });

  document.querySelector("#board-search-input")?.addEventListener("input", (event) => {
    actions.updateSearch(event.target.value);
  });

  document.querySelectorAll("[data-open-epic]").forEach((button) => {
    button.addEventListener("click", () => {
      actions.openEpic(button.dataset.openEpic || null);
    });
  });

  document.querySelector("#board-epic-select")?.addEventListener("change", (event) => {
    actions.selectEpic(event.target.value || null);
  });

  document.querySelector("[data-nav='epics']")?.addEventListener("click", () => {
    actions.showEpics();
  });

  document.querySelectorAll("[data-nav-board]").forEach((button) => {
    button.addEventListener("click", () => {
      actions.showBoard();
    });
  });

  document.querySelectorAll("[data-nav-detail]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  });

  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      actions.setView(button.dataset.view);
    });
  });

  document.querySelectorAll("[data-task-id]").forEach((node) => {
    node.addEventListener("click", () => {
      rememberReturnFocus(SCROLL_AUTHORITY.workspace, node);
      actions.selectTask(node.dataset.taskId);
    });
  });

  document.querySelectorAll(".board-task-card [data-clamped-text], .board-list-row [data-clamped-text]").forEach((node) => {
    node.addEventListener("click", (event) => {
      event.stopPropagation();
    });
  });

  document.querySelectorAll("[data-close-task]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.currentTarget !== event.target && event.currentTarget?.classList?.contains("board-task-modal-backdrop")) {
        return;
      }
      actions.closeTask();
    });
  });

  document.querySelectorAll("[data-open-subtask]").forEach((button) => {
    button.addEventListener("click", () => {
      const boardState = getBoardState();
      rememberReturnFocus(resolveTaskDetailOwner(boardState, store.view === "kanban"), button);
      actions.openSubtask(button.dataset.openSubtask || null);
    });
  });

  document.querySelectorAll("[data-close-subtask]").forEach((node) => {
    node.addEventListener("click", (event) => {
      if (event.currentTarget !== event.target && event.currentTarget?.classList?.contains("board-modal-backdrop")) {
        return;
      }
      actions.closeSubtask();
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
      actions.submitTaskForm(taskId, new FormData(form));
    });
  });

  document.querySelectorAll("[data-subtask-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }
      const subtaskId = form.dataset.subtaskForm;
      actions.submitSubtaskForm(subtaskId, new FormData(form));
    });
  });

  document.querySelectorAll("[data-create-subtask-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }

      const taskId = form.dataset.createSubtaskForm;
      actions.submitCreateSubtask(taskId, new FormData(form));
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

      actions.deleteSubtask(subtaskId);
    });
  });

  document.querySelectorAll("[data-dependency-form]").forEach((form) => {
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (store.isMutating) {
        return;
      }
      const sourceId = form.dataset.dependencyForm;
      actions.addDependency(sourceId, new FormData(form));
    });
  });

  document.querySelectorAll("[data-remove-dependency-source]").forEach((button) => {
    button.addEventListener("click", () => {
      if (store.isMutating) {
        return;
      }
      const sourceId = button.dataset.removeDependencySource;
      const dependsOnId = button.dataset.removeDependencyTarget;
      actions.removeDependency(sourceId, dependsOnId);
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
      actions.dropTaskStatus(taskId, nextStatus);
    });
  });

  window.onkeydown = (event) => {
    actions.handleKeydown(event);
  };
}

export async function bootLegacyBoard(options = {}) {
  try {
    appElement = options.mountElement instanceof HTMLElement ? options.mountElement : document.querySelector("#app");
    if (!(appElement instanceof HTMLElement)) {
      throw new Error("Board runtime could not find its mount element.");
    }

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
      syncOverlayScrollLock(false);
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

    const model = createStore(snapshot, { normalizeSnapshot });
    let api = null;
    const rerender = (options = {}) => {
      if (appElement.childElementCount > 0) {
        scrollAuthorityStack.capture(appElement, model.store);
      }

      const renderState = renderBoard(model);
      attachInteractions(model, api, rerender);

      const activeRuntime = scrollAuthorityStack.transition(renderState.ownerStack);
      if (options.preserveFocus !== false) {
        restoreRuntimeState(appElement, activeRuntime);
      }
    };

    api = createApi(model, { sessionToken: runtimeSession.token, rerender });
    applyTheme(model.store.theme);
    rerender({ preserveFocus: false });
  } catch (error) {
    renderError(error instanceof Error ? error.message : String(error));
  }
}

if (window.__TREKOON_BOARD_BOOTSTRAP__ !== "main") {
  void bootLegacyBoard();
}
