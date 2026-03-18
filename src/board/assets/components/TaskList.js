import {
  cx,
  escapeHtml,
  formatDate,
  hasLongTaskTitle,
  neutralChipClasses,
  renderEmptyState,
  renderStatusBadge,
  renderTaskMeta,
} from "./helpers.js";

/**
 * Render a single list-view row.
 *
 * @param {object} task
 * @param {boolean} selected
 * @returns {string}
 */
function renderListRow(task, selected) {
  const longTitle = hasLongTaskTitle(task.title);

  return `
    <button
      type="button"
      class="board-list-row ${cx(
        "w-full text-left grid gap-3 rounded-[22px] border px-4 py-3 transition duration-200 lg:grid-cols-[minmax(0,2fr)_150px_minmax(0,210px)_150px] lg:items-start",
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

/**
 * Render the full list-view HTML (header + rows).
 *
 * @param {object} props
 * @param {object[]} props.tasks
 * @param {string|null} props.selectedTaskId
 * @returns {string}
 */
function render(props) {
  const { tasks, selectedTaskId } = props;

  const rows = tasks.length === 0
    ? renderEmptyState("No matching tasks", "Nothing in this slice matches the active search and epic filters.", "/")
    : tasks.map((task) => renderListRow(task, selectedTaskId === task.id)).join("");

  return `
    <div class="board-list board-list--dense grid min-h-0 gap-4 grid-rows-[auto_1fr]">
      <div class="board-list__header hidden gap-3 px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--board-text-soft)] lg:grid lg:grid-cols-[minmax(0,2fr)_150px_minmax(0,210px)_150px]">
        <span>Task</span>
        <span>Status</span>
        <span>Workflow</span>
        <span>Updated</span>
      </div>
      <div class="board-list__rows min-h-0 space-y-3 overflow-auto pr-1 overscroll-contain">${rows}</div>
    </div>
  `;
}

/**
 * TaskList component — list view of tasks.
 */
export function createTaskList() {
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
