export function renderEpicRow(context) {
  const {
    epic,
    escapeHtml,
    formatDate,
    neutralChipClasses,
    renderClampedText,
    renderIcon,
    renderStatusBadge,
    selected,
  } = context;

  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  const counts = epic.counts || { blocked: 0, done: 0, in_progress: 0 };

  return `
    <article
      class="board-epic-row ${selected ? "board-epic-row--selected" : ""}"
      aria-current="${selected}"
    >
      <div class="board-epic-row__summary">
        <div class="board-epic-row__title-row">
          <span class="${neutralChipClasses()}">${escapeHtml(epic.id)}</span>
          <button
            type="button"
            class="board-epic-row__title-button"
            data-open-epic="${escapeHtml(epic.id)}"
          >
            <strong>${escapeHtml(epic.title)}</strong>
          </button>
        </div>
        ${renderClampedText({
          buttonLabel: `${epic.title} description`,
          className: "board-epic-row__description text-sm leading-6 text-[var(--board-text-muted)]",
          escapeHtml,
          lineClamp: 2,
          renderIcon,
          text: epic.description,
        })}
      </div>
      <div class="board-epic-row__status">${renderStatusBadge(epic.status ?? "todo")}</div>
      <div class="board-epic-row__counts" aria-label="Epic progress counts">
        <span class="${neutralChipClasses()}">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
        <span class="${neutralChipClasses()}">${counts.in_progress ?? 0} doing</span>
        <span class="${neutralChipClasses()}">${counts.done ?? 0} done</span>
        ${(counts.blocked ?? 0) > 0 ? `<span class="${neutralChipClasses()}">${counts.blocked} blocked</span>` : ""}
      </div>
      <div class="board-epic-row__updated">
        <span class="board-epic-row__label">Updated</span>
        <span>${escapeHtml(formatDate(epic.updatedAt))}</span>
      </div>
      <div class="board-epic-row__action-wrap">
        <button
          type="button"
          class="board-epic-row__action"
          data-open-epic="${escapeHtml(epic.id)}"
        >
          <span>Open</span>
          ${renderIcon("chevron_right", "text-[16px]")}
        </button>
      </div>
    </article>
  `;
}
