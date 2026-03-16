export function renderBoardTopbar(context) {
  const {
    buttonClasses,
    currentNav,
    escapeHtml,
    neutralChipClasses,
    renderIcon,
    screen,
    search,
    searchScope,
    selectedEpic,
    theme,
  } = context;

  const navItems = [
    { id: "epics", label: "Epics", icon: "layers", action: 'data-nav="epics"' },
    { id: "board", label: "Board", icon: "view_kanban", action: 'data-nav-board="true"', disabled: !selectedEpic },
  ];

  const navMarkup = navItems.map((item) => {
    const isActive = currentNav === item.id;
    const classes = [
      "board-shell-topbar__nav-item",
      isActive ? "is-active" : "",
    ].filter(Boolean).join(" ");

    return `
      <button type="button" class="${classes}" ${item.action} ${item.disabled ? "disabled" : ""} ${isActive ? 'aria-current="page"' : ""}>
        ${renderIcon(item.icon, "text-[16px]")} <span>${escapeHtml(item.label)}</span>
      </button>
    `;
  }).join("");

  const epicContext = selectedEpic
    ? escapeHtml(selectedEpic.title)
    : escapeHtml(searchScope?.summary ?? "No epic selected");

  return `
    <header class="board-shell-topbar ${screen === "tasks" ? "board-shell-topbar--workspace" : ""}">
      <div class="board-shell-topbar__identity">
        <div class="board-shell-topbar__brand-mark" aria-hidden="true">
          ${renderIcon("rocket_launch", "text-[18px]")}
        </div>
        <div class="min-w-0">
          <div class="board-shell-topbar__title-row">
            <h1>Trekoon</h1>
            <span class="${neutralChipClasses()}">Local repo</span>
          </div>
          <p class="board-shell-topbar__context">${epicContext}</p>
        </div>
      </div>

      <nav class="board-shell-topbar__nav" aria-label="Board sections">
        ${navMarkup}
      </nav>

      <div class="board-shell-topbar__tools">
        <label class="board-shell-topbar__search" aria-label="Search tasks and epics">
          ${renderIcon("search", "text-[16px] text-[var(--board-text-soft)]")}
          <input id="board-search-input" type="search" placeholder="Search epics, tasks, subtasks" value="${escapeHtml(search)}" />
          <span class="board-shell-topbar__search-kbd">/</span>
        </label>
        <div class="board-shell-topbar__actions">
          <button type="button" class="${buttonClasses({ iconOnly: true })}" data-action="toggle-theme" aria-label="Toggle ${theme === "dark" ? "light" : "dark"} theme">
            ${renderIcon(theme === "dark" ? "light_mode" : "dark_mode", "text-[18px]")}
          </button>
          <details class="board-shell-topbar__meta">
            <summary>${renderIcon("info", "text-[16px]")}</summary>
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
