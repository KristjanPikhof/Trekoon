export function renderBoardTopbar(context) {
  const {
    buttonClasses,
    currentNav,
    escapeHtml,
    neutralChipClasses,
    renderIcon,
    screen,
    search,
    sectionLabelClasses,
    selectedEpic,
    theme,
  } = context;

  const navItems = [
    { id: "epics", label: "Epics", icon: "layers" },
    { id: "board", label: "Board", icon: "view_kanban" },
    { id: "detail", label: "Detail", icon: "assignment" },
  ];

  const navMarkup = navItems.map((item) => {
    const isActive = currentNav === item.id;
    const classes = [
      "board-shell-topbar__nav-item",
      isActive ? "is-active" : "",
    ].filter(Boolean).join(" ");

    if (item.id === "epics") {
      return `<button type="button" class="${classes}" data-nav="epics">${renderIcon(item.icon, "text-[18px]")} ${escapeHtml(item.label)}</button>`;
    }

    if (item.id === "board") {
      return `<button type="button" class="${classes}" data-nav-board="true" ${selectedEpic ? "" : "disabled"}>${renderIcon(item.icon, "text-[18px]")} ${escapeHtml(item.label)}</button>`;
    }

    return `<span class="${classes}">${renderIcon(item.icon, "text-[18px]")} ${escapeHtml(item.label)}</span>`;
  }).join("");

  return `
    <header class="board-shell-topbar ${screen === "tasks" ? "board-shell-topbar--workspace" : ""}">
      <div class="board-shell-topbar__identity">
        <div class="board-shell-topbar__brand-mark" aria-hidden="true">
          ${renderIcon("rocket_launch", "text-[20px]")}
        </div>
        <div class="min-w-0">
          <p class="${sectionLabelClasses()}">${screen === "tasks" ? "Task workspace" : "Product ops"}</p>
          <div class="board-shell-topbar__title-row">
            <h1>Trekoon</h1>
            <span class="${neutralChipClasses()}">Local repo</span>
          </div>
        </div>
      </div>

      <nav class="board-shell-topbar__nav" aria-label="Board sections">
        ${navMarkup}
      </nav>

      <div class="board-shell-topbar__tools">
        <label class="board-shell-topbar__search" aria-label="Search tasks and epics">
          ${renderIcon("search", "text-[18px] text-[var(--board-text-soft)]")}
          <input id="board-search-input" type="search" placeholder="Search epics, tasks, subtasks" value="${escapeHtml(search)}" />
          <span class="board-shell-topbar__search-kbd">/</span>
        </label>
        <div class="board-shell-topbar__actions">
          <button type="button" class="${buttonClasses({ iconOnly: true })}" data-action="toggle-theme" aria-label="Toggle ${theme === "dark" ? "light" : "dark"} theme">
            ${renderIcon(theme === "dark" ? "light_mode" : "dark_mode", "text-[18px]")}
          </button>
          <details class="board-shell-topbar__meta">
            <summary>
              ${renderIcon("info", "text-[18px]")}
              <span>Workspace</span>
            </summary>
            <div>
              <p>Repo-backed board state and view preferences stay local to this workspace.</p>
            </div>
          </details>
        </div>
      </div>
    </header>
  `;
}
