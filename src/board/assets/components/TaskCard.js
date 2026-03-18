import {
  cx,
  escapeHtml,
  formatDate,
  hasLongTaskTitle,
  neutralChipClasses,
  renderStatusBadge,
  renderTaskMeta,
} from "./helpers.js";

/**
 * Render a kanban task card.
 *
 * @param {object} props
 * @param {object} props.task
 * @param {boolean} props.selected
 * @param {boolean} props.isMutating
 * @returns {string}
 */
export function renderTaskCard(props) {
  const { task, selected = false, isMutating = false } = props;
  const longTitle = hasLongTaskTitle(task.title);

  return `
    <button
      type="button"
      class="board-task-card ${cx(
        "w-full text-left rounded-[22px] border p-3.5 transition duration-200 lg:p-4",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-surface)]",
        selected
          ? "border-[var(--board-border-strong)] bg-[var(--board-accent-soft)] shadow-focus"
          : "border-[var(--board-border)] bg-[var(--board-surface-2)] shadow-[0_10px_30px_rgba(0,0,0,0.18)] hover:-translate-y-0.5 hover:border-[var(--board-border-strong)] hover:shadow-lift",
      )}"
      draggable="${isMutating ? "false" : "true"}"
      data-task-id="${escapeHtml(task.id)}"
      data-draggable-task="true"
      aria-pressed="${selected}"
      aria-label="${escapeHtml(task.title)}"
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
        ${task.description?.trim() ? `<p class="board-task-card__description text-sm leading-5 text-[var(--board-text-muted)] board-clamped-text__preview board-clamped-text__preview--2">${escapeHtml(task.description.trim())}</p>` : ""}
      </div>
      <div class="board-task-card__footer mt-3 flex flex-wrap items-center gap-2.5">${renderTaskMeta(task)}</div>
    </button>
  `;
}

/**
 * TaskCard component with mount/update/unmount lifecycle.
 */
export function createTaskCard() {
  let container = null;
  let lastHtml = null;

  return {
    mount(el) {
      container = el;
      return this;
    },
    update(props) {
      if (!container) return;
      const html = renderTaskCard(props);
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
