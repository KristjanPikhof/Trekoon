export function renderWorkspaceHeader(context) {
  const {
    escapeHtml,
    fieldClasses,
    neutralChipClasses,
    renderEpicCountSummary,
    renderIcon,
    sectionLabelClasses,
    selectedEpic,
    snapshotEpics,
    store,
    visibleTasks,
  } = context;

  const description = selectedEpic.description?.trim() || "No epic description yet.";

  return `
    <header class="board-section-head board-section-head--workspace board-workspace-header">
      <div class="board-workspace-header__intro">
        <div class="board-workspace-header__title-block">
          <span class="${sectionLabelClasses()}">Selected epic</span>
          <div class="board-workspace-header__title-row">
            <h2>${escapeHtml(selectedEpic.title)}</h2>
            ${renderStatusBadge(selectedEpic.status)}
          </div>
        </div>
        <details class="board-workspace-header__details">
          <summary>
            ${renderIcon("subject", "text-[18px]")}
            <span>Epic notes</span>
          </summary>
          <p>${escapeHtml(description)}</p>
        </details>
      </div>

      <div class="board-workspace__toolbar board-workspace-header__toolbar">
        <label class="board-select grid gap-2 xl:min-w-[240px]" aria-label="Choose epic">
          <span class="${sectionLabelClasses()}">Epic</span>
          <select class="${fieldClasses()}" id="board-epic-select">
            ${snapshotEpics.map((epic) => `
              <option value="${escapeHtml(epic.id)}" ${store.selectedEpicId === epic.id ? "selected" : ""}>
                ${escapeHtml(epic.title)}
              </option>
            `).join("")}
          </select>
        </label>
        <div class="board-workspace-header__controls">
          <div class="board-tabs inline-flex rounded-2xl border border-[var(--board-border)] bg-white/[0.03] p-1" role="tablist" aria-label="Board views">
            ${store.viewModes.map((view) => `<button class="${view.classes}" type="button" role="tab" aria-selected="${view.active}" data-view="${view.id}">${renderIcon(view.icon, "text-[18px]")} ${view.label}</button>`).join("")}
          </div>
          <div class="board-legend board-workspace-header__legend">
            ${renderEpicCountSummary(selectedEpic)}
            <span class="${neutralChipClasses()}">${visibleTasks.length} visible</span>
            ${store.view === "kanban" ? `<span class="${neutralChipClasses()}">Drag to move</span>` : ""}
            ${store.isMutating ? `<span class="${neutralChipClasses()}">Saving…</span>` : ""}
          </div>
        </div>
      </div>
    </header>
  `;
}
