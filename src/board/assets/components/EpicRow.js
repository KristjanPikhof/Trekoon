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
  const statusLabel = String(epic.status ?? "todo").replace(/_/g, " ");
  const openLabel = `Open epic ${epic.title}`;

  return `
    <button
      type="button"
      class="board-epic-row ${selected ? "board-epic-row--selected" : ""}"
      aria-current="${selected}"
      aria-label="${escapeHtml(`${openLabel}. ${totalTasks} tasks. Status ${statusLabel}.`)}"
      data-open-epic="${escapeHtml(epic.id)}"
    >
      <span class="board-epic-row__summary">
        <span class="board-epic-row__title-row">
          <span class="${neutralChipClasses()}">${escapeHtml(epic.id)}</span>
          <strong class="board-epic-row__title">${escapeHtml(epic.title)}</strong>
        </span>
        ${epic.description
          ? `<span class="board-epic-row__description text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(epic.description)}</span>`
          : ""}
      </span>
      <span class="board-epic-row__status">${renderStatusBadge(epic.status ?? "todo")}</span>
      <span class="board-epic-row__counts" aria-label="Epic progress counts">
        <span class="${neutralChipClasses()}">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
        <span class="${neutralChipClasses()}">${counts.in_progress ?? 0} doing</span>
        <span class="${neutralChipClasses()}">${counts.done ?? 0} done</span>
        ${(counts.blocked ?? 0) > 0 ? `<span class="${neutralChipClasses()}">${counts.blocked} blocked</span>` : ""}
      </span>
      <span class="board-epic-row__updated">
        <span class="board-epic-row__label">Updated</span>
        <span>${escapeHtml(formatDate(epic.updatedAt))}</span>
      </span>
      <span class="board-epic-row__action-wrap" aria-hidden="true">
        <span class="board-epic-row__action">
          <span>View board</span>
          ${renderIcon("chevron_right", "text-[16px]")}
        </span>
      </span>
    </button>
  `;
}
