import { preserveInput } from "./Component.js";
import {
  cx,
  escapeHtml,
  neutralChipClasses,
  renderIcon,
} from "./helpers.js";

/**
 * Render the topbar HTML.
 * @param {object} props
 * @returns {string}
 */
function render(props) {
  const {
    currentNav,
    screen,
    search,
    searchScope,
    selectedEpic,
    theme,
    isMutating,
  } = props;

  const navItems = [
    {
      id: "epics",
      label: "Epics",
      icon: "layers",
      action: 'data-nav="epics"',
      tooltip: "Open the epic list and overview.",
    },
    {
      id: "board",
      label: "Board",
      icon: "view_kanban",
      action: 'data-nav-board="true"',
      disabled: !selectedEpic,
      tooltip: selectedEpic
        ? "Open the selected epic board."
        : "Select an epic to open its board.",
    },
  ];

  const navMarkup = navItems.map((item) => {
    const isActive = currentNav === item.id;
    const classes = [
      "board-shell-topbar__nav-item",
      isActive ? "is-active" : "",
    ].filter(Boolean).join(" ");

    return `
      <button type="button" class="${classes}" ${item.action} ${item.disabled ? "disabled" : ""} role="tab" aria-selected="${isActive}" tabindex="${isActive ? "0" : "-1"}" aria-label="${escapeHtml(item.label)} view" title="${escapeHtml(item.tooltip)}">
        ${renderIcon(item.icon, "text-[16px]")} <span>${escapeHtml(item.label)}</span>
      </button>
    `;
  }).join("");

  const epicContext = selectedEpic
    ? escapeHtml(selectedEpic.title)
    : escapeHtml(searchScope?.summary ?? "No epic selected");
  const currentScope = selectedEpic?.title ?? searchScope?.summary ?? "Epic overview";
  const scopeIntro = selectedEpic
    ? "This workspace is currently focused on the selected epic below."
    : "This workspace is currently showing the broader board scope below.";

  return `
    <header class="board-shell-topbar ${screen === "tasks" ? "board-shell-topbar--workspace" : ""}">
      <div class="board-shell-topbar__identity">
        <div class="board-shell-topbar__brand-mark" aria-hidden="true">
          ${renderIcon("rocket_launch", "text-[18px]")}
        </div>
        <div class="min-w-0">
          <div class="board-shell-topbar__title-row">
            <h1>Trekoon</h1>
          </div>
          <p class="board-shell-topbar__context">${epicContext}</p>
        </div>
      </div>

      <nav class="board-shell-topbar__nav" role="tablist" aria-label="Board sections">
        ${navMarkup}
      </nav>

      <div class="board-shell-topbar__tools">
        <label class="board-shell-topbar__search" for="board-search-input">
          <span class="board-shell-topbar__search-label">Search board</span>
          ${renderIcon("search", "text-[16px] text-[var(--board-text-soft)]")}
          <input id="board-search-input" type="search" autocomplete="off" placeholder="Search epics, tasks, subtasks\u2026" value="${escapeHtml(search)}" aria-describedby="board-search-shortcut board-search-scope" />
          <span class="board-shell-topbar__search-kbd">/</span>
        </label>
        <span id="board-search-scope" class="board-shell-topbar__assistive-copy">${escapeHtml(searchScope?.detail ?? "Search across epics, tasks, and subtasks.")}</span>
        <span id="board-search-shortcut" class="board-shell-topbar__assistive-copy">Press slash to focus search. Press Escape to clear search before navigating away.</span>
        <div class="board-shell-topbar__actions">
          <button type="button" class="board-shell-topbar__icon-btn" data-action="toggle-theme" aria-label="Switch to ${theme === "dark" ? "light" : "dark"} theme" title="Switch to ${theme === "dark" ? "light" : "dark"} theme" ${isMutating ? "disabled" : ""}>
            ${renderIcon(theme === "dark" ? "light_mode" : "dark_mode", "text-[16px]")}
          </button>
          <details class="board-shell-topbar__meta">
            <summary aria-label="Board information">${renderIcon("info", "text-[16px]")}</summary>
            <div>
              <h3 class="board-shell-topbar__meta-title">How this board stores data</h3>
              <div class="board-shell-topbar__meta-section">
                <strong>Repository-backed board data</strong>
                <p>Epics, tasks, and status changes are backed by files in this repository. When you update board content here, you are updating project state that belongs to this repo.</p>
              </div>
              <div class="board-shell-topbar__meta-section">
                <strong>Workspace-local preferences</strong>
                <p>UI preferences such as theme, selected view, and similar workspace settings are stored only in this local workspace. They are not written into the repository and are not shared automatically with other clones or teammates.</p>
              </div>
              <div class="board-shell-topbar__meta-section">
                <strong>Current scope</strong>
                <p>${escapeHtml(scopeIntro)}</p>
                <p class="board-shell-topbar__meta-scope">${escapeHtml(currentScope)}</p>
              </div>
            </div>
          </details>
        </div>
      </div>
    </header>
  `;
}

/**
 * TopBar component — manages search input, preserves value/cursor on update.
 */
export function createTopBar() {
  let container = null;
  let lastProps = null;

  return {
    mount(el) {
      container = el;
      return this;
    },

    update(props) {
      if (!container) return;

      // On first render, just set innerHTML
      if (!lastProps) {
        container.innerHTML = render(props);
        lastProps = props;
        return;
      }

      // Preserve search input value and cursor across re-renders
      preserveInput(container, "#board-search-input", () => {
        container.innerHTML = render(props);
      });

      lastProps = props;
    },

    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      lastProps = null;
    },
  };
}
