import { preserveFormState, preserveDetailsState } from "./Component.js";
import {
  buttonClasses,
  escapeHtml,
  fieldClasses,
  formatDate,
  lookupNode,
  neutralChipClasses,
  readNodeLabel,
  readStatusLabel,
  renderDescriptionPreview,
  renderDescriptionSection,
  renderEmptyState,
  renderStatusBadge,
  renderStatusSelect,
  secondaryPanelClasses,
  sectionLabelClasses,
} from "./helpers.js";

// ---------------------------------------------------------------------------
// Sub-render helpers
// ---------------------------------------------------------------------------

function renderDependencyOptions(task, snapshot) {
  const existing = new Set(task.blockedBy);
  return [
    ...snapshot.tasks.map((c) => ({ id: c.id, kind: "task", title: c.title })),
    ...snapshot.subtasks.map((c) => ({ id: c.id, kind: "subtask", title: c.title })),
  ]
    .filter((c) => c.id !== task.id && !existing.has(c.id))
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(readNodeLabel(c.kind, c.title))}</option>`)
    .join("");
}

function renderDependencyItems(task, snapshot, isMutating, dependencyIds) {
  if (dependencyIds.length === 0) {
    return renderEmptyState("No dependencies", "Add blockers here to keep task transitions honest.");
  }

  return dependencyIds.map((depId) => {
    const dep = lookupNode(snapshot, depId);
    return `
      <article class="board-related-item grid gap-3 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
        <div class="min-w-0">
          <strong class="block text-sm font-semibold text-[var(--board-text)]">${escapeHtml(readNodeLabel(dep?.kind ?? "task", dep?.title ?? depId))}</strong>
          ${renderDescriptionPreview(dep?.description ?? "", "board-related-item__description mt-2 text-sm leading-6 text-[var(--board-text-muted)]")}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          ${renderStatusBadge(dep?.status ?? "todo", readStatusLabel(dep?.status ?? "Unknown"))}
          <button type="button" class="${buttonClasses()}" data-remove-dependency-source="${escapeHtml(task.id)}" data-remove-dependency-target="${escapeHtml(depId)}" ${isMutating ? "disabled" : ""} aria-label="Remove dependency ${escapeHtml(dep?.title ?? depId)}">Remove</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderDependencySection(task, snapshot, isMutating) {
  const visible = task.blockedBy.slice(0, 3);
  const hidden = task.blockedBy.slice(3);
  return `
    <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" ${task.blockedBy.length <= 2 ? "open" : ""}>
      <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
        <span>Dependencies</span>
        <span class="${neutralChipClasses()}">${task.blockedBy.length}</span>
      </summary>
      <form class="mt-4 grid gap-4" data-dependency-form="${escapeHtml(task.id)}">
        <label class="grid gap-2">
          <span class="${sectionLabelClasses()}">Add dependency</span>
          <select class="${fieldClasses()}" name="dependsOnId" required ${isMutating ? "disabled" : ""}>
            <option value="">Select a task or subtask\u2026</option>
            ${renderDependencyOptions(task, snapshot)}
          </select>
        </label>
        <div class="flex justify-end">
          <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Add dependency</button>
        </div>
      </form>
      <div class="board-inline-list mt-4 space-y-3">
        ${renderDependencyItems(task, snapshot, isMutating, visible)}
      </div>
      ${hidden.length > 0 ? `
        <details class="board-disclosure board-detail-nested mt-4 ${secondaryPanelClasses("p-3")}">
          <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Show ${hidden.length} more ${hidden.length === 1 ? "dependency" : "dependencies"}</summary>
          <div class="board-inline-list mt-3 space-y-3">
            ${renderDependencyItems(task, snapshot, isMutating, hidden)}
          </div>
        </details>
      ` : ""}
    </details>
  `;
}

function renderSubtaskItems(subtasks) {
  if (subtasks.length === 0) {
    return renderEmptyState("No subtasks", "This task does not have subtasks in the current snapshot.");
  }

  return `
    <div class="space-y-3">
      ${subtasks.map((subtask) => `
        <article class="board-related-item grid gap-3 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div class="min-w-0">
            <strong class="block text-sm font-semibold text-[var(--board-text)]">${escapeHtml(subtask.title)}</strong>
            ${renderDescriptionPreview(subtask.description, "board-related-item__description mt-2 text-sm leading-6 text-[var(--board-text-muted)]")}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            ${renderStatusBadge(subtask.status)}
            <button type="button" class="${buttonClasses()}" data-open-subtask="${escapeHtml(subtask.id)}" aria-label="Open subtask ${escapeHtml(subtask.title)}">Open</button>
            <button type="button" class="${buttonClasses()}" data-delete-subtask="${escapeHtml(subtask.id)}" aria-label="Remove subtask ${escapeHtml(subtask.title)}">Remove</button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderCreateSubtaskForm(task, isMutating) {
  return `
    <form class="grid gap-4 rounded-3xl border border-[var(--board-border)] bg-white/[0.03] p-4" data-create-subtask-form="${escapeHtml(task.id)}">
      <div>
        <span class="${sectionLabelClasses()}">Add subtask</span>
        <p class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">Create a new subtask directly from the task detail panel.</p>
      </div>
      <label class="grid gap-2">
        <span class="${sectionLabelClasses()}">Title</span>
        <input class="${fieldClasses()}" name="title" placeholder="Write tests\u2026" required ${isMutating ? "disabled" : ""} />
      </label>
      <label class="grid gap-2">
        <span class="${sectionLabelClasses()}">Description</span>
        <textarea class="${fieldClasses()} min-h-[96px]" name="description" rows="3" placeholder="Optional context for this subtask\u2026" ${isMutating ? "disabled" : ""}></textarea>
      </label>
      <label class="grid gap-2">
        <span class="${sectionLabelClasses()}">Status</span>
        ${renderStatusSelect("status", "todo", isMutating)}
      </label>
      <div class="flex justify-end">
        <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Add subtask</button>
      </div>
    </form>
  `;
}

function renderSubtaskSection(task, isMutating) {
  const visible = task.subtasks.slice(0, 4);
  const hidden = task.subtasks.slice(4);
  const shouldOpen = task.subtasks.length <= 3;
  return `
    <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" ${shouldOpen ? "open" : ""}>
      <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
        <span>Subtasks</span>
        <span class="${neutralChipClasses()}">${task.subtasks.length}</span>
      </summary>
      <div class="mt-4 space-y-4">
        <details class="board-disclosure board-detail-nested ${secondaryPanelClasses("p-3")}" ${task.subtasks.length === 0 ? "open" : ""}>
          <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Add subtask</summary>
          <div class="mt-3">
            ${renderCreateSubtaskForm(task, isMutating)}
          </div>
        </details>
        ${renderSubtaskItems(visible)}
        ${hidden.length > 0 ? `
          <details class="board-disclosure board-detail-nested ${secondaryPanelClasses("p-3")}">
            <summary class="cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">Show ${hidden.length} more subtask${hidden.length === 1 ? "" : "s"}</summary>
            <div class="mt-3">
              ${renderSubtaskItems(hidden)}
            </div>
          </details>
        ` : ""}
      </div>
    </details>
  `;
}

// ---------------------------------------------------------------------------
// Task surface (shared between Inspector drawer and TaskModal)
// ---------------------------------------------------------------------------

export function renderTaskSurface(props) {
  const { task, epics, snapshot, isMutating = false, options = {} } = props;
  const epic = epics.find((c) => c.id === task.epicId) ?? null;
  const {
    titleId = "",
    closeLabel = "Close",
    containerClassName = "board-detail-surface",
    detailEyebrow = "Task detail",
    scrollSurface = "inspector",
  } = options;

  return `
    <div class="${containerClassName} grid h-full min-h-0 grid-rows-[auto_1fr] overflow-hidden overflow-y-auto">
      <header class="board-detail-surface__header board-drawer__header border-b border-[var(--board-border)] pb-5">
        <div class="board-detail-surface__hero flex flex-col gap-4">
          <div class="board-detail-surface__title-row flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div class="min-w-0">
              <span class="${sectionLabelClasses()}">${escapeHtml(detailEyebrow)}</span>
              <h3 ${titleId ? `id="${escapeHtml(titleId)}"` : ""} class="mt-2 text-2xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(task.title)}</h3>
              <p class="board-detail-surface__context mt-2 text-sm text-[var(--board-text-muted)]">One dominant task surface with sticky context, close, and constrained internal scrolling.</p>
            </div>
            <button type="button" class="${buttonClasses()} shrink-0" data-close-task aria-label="${escapeHtml(closeLabel)}">${escapeHtml(closeLabel)}</button>
          </div>
          <div class="board-detail-surface__meta flex flex-wrap gap-2">
            <span class="${neutralChipClasses()}">Epic ${escapeHtml(epic?.title ?? "Unknown")}</span>
            ${renderStatusBadge(task.status)}
            <span class="${neutralChipClasses()}">${task.subtasks.length} subtask${task.subtasks.length === 1 ? "" : "s"}</span>
            <span class="${neutralChipClasses()}">${task.blockedBy.length} blocker${task.blockedBy.length === 1 ? "" : "s"}</span>
          </div>
        </div>
      </header>
      <div class="board-detail-surface__body board-drawer__body min-h-0 overscroll-contain pt-5 pr-1" data-scroll-surface="${escapeHtml(scrollSurface)}">
        <div class="board-detail-surface__stack space-y-4">
          <section class="${secondaryPanelClasses("board-detail-card p-4")}">
            <div class="board-detail-summary-grid grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <div>
                <p class="${sectionLabelClasses()}">Updated</p>
                <p class="mt-2 text-sm font-medium text-[var(--board-text)]">${escapeHtml(formatDate(task.updatedAt))}</p>
              </div>
              <div>
                <p class="${sectionLabelClasses()}">Dependencies</p>
                <p class="mt-2 text-sm font-medium text-[var(--board-text)]">${task.blockedBy.length} blocking item${task.blockedBy.length === 1 ? "" : "s"}</p>
              </div>
              <div>
                <p class="${sectionLabelClasses()}">Outgoing</p>
                <p class="mt-2 text-sm font-medium text-[var(--board-text)]">${task.blocks.length} dependent item${task.blocks.length === 1 ? "" : "s"}</p>
              </div>
            </div>
          </section>
          ${renderDescriptionSection("Description", task.description, { open: false, compact: true })}
          <details class="board-disclosure ${secondaryPanelClasses("board-detail-card p-4")}" open>
            <summary class="board-detail-summary-row cursor-pointer list-none text-sm font-semibold text-[var(--board-text)]">
              <span>Edit task</span>
              ${renderStatusBadge(task.status)}
            </summary>
            <form class="mt-4 grid gap-4" data-task-form="${escapeHtml(task.id)}">
              <label class="grid gap-2">
                <span class="${sectionLabelClasses()}">Title</span>
                <input class="${fieldClasses()}" name="title" value="${escapeHtml(task.title)}" placeholder="Task title\u2026" required ${isMutating ? "disabled" : ""} />
              </label>
              <label class="grid gap-2">
                <span class="${sectionLabelClasses()}">Description</span>
                <textarea class="${fieldClasses()} min-h-[180px]" name="description" rows="7" placeholder="Task description\u2026" ${isMutating ? "disabled" : ""}>${escapeHtml(task.description)}</textarea>
              </label>
              <label class="grid gap-2">
                <span class="${sectionLabelClasses()}">Status</span>
                ${renderStatusSelect("status", task.status, isMutating)}
              </label>
              <div class="board-detail-surface__actions flex flex-wrap justify-end gap-3">
                <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Save task</button>
              </div>
            </form>
          </details>
          ${renderDependencySection(task, snapshot, isMutating)}
          ${renderSubtaskSection(task, isMutating)}
        </div>
      </div>
    </div>
  `;
}

/**
 * Inspector component — task detail drawer, preserves form state across updates.
 */
export function createInspector() {
  let container = null;
  let currentTaskId = null;

  return {
    mount(el) {
      container = el;
      return this;
    },

    /**
     * @param {{ task: object|null, epics: object[], snapshot: object, isMutating: boolean } | null} props
     */
    update(props) {
      if (!container) return;

      if (!props || !props.task) {
        if (currentTaskId) {
          container.innerHTML = "";
          currentTaskId = null;
        }
        return;
      }

      const { task } = props;
      const surfaceOptions = {
        closeLabel: "Close inspector",
        containerClassName: "board-detail-surface board-detail-surface--inspector",
        detailEyebrow: "Task inspector",
        scrollSurface: "inspector",
      };

      if (currentTaskId === task.id) {
        // Same task — preserve form state and details open/closed state
        preserveDetailsState(container, () => {
          preserveFormState(container, () => {
            container.innerHTML = renderTaskSurface({ ...props, options: surfaceOptions });
          });
        });
      } else {
        // Different task — full re-render
        container.innerHTML = renderTaskSurface({ ...props, options: surfaceOptions });
        currentTaskId = task.id;
      }
    },

    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      currentTaskId = null;
    },
  };
}
