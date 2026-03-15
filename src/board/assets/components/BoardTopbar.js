export function renderBoardTopbar(context) {
  const {
    buttonClasses,
    currentNav,
    escapeHtml,
    isCompactViewport,
    neutralChipClasses,
    renderIcon,
    screen,
    search,
    searchScope,
    sectionLabelClasses,
    selectedEpic,
    theme,
  } = context;

  const navDetail = currentNav === "detail"
    ? selectedEpic
      ? `Task detail · ${selectedEpic.title}`
      : "Task detail"
    : searchScope?.detail ?? "Open a task to focus the detail surface.";

  const navItems = [
    { id: "epics", label: "Epics", icon: "layers", helper: "Browse every epic", action: 'data-nav="epics"' },
    { id: "board", label: "Board", icon: "view_kanban", helper: selectedEpic ? `Active epic · ${selectedEpic.title}` : "Choose an epic to enter the board", action: 'data-nav-board="true"', disabled: !selectedEpic },
    { id: "detail", label: "Detail", icon: "assignment", helper: navDetail, action: 'data-nav-detail="true"', disabled: currentNav !== "detail" },
  ];

  const navMarkup = navItems.map((item) => {
    const isActive = currentNav === item.id;
    const classes = [
      "board-shell-topbar__nav-item",
      isActive ? "is-active" : "",
    ].filter(Boolean).join(" ");

    return `
      <button type="button" class="${classes}" ${item.action} ${item.disabled ? "disabled" : ""} ${isActive ? 'aria-current="page"' : ""}>
        <span class="board-shell-topbar__nav-item-main">${renderIcon(item.icon, "text-[18px]")} <span>${escapeHtml(item.label)}</span></span>
        ${isCompactViewport ? `<span class="board-shell-topbar__nav-item-helper">${escapeHtml(item.helper)}</span>` : ""}
      </button>
    `;
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
            <span class="${neutralChipClasses()}">${escapeHtml(searchScope?.summary ?? "Epic overview")}</span>
          </div>
          <p class="mt-2 text-sm text-[var(--board-text-muted)]">
            ${escapeHtml(searchScope?.detail ?? "Keep epic, task, and search context aligned.")}
            ${selectedEpic ? ` · Active epic ${escapeHtml(selectedEpic.title)}` : ""}
          </p>
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
              <p class="mt-2 text-sm text-[var(--board-text-muted)]">Current scope: ${escapeHtml(searchScope?.summary ?? "Epic overview")}</p>
            </div>
          </details>
        </div>
      </div>
    </header>
  `;
}
