import {
  buttonClasses,
  cx,
  escapeHtml,
  neutralChipClasses,
  panelClasses,
  renderEmptyState,
  renderIcon,
  renderStatusBadge,
  sectionLabelClasses,
} from "./helpers.js";

/**
 * Render a single sidebar epic item.
 *
 * @param {object} epic
 * @param {boolean} selected
 * @returns {string}
 */
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
      aria-label="Open epic ${escapeHtml(epic.title)}"
      data-open-epic="${escapeHtml(epic.id)}"
    >
      <div class="flex items-start gap-3">
        <div class="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${selected ? "bg-[var(--board-accent)] text-white" : "bg-[var(--board-surface-3)] text-[var(--board-accent)]"}">
          ${renderIcon("folder", "text-[18px]")}
        </div>
        <div class="min-w-0">
          <strong class="block text-sm font-semibold leading-snug text-[var(--board-text)]">${escapeHtml(epic.title)}</strong>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            ${renderStatusBadge(epic.status)}
            <span class="text-xs text-[var(--board-text-soft)]">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
          </div>
        </div>
      </div>
    </button>
  `;
}

/**
 * Render the full sidebar HTML.
 *
 * @param {object} props
 * @param {object[]} props.sidebarEpics
 * @param {string|null} props.selectedEpicId
 * @returns {string}
 */
function render(props) {
  const { sidebarEpics, selectedEpicId } = props;

  return `
    <aside class="board-sidebar ${panelClasses("hidden min-h-0 overflow-hidden p-4 xl:grid xl:grid-rows-[auto_1fr]")}" aria-label="Epic switcher">
      <header class="board-sidebar__header border-b border-[var(--board-border)] pb-4">
        <span class="${sectionLabelClasses()}">Epics</span>
        <h2 class="mt-2 text-lg font-semibold tracking-tight text-[var(--board-text)]">Switch epic</h2>
        <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">Showing active epics first: in progress, then todo.</p>
      </header>
      <div class="board-sidebar__list mt-4 grid min-h-0 content-start gap-2.5 overflow-auto pr-1 overscroll-contain">
        ${sidebarEpics.length === 0
          ? renderEmptyState("No active epics", "Todo and in-progress epics will appear here for quick switching.")
          : sidebarEpics.map((epic) => renderEpicSidebarItem(epic, selectedEpicId === epic.id)).join("")}
      </div>
    </aside>
  `;
}

/**
 * Sidebar component — epic switcher panel.
 */
export function createSidebar() {
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
