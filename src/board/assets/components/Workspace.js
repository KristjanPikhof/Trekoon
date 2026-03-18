import { renderTaskCard } from "./TaskCard.js";
import {
  cx,
  escapeHtml,
  fieldClasses,
  formatDate,
  hasLongTaskTitle,
  neutralChipClasses,
  panelClasses,
  readStatusLabel,
  renderEpicCountSummary,
  renderEmptyState,
  renderIcon,
  renderStatusBadge,
  renderTaskMeta,
  secondaryPanelClasses,
  sectionLabelClasses,
  STATUS_LABELS,
  STATUS_ORDER,
} from "./helpers.js";
import { VIEW_MODES } from "../state/utils.js";

// ---------------------------------------------------------------------------
// Workspace header
// ---------------------------------------------------------------------------

function renderWorkspaceHeader(props) {
  const {
    searchScope,
    selectedEpic,
    snapshotEpics,
    store,
    visibleTasks,
  } = props;

  const description = selectedEpic.description?.trim() || "";
  const inlineSelect = `${fieldClasses()} !py-1 !px-2 !text-xs !min-h-0 !rounded-xl`;

  return `
    <header class="board-workspace-header">
      <div class="board-wh__row-1">
        <h2 class="board-wh__title">${escapeHtml(selectedEpic.title)}</h2>
        <div class="board-wh__controls">
          <form class="inline-flex" data-epic-status-form="${escapeHtml(selectedEpic.id)}">
            <select class="${inlineSelect}" name="status" aria-label="Epic status">
              ${STATUS_ORDER.map(s => `<option value="${escapeHtml(s)}" ${selectedEpic.status === s ? 'selected' : ''}>${escapeHtml(STATUS_LABELS[s] ?? s)}</option>`).join('')}
            </select>
          </form>
          <span class="board-wh__sep" aria-hidden="true"></span>
          <label class="board-wh__inline-label" aria-label="Choose epic">
            <select class="${inlineSelect}" id="board-epic-select">
              ${snapshotEpics.map((epic) => `
                <option value="${escapeHtml(epic.id)}" ${store.selectedEpicId === epic.id ? "selected" : ""}>
                  ${escapeHtml(epic.title)}
                </option>
              `).join("")}
            </select>
          </label>
          <span class="board-wh__sep" aria-hidden="true"></span>
          <form class="inline-flex" data-bulk-status-form="${escapeHtml(selectedEpic.id)}">
            <select class="${inlineSelect}" name="status" aria-label="Set all tasks to status">
              <option value="">Set all\u2026</option>
              ${STATUS_ORDER.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(STATUS_LABELS[s] ?? s)}</option>`).join('')}
            </select>
          </form>
        </div>
      </div>

      <div class="board-wh__row-2">
        <div class="board-wh__meta">
          ${renderEpicCountSummary(selectedEpic)}
          <span class="${neutralChipClasses()}">${visibleTasks.length} visible</span>
          ${store.isMutating ? `<span class="${neutralChipClasses()}">Saving\u2026</span>` : ""}
        </div>
        <div class="board-wh__actions">
          ${description ? `
            <button type="button" class="board-wh__notes-btn" data-toggle-notes aria-label="Toggle epic notes">
              ${renderIcon("subject", "text-[16px]")}
              <span>Notes</span>
            </button>
          ` : ""}
          <div class="board-tabs inline-flex rounded-xl border border-[var(--board-border)] bg-white/[0.03] p-0.5" role="tablist" aria-label="Board views">
            ${store.viewModes.map((view) => {
              const icon = view.id === "kanban"
                ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 3h6v18H3V3zm8 0h6v12h-6V3zm8 0h2v8h-2V3z"/></svg>'
                : '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 4h18v2H3V4zm0 7h18v2H3v-2zm0 7h18v2H3v-2z"/></svg>';
              return `<button class="${cx(
                "rounded-[10px] px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)]",
                view.active
                  ? "bg-[var(--board-accent-soft)] text-[var(--board-text)] shadow-[inset_0_0_0_1px_var(--board-border-strong)]"
                  : "text-[var(--board-text-muted)] hover:text-[var(--board-text)]",
              )}" type="button" role="tab" aria-selected="${view.active}" data-view="${view.id}">${icon} ${view.label}</button>`;
            }).join("")}
          </div>
        </div>
      </div>

      ${description ? `
        <div class="board-wh__notes-panel" data-notes-panel hidden>
          <div class="board-wh__notes-body">${escapeHtml(description)}</div>
        </div>
      ` : ""}
    </header>
  `;
}

// ---------------------------------------------------------------------------
// Kanban columns
// ---------------------------------------------------------------------------

function renderKanbanColumns(props) {
  const { visibleTasks, selectedTaskId, isMutating } = props;

  const columnsMarkup = STATUS_ORDER.map((status) => {
    const columnTasks = visibleTasks.filter((t) => t.status === status);
    const columnTitle = readStatusLabel(status);
    const content = columnTasks.length === 0
      ? renderEmptyState(`No ${columnTitle.toLowerCase()} work`, "Adjust search or switch epics to inspect more tasks.")
      : columnTasks.map((task) => renderTaskCard({ task, selected: selectedTaskId === task.id, isMutating })).join("");

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

  return `<div class="board-kanban board-kanban--dense min-h-0 min-w-0 overflow-y-auto pr-1">${columnsMarkup}</div>`;
}

// ---------------------------------------------------------------------------
// List rows
// ---------------------------------------------------------------------------

function renderListRow(task, selected) {
  const longTitle = hasLongTaskTitle(task.title);

  return `
    <button
      type="button"
      class="board-list-row ${cx(
        "w-full text-left grid gap-3 rounded-[22px] border px-4 py-3 transition duration-200 lg:grid-cols-[minmax(0,2fr)_150px_minmax(0,210px)_110px] lg:items-start",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
        selected
          ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] shadow-focus"
          : "border-[var(--board-border)] bg-white/[0.02] hover:border-[var(--board-border-strong)] hover:bg-white/[0.04]",
      )}"
      data-task-id="${escapeHtml(task.id)}"
      aria-pressed="${selected}"
      aria-label="${escapeHtml(task.title)}"
    >
      <div class="board-list-row__summary min-w-0">
        <div class="board-list-row__summary-head flex min-w-0 flex-wrap items-start justify-between gap-2">
          <strong class="board-list-row__title block min-w-0 text-sm font-semibold text-[var(--board-text)] sm:text-[0.98rem]">${escapeHtml(task.title)}</strong>
          ${longTitle ? `<span class="board-list-row__cue ${neutralChipClasses()}">Open</span>` : ""}
        </div>
        ${task.description?.trim() ? `<p class="board-list-row__description mt-2 text-sm leading-5 text-[var(--board-text-muted)] board-clamped-text__preview board-clamped-text__preview--2">${escapeHtml(task.description.trim())}</p>` : ""}
      </div>
      <div class="board-list-row__status">${renderStatusBadge(task.status)}</div>
      <div class="board-list-row__meta flex min-w-0 flex-wrap gap-2">${renderTaskMeta(task)}</div>
      <span class="board-list-row__updated text-sm text-[var(--board-text-muted)]">${escapeHtml(formatDate(task.updatedAt))}</span>
    </button>
  `;
}

function renderListView(props) {
  const { visibleTasks, selectedTaskId } = props;

  const rows = visibleTasks.length === 0
    ? renderEmptyState("No matching tasks", "Nothing in this slice matches the active search and epic filters.", "/")
    : visibleTasks.map((task) => renderListRow(task, selectedTaskId === task.id)).join("");

  return `
    <div class="board-list board-list--dense grid min-h-0 gap-4 grid-rows-[auto_1fr]">
      <div class="board-list__header hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--board-text-soft)] lg:grid lg:grid-cols-[minmax(0,2fr)_150px_minmax(0,210px)_110px]">
        <span>Task</span>
        <span>Status</span>
        <span>Workflow</span>
        <span>Updated</span>
      </div>
      <div class="board-list__rows min-h-0 space-y-3 overflow-auto pr-1 overscroll-contain">${rows}</div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Workspace component
// ---------------------------------------------------------------------------

function render(props) {
  const {
    selectedEpic,
    selectedTask,
    searchScope,
    snapshotEpics,
    store,
    visibleTasks,
  } = props;

  const selectedTaskId = selectedTask?.id ?? null;

  const viewModes = VIEW_MODES.map((view) => ({
    active: store.view === view,
    id: view,
    label: view === "kanban" ? "Kanban" : "Rows",
  }));

  const headerMarkup = renderWorkspaceHeader({
    searchScope,
    selectedEpic,
    snapshotEpics,
    store: {
      isMutating: store.isMutating,
      selectedEpicId: selectedEpic.id,
      view: store.view,
      viewModes,
    },
    visibleTasks,
  });

  const contentMarkup = store.view === "kanban"
    ? renderKanbanColumns({ visibleTasks, selectedTaskId, isMutating: store.isMutating })
    : renderListView({ visibleTasks, selectedTaskId });

  return `
    <section class="board-workspace ${panelClasses("grid min-h-0 min-w-0 grid-rows-[auto_1fr] overflow-hidden p-5 sm:p-6")}" aria-label="Workspace">
      ${headerMarkup}
      <div class="board-content mt-4 min-h-0 min-w-0 overflow-hidden">
        ${contentMarkup}
      </div>
    </section>
  `;
}

/**
 * Workspace component — workspace header + content (kanban or list view).
 */
export function createWorkspace() {
  let container = null;
  let lastHtml = null;

  return {
    mount(el) {
      container = el;
      return this;
    },
    update(props) {
      if (!container) return;
      const html = render(props);
      if (html !== lastHtml) {
        container.innerHTML = html;
        lastHtml = html;
      }
    },
    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      lastHtml = null;
    },
  };
}
