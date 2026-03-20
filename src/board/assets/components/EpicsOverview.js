import { renderEpicRow } from "./EpicRow.js";
import {
  panelClasses,
  renderEmptyState,
  sectionLabelClasses,
} from "./helpers.js";

/**
 * Render the epics overview HTML.
 *
 * @param {object} props
 * @param {object[]} props.visibleEpics
 * @param {string|null} props.selectedEpicId
 * @param {{ snapshot: object, isMutating: boolean }} props.store
 * @returns {string}
 */
function render(props) {
  const { visibleEpics, selectedEpicId, store } = props;

  return `
    <div class="board-root board-root--epics">
      <section class="board-overview ${panelClasses("board-overview--dense p-4 sm:p-5")}" aria-label="Epics overview">
        <header class="board-section-head board-overview__header">
          <div>
            <span class="${sectionLabelClasses()}">Epics overview</span>
            <h2 class="board-overview__title">Open an initiative and drive the next move</h2>
            <p class="board-overview__summary">Each card is the entry point, so status, task counts, and freshness stay visible at a glance.</p>
          </div>
          <div class="board-legend board-overview__legend">
            <span class="board-chip board-chip--neutral">${visibleEpics.length} visible epic${visibleEpics.length === 1 ? "" : "s"}</span>
            <span class="board-chip board-chip--neutral">${store.snapshot.tasks.length} total tasks</span>
            ${store.isMutating ? '<span class="board-chip board-chip--neutral">Saving\u2026</span>' : ""}
          </div>
        </header>
        <div class="board-table board-table--epics">
          <div class="board-table__header board-table__header--epics hidden md:grid">
            <span>Epic</span>
            <span>Status</span>
            <span>Counts</span>
            <span>Updated</span>
            <span>Action</span>
          </div>
          <div class="board-table__rows board-table__rows--epics">
            ${visibleEpics.length === 0
              ? renderEmptyState("No matching epics", "Try a different search or publish more work to the board.", "/")
              : visibleEpics.map((epic) => renderEpicRow({
                epic,
                selected: selectedEpicId === epic.id,
                copied: store.copyFeedback?.epicId === epic.id,
              })).join("")}
          </div>
        </div>
      </section>
    </div>
  `;
}

/**
 * EpicsOverview component with mount/update/unmount lifecycle.
 */
export function createEpicsOverview() {
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
