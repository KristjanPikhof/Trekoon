export function renderEpicsOverview(context) {
  const {
    panelClasses,
    renderEmptyState,
    renderEpicRow,
    sectionLabelClasses,
    store,
    visibleEpics,
  } = context;

  return `
    <div class="board-root board-root--epics">
      <section class="board-overview ${panelClasses("board-overview--dense p-4 sm:p-5")}" aria-label="Epics overview">
        <header class="board-section-head board-overview__header">
          <div>
            <span class="${sectionLabelClasses()}">Epics overview</span>
            <h2 class="board-overview__title">Manage high-level initiatives</h2>
            <p class="board-overview__summary">Dense scan-first rows keep long epic context readable without stretching the overview.</p>
          </div>
          <div class="board-legend board-overview__legend">
            <span class="board-chip board-chip--neutral">${visibleEpics.length} visible epic${visibleEpics.length === 1 ? "" : "s"}</span>
            <span class="board-chip board-chip--neutral">${store.snapshot.tasks.length} total tasks</span>
            ${store.isMutating ? '<span class="board-chip board-chip--neutral">Saving…</span>' : ""}
          </div>
        </header>
        <div class="board-table board-table--epics">
          <div class="board-table__header board-table__header--epics hidden md:grid">
            <span>Epic</span>
            <span>Status</span>
            <span>Counts</span>
            <span>Updated</span>
            <span>Open</span>
          </div>
          <div class="board-table__rows board-table__rows--epics">
            ${visibleEpics.length === 0
              ? renderEmptyState("No matching epics", "Try a different search or publish more work to the board.", "/")
              : visibleEpics.map((epic) => renderEpicRow(epic)).join("")}
          </div>
        </div>
      </section>
    </div>
  `;
}
