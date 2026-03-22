import { isValidTransition } from "../state/utils.js";

/**
 * Event delegation system for the board runtime.
 *
 * Attaches a single listener per event type on the root element.
 * Uses event.target.closest() to match data-attributes, so dynamically
 * rendered content is handled automatically without rebinding.
 *
 * @param {HTMLElement} rootElement  Mount root for delegated listeners.
 * @param {object}      actions     Callback map the delegation dispatches into.
 * @returns {() => void} Teardown function that removes every listener.
 */
export function createDelegation(rootElement, actions) {
  // ---------------------------------------------------------------------------
  // Click delegation
  // ---------------------------------------------------------------------------
  function handleClick(event) {
    const { target } = event;

    // -- Destructive / mutation buttons (most specific first) -----------------

    const deleteSubtaskEl = target.closest("[data-delete-subtask]");
    if (deleteSubtaskEl) {
      if (actions.isMutating()) return;
      const subtaskId = deleteSubtaskEl.dataset.deleteSubtask;
      if (subtaskId) actions.deleteSubtask(subtaskId, deleteSubtaskEl);
      return;
    }

    const removeDependencyEl = target.closest("[data-remove-dependency-source]");
    if (removeDependencyEl) {
      if (actions.isMutating()) return;
      const sourceId = removeDependencyEl.dataset.removeDependencySource;
      const dependsOnId = removeDependencyEl.dataset.removeDependencyTarget;
      actions.removeDependency(sourceId, dependsOnId, removeDependencyEl);
      return;
    }

    // -- Disclosure openers ---------------------------------------------------

    const openSubtaskEl = target.closest("[data-open-subtask]");
    if (openSubtaskEl) {
      actions.openSubtask(openSubtaskEl.dataset.openSubtask || null, openSubtaskEl);
      return;
    }

    const copyEpicIdEl = target.closest("[data-copy-epic-id]");
    if (copyEpicIdEl) {
      actions.copyEpicId(copyEpicIdEl.dataset.copyEpicId || null);
      return;
    }

    // -- Backdrop-style close handlers ----------------------------------------
    // Only close when the click lands directly on the backdrop element itself,
    // not on any child content rendered inside the overlay.

    const closeSubtaskEl = target.closest("[data-close-subtask]");
    if (closeSubtaskEl) {
      if (
        closeSubtaskEl.classList.contains("board-modal-backdrop") &&
        target !== closeSubtaskEl
      ) {
        return;
      }
      actions.closeSubtask();
      return;
    }

    const closeTaskEl = target.closest("[data-close-task]");
    if (closeTaskEl) {
      if (
        closeTaskEl.classList.contains("board-task-modal-backdrop") &&
        target !== closeTaskEl
      ) {
        return;
      }
      actions.closeTask();
      return;
    }

    const closeConfirmEl = target.closest("[data-close-confirm]");
    if (closeConfirmEl) {
      if (
        closeConfirmEl.classList.contains("board-confirm-backdrop") &&
        target !== closeConfirmEl
      ) {
        return;
      }
      actions.cancelDelete();
      return;
    }

    // -- Status filter pills ---------------------------------------------------
    const epicFilterEl = target.closest("[data-toggle-epic-status-filter]");
    if (epicFilterEl) {
      actions.toggleEpicStatusFilter(epicFilterEl.dataset.toggleEpicStatusFilter);
      return;
    }

    const taskFilterEl = target.closest("[data-toggle-task-status-filter]");
    if (taskFilterEl) {
      actions.toggleTaskStatusFilter(taskFilterEl.dataset.toggleTaskStatusFilter);
      return;
    }

    const resetEpicFilterEl = target.closest("[data-reset-epic-filter]");
    if (resetEpicFilterEl) {
      actions.resetEpicFilter();
      return;
    }

    const resetTaskFilterEl = target.closest("[data-reset-task-filter]");
    if (resetTaskFilterEl) {
      actions.resetTaskFilter();
      return;
    }

    // -- Navigation -----------------------------------------------------------

    const navEl = target.closest("[data-nav]");
    if (navEl) {
      if (navEl.dataset.nav === "epics") actions.showEpics();
      return;
    }

    const navBoardEl = target.closest("[data-nav-board]");
    if (navBoardEl) {
      actions.showBoard();
      return;
    }

    const navDetailEl = target.closest("[data-nav-detail]");
    if (navDetailEl) {
      actions.scrollToDetail();
      return;
    }

    // -- Notes panel toggle ---------------------------------------------------

    const toggleNotesEl = target.closest("[data-toggle-notes]");
    if (toggleNotesEl) {
      actions.toggleNotesPanel();
      return;
    }

    // -- View switching -------------------------------------------------------

    const viewEl = target.closest("[data-view]");
    if (viewEl) {
      actions.setView(viewEl.dataset.view);
      return;
    }

    // -- Generic actions (toggle-theme, confirm-delete, cancel-delete) --------

    const actionEl = target.closest("[data-action]");
    if (actionEl) {
      const action = actionEl.dataset.action;
      if (action === "toggle-theme") actions.toggleTheme();
      if (action === "confirm-delete") actions.confirmDelete();
      if (action === "cancel-delete") actions.cancelDelete();
      return;
    }

    // -- Epic selection -------------------------------------------------------

    const openEpicEl = target.closest("[data-open-epic]");
    if (openEpicEl) {
      actions.openEpic(openEpicEl.dataset.openEpic || null);
      return;
    }

    // -- Task selection (broadest — checked last) -----------------------------

    const taskEl = target.closest("[data-task-id]");
    if (taskEl) {
      actions.selectTask(taskEl.dataset.taskId, taskEl);
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Input delegation (#board-search-input)
  // ---------------------------------------------------------------------------
  function handleInput(event) {
    if (event.target.id === "board-search-input") {
      actions.updateSearch(event.target.value);
    }
  }

  // ---------------------------------------------------------------------------
  // Change delegation (#board-epic-select)
  // ---------------------------------------------------------------------------
  function handleChange(event) {
    if (event.target.id === "board-epic-select") {
      actions.selectEpic(event.target.value || null);
      return;
    }

    const epicStatusForm = event.target.closest("[data-epic-status-form]");
    if (epicStatusForm) {
      if (actions.isMutating()) return;
      actions.changeEpicStatus(epicStatusForm.dataset.epicStatusForm, event.target.value);
      return;
    }

    const bulkStatusForm = event.target.closest("[data-bulk-status-form]");
    if (bulkStatusForm) {
      if (actions.isMutating()) return;
      const newStatus = event.target.value;
      if (newStatus) {
        actions.bulkSetStatus(bulkStatusForm.dataset.bulkStatusForm, newStatus);
        event.target.value = "";
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Submit delegation (data-task-form, data-subtask-form, etc.)
  // ---------------------------------------------------------------------------
  function handleSubmit(event) {
    const form = event.target;

    const taskForm = form.closest("[data-task-form]");
    if (taskForm) {
      event.preventDefault();
      if (actions.isMutating()) return;
      actions.submitTaskForm(taskForm.dataset.taskForm, new FormData(taskForm));
      return;
    }

    const subtaskForm = form.closest("[data-subtask-form]");
    if (subtaskForm) {
      event.preventDefault();
      if (actions.isMutating()) return;
      actions.submitSubtaskForm(
        subtaskForm.dataset.subtaskForm,
        new FormData(subtaskForm),
      );
      return;
    }

    const createSubtaskForm = form.closest("[data-create-subtask-form]");
    if (createSubtaskForm) {
      event.preventDefault();
      if (actions.isMutating()) return;
      actions.submitCreateSubtask(
        createSubtaskForm.dataset.createSubtaskForm,
        new FormData(createSubtaskForm),
      );
      return;
    }

    const dependencyForm = form.closest("[data-dependency-form]");
    if (dependencyForm) {
      event.preventDefault();
      if (actions.isMutating()) return;
      actions.addDependency(
        dependencyForm.dataset.dependencyForm,
        new FormData(dependencyForm),
      );
      return;
    }
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts (window-level)
  // ---------------------------------------------------------------------------
  function handleKeydown(event) {
    if (event.defaultPrevented) {
      return;
    }
    actions.handleKeydown(event);
  }

  function handleDelegatedKeydown(event) {
    if (event.defaultPrevented) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest("[data-copy-epic-id]")) {
      return;
    }

    const openEpicEl = target.closest("[data-open-epic]");
    if (!openEpicEl) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      actions.openEpic(openEpicEl.dataset.openEpic || null);
    }
  }

  // ---------------------------------------------------------------------------
  // Drag-and-drop delegation
  // ---------------------------------------------------------------------------
  let draggedTaskStatus = null;

  function cleanupDragFeedback() {
    draggedTaskStatus = null;
    for (const el of rootElement.querySelectorAll(".board-drop-valid, .board-drop-invalid")) {
      el.classList.remove("board-drop-valid", "board-drop-invalid");
    }
  }

  function handleDragstart(event) {
    const draggable = event.target.closest("[data-draggable-task]");
    if (!draggable) return;

    if (actions.isMutating()) {
      event.preventDefault();
      return;
    }

    const taskId = draggable.dataset.taskId;
    if (!taskId) return;

    event.dataTransfer?.setData("text/task-id", taskId);
    event.dataTransfer?.setData("text/plain", taskId);
    draggedTaskStatus = actions.getTaskStatus(taskId);
  }

  function handleDragover(event) {
    const column = event.target.closest("[data-drop-status]");
    if (!column) return;

    const targetStatus = column.dataset.dropStatus;
    if (draggedTaskStatus && isValidTransition(draggedTaskStatus, targetStatus)) {
      event.preventDefault();
      column.classList.add("board-drop-valid");
      column.classList.remove("board-drop-invalid");
    } else if (draggedTaskStatus && targetStatus !== draggedTaskStatus) {
      column.classList.add("board-drop-invalid");
      column.classList.remove("board-drop-valid");
    }
  }

  function handleDragleave(event) {
    const column = event.target.closest("[data-drop-status]");
    if (column && !column.contains(event.relatedTarget)) {
      column.classList.remove("board-drop-valid", "board-drop-invalid");
    }
  }

  function handleDrop(event) {
    const column = event.target.closest("[data-drop-status]");
    if (!column) return;

    event.preventDefault();
    if (actions.isMutating()) return;

    const taskId =
      event.dataTransfer?.getData("text/task-id") ||
      event.dataTransfer?.getData("text/plain");
    const nextStatus = column.dataset.dropStatus;

    if (draggedTaskStatus && !isValidTransition(draggedTaskStatus, nextStatus)) {
      cleanupDragFeedback();
      return;
    }

    actions.dropTaskStatus(taskId, nextStatus);
    cleanupDragFeedback();
  }

  function handleDragend() {
    cleanupDragFeedback();
  }

  // ---------------------------------------------------------------------------
  // Attach
  // ---------------------------------------------------------------------------
  rootElement.addEventListener("click", handleClick);
  rootElement.addEventListener("input", handleInput);
  rootElement.addEventListener("change", handleChange);
  rootElement.addEventListener("submit", handleSubmit);
  rootElement.addEventListener("dragstart", handleDragstart);
  rootElement.addEventListener("dragover", handleDragover);
  rootElement.addEventListener("dragleave", handleDragleave);
  rootElement.addEventListener("drop", handleDrop);
  rootElement.addEventListener("dragend", handleDragend);
  rootElement.addEventListener("keydown", handleDelegatedKeydown);
  window.addEventListener("keydown", handleKeydown);

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------
  return function teardown() {
    rootElement.removeEventListener("click", handleClick);
    rootElement.removeEventListener("input", handleInput);
    rootElement.removeEventListener("change", handleChange);
    rootElement.removeEventListener("submit", handleSubmit);
    rootElement.removeEventListener("dragstart", handleDragstart);
    rootElement.removeEventListener("dragover", handleDragover);
    rootElement.removeEventListener("dragleave", handleDragleave);
    rootElement.removeEventListener("drop", handleDrop);
    rootElement.removeEventListener("dragend", handleDragend);
    rootElement.removeEventListener("keydown", handleDelegatedKeydown);
    window.removeEventListener("keydown", handleKeydown);
  };
}
