import { escapeHtml, formatDate, normalizeStatus, STATUS_ORDER } from "../state/utils.js";

export { escapeHtml, formatDate, normalizeStatus, STATUS_ORDER };

// ---------------------------------------------------------------------------
// Status labels & styles
// ---------------------------------------------------------------------------

export const STATUS_LABELS = {
  todo: "Todo",
  blocked: "Blocked",
  in_progress: "In progress",
  done: "Done",
};

const STATUS_BADGE_STYLES = {
  todo: "border-white/10 bg-white/[0.05] text-[var(--board-text-muted)]",
  blocked: "border-amber-500/20 bg-amber-500/10 text-amber-300",
  in_progress: "border-sky-400/20 bg-sky-400/10 text-sky-300",
  done: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
  default: "border-[var(--board-border)] bg-white/[0.04] text-[var(--board-text-muted)]",
};

// ---------------------------------------------------------------------------
// Class-name helpers
// ---------------------------------------------------------------------------

export function cx(...classNames) {
  return classNames.filter(Boolean).join(" ");
}

export function panelClasses(extra = "") {
  return cx(
    "rounded-[28px] border border-[var(--board-border)] bg-[var(--board-surface)] shadow-panel",
    extra,
  );
}

export function secondaryPanelClasses(extra = "") {
  return cx(
    "rounded-[24px] border border-[var(--board-border)] bg-[var(--board-surface-2)]",
    extra,
  );
}

export function sectionLabelClasses() {
  return "text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--board-text-soft)]";
}

export function neutralChipClasses() {
  return "inline-flex items-center gap-1 rounded-full border border-[var(--board-border)] bg-white/[0.04] px-2.5 py-1 text-[11px] font-medium text-[var(--board-text-muted)]";
}

export function buttonClasses(options = {}) {
  const kind = options.kind ?? "secondary";
  const iconOnly = options.iconOnly ?? false;

  return cx(
    "inline-flex items-center justify-center gap-2 rounded-2xl border text-sm font-medium transition duration-200",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--board-border-strong)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--board-bg)]",
    iconOnly ? "h-10 w-10 px-0" : "min-h-10 px-4 py-2.5",
    kind === "primary"
      ? "border-[var(--board-accent)] bg-[var(--board-accent)] text-white hover:bg-[var(--board-accent-strong)] hover:border-[var(--board-accent-strong)]"
      : "border-[var(--board-border)] bg-white/[0.04] text-[var(--board-text)] hover:bg-white/[0.08] hover:border-[var(--board-border-strong)]",
  );
}

export function fieldClasses() {
  return cx(
    "w-full rounded-2xl border border-[var(--board-border)] bg-[var(--board-surface-2)] px-3.5 py-3 text-sm text-[var(--board-text)] shadow-sm transition",
    "placeholder:text-[var(--board-text-soft)] focus:border-[var(--board-border-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--board-accent-soft)]",
    "disabled:cursor-not-allowed disabled:opacity-60",
  );
}

function statusBadgeClasses(status) {
  return cx(
    "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.14em]",
    STATUS_BADGE_STYLES[normalizeStatus(status)] ?? STATUS_BADGE_STYLES.default,
  );
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

export function renderIcon(name, className = "") {
  return `<span class="${cx("material-symbols-rounded shrink-0", className)}" aria-hidden="true">${name}</span>`;
}

export function renderCopyIcon(className = "") {
  return `
    <svg class="${cx("board-inline-icon", className)}" aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <rect x="5" y="2.75" width="7" height="9" rx="1.5" stroke="currentColor" stroke-width="1.35"></rect>
      <path d="M4 5.75H3.5C2.67157 5.75 2 6.42157 2 7.25V12C2 12.8284 2.67157 13.5 3.5 13.5H8.25C9.07843 13.5 9.75 12.8284 9.75 12V11.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

export function renderCheckIcon(className = "") {
  return `
    <svg class="${cx("board-inline-icon", className)}" aria-hidden="true" viewBox="0 0 16 16" fill="none">
      <path d="M3.5 8.4L6.4 11.1L12.5 4.9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `;
}

export function readStatusLabel(rawStatus) {
  if (typeof rawStatus !== "string" || rawStatus.trim().length === 0) {
    return "Unknown";
  }

  const normalized = normalizeStatus(rawStatus);
  if (STATUS_LABELS[normalized]) {
    return STATUS_LABELS[normalized];
  }

  return rawStatus.replaceAll("_", " ").replaceAll("-", " ");
}

export function renderStatusBadge(rawStatus, label = readStatusLabel(rawStatus)) {
  return `<span class="${statusBadgeClasses(rawStatus)}">${escapeHtml(label)}</span>`;
}

export function renderStatusSelect(name, selectedStatus, disabled = false) {
  return `
    <select class="${fieldClasses()}" name="${escapeHtml(name)}" ${disabled ? "disabled" : ""}>
      ${STATUS_ORDER.map((status) => `
        <option value="${escapeHtml(status)}" ${selectedStatus === status ? "selected" : ""}>${escapeHtml(STATUS_LABELS[status] ?? status)}</option>
      `).join("")}
    </select>
  `;
}

export function renderEmptyState(title, description, shortcut) {
  return `
    <div class="rounded-[24px] border border-dashed border-[var(--board-border-strong)] bg-[var(--board-accent-soft)]/40 px-5 py-6 text-center">
      <strong class="block text-base font-semibold text-[var(--board-text)]">${escapeHtml(title)}</strong>
      <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(description)}</p>
      ${shortcut
        ? `<p class="mt-3 text-xs text-[var(--board-text-soft)]">Try <span class="inline-flex items-center rounded-lg border border-[var(--board-border)] bg-white/[0.04] px-2 py-1 font-medium text-[var(--board-text-muted)]">${escapeHtml(shortcut)}</span></p>`
        : ""}
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Description rendering helpers
// ---------------------------------------------------------------------------

export function renderDescriptionPreview(description, className = "mt-1 text-sm leading-6 text-[var(--board-text-muted)]") {
  if (!description || description.trim().length === 0) return "";
  return `<p class="${escapeHtml(className)}">${escapeHtml(description)}</p>`;
}

export function renderDescriptionBody(description, className = "text-sm leading-7 text-[var(--board-text-muted)]") {
  if (!description || description.trim().length === 0) {
    return `<p class="${escapeHtml(className)}">No description provided.</p>`;
  }
  return `<div class="${escapeHtml(className)}" style="white-space:pre-wrap;word-break:break-word">${escapeHtml(description)}</div>`;
}

export function shouldCollapseDescription(description) {
  if (!description) return false;
  const trimmed = description.trim();
  return trimmed.length > 260 || trimmed.split("\n").length > 5;
}

export function renderDescriptionSection(title, description, options = {}) {
  const {
    open = false,
    compact = false,
    emptyText = "Add context so collaborators know what done looks like.",
  } = options;

  if (!description || description.trim().length === 0) {
    return `
      <section class="${secondaryPanelClasses("board-detail-card p-4")}">
        <div class="board-section__header flex items-center justify-between gap-3">
          <strong class="text-sm font-semibold text-[var(--board-text)]">${escapeHtml(title)}</strong>
          <span class="${neutralChipClasses()}">Empty</span>
        </div>
        <p class="mt-3 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(emptyText)}</p>
      </section>
    `;
  }

  if (!shouldCollapseDescription(description)) {
    return `
      <section class="${secondaryPanelClasses("board-detail-card p-4")}">
        <div class="board-section__header flex items-center justify-between gap-3">
          <strong class="text-sm font-semibold text-[var(--board-text)]">${escapeHtml(title)}</strong>
          <span class="${neutralChipClasses()}">${escapeHtml(`${description.trim().length} chars`)}</span>
        </div>
        <div class="mt-3 ${compact ? "board-detail-copy board-detail-copy--compact" : "board-detail-copy"}">
          ${renderDescriptionBody(description)}
        </div>
      </section>
    `;
  }

  return `
    <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" ${open ? "open" : ""}>
      <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
        <span>${escapeHtml(title)}</span>
        <span class="${neutralChipClasses()}">Long</span>
      </summary>
      <div class="mt-3 board-detail-copy ${compact ? "board-detail-copy--compact" : ""}">
        ${renderDescriptionBody(description)}
      </div>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Misc shared helpers
// ---------------------------------------------------------------------------

export function readNodeLabel(kind, title) {
  if (kind === "task") return `Task: ${title}`;
  if (kind === "subtask") return `Subtask: ${title}`;
  return title;
}

export function renderEpicCountSummary(epic) {
  const totalTasks = Array.isArray(epic.taskIds) ? epic.taskIds.length : 0;
  const counts = epic.counts || { todo: 0, blocked: 0, in_progress: 0, done: 0 };
  return `
    <span class="${neutralChipClasses()}">${totalTasks} task${totalTasks === 1 ? "" : "s"}</span>
    <span class="${neutralChipClasses()}">${counts.in_progress ?? 0} doing</span>
    <span class="${neutralChipClasses()}">${counts.done ?? 0} done</span>
  `;
}

export function renderTaskMeta(task, includeStatus = false) {
  return `
    ${includeStatus ? renderStatusBadge(task.status) : ""}
    <span class="${neutralChipClasses()}">${task.subtasks.length} subtask${task.subtasks.length === 1 ? "" : "s"}</span>
    ${task.blockedBy.length > 0 ? `<span class="${neutralChipClasses()}">${task.blockedBy.length} blocker${task.blockedBy.length === 1 ? "" : "s"}</span>` : ""}
  `;
}

export function hasLongTaskTitle(title) {
  if (!title) return false;
  const trimmed = title.trim();
  return trimmed.length > 72 || trimmed.split("\n").length > 2;
}

export function isCompactViewport() {
  return typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)")?.matches;
}

export function shouldUseTaskModal(boardState, store) {
  return Boolean(boardState?.selectedTask);
}

export function lookupNode(snapshot, id) {
  return snapshot.tasks.find((task) => task.id === id)
    ?? snapshot.subtasks.find((subtask) => subtask.id === id)
    ?? null;
}
