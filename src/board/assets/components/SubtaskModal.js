import { preserveFormState } from "./Component.js";
import {
  buttonClasses,
  escapeHtml,
  fieldClasses,
  panelClasses,
  renderStatusSelect,
  sectionLabelClasses,
} from "./helpers.js";

/**
 * Render the subtask modal HTML.
 *
 * @param {object} props
 * @param {object} props.subtask
 * @param {boolean} props.isMutating
 * @returns {string}
 */
function render(props) {
  const { subtask, isMutating = false } = props;

  return `
    <div class="board-modal-backdrop fixed inset-0 z-40 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-md" data-close-subtask>
      <section class="board-modal board-modal--sheet ${panelClasses("grid max-h-[calc(100dvh-2rem)] w-full grid-rows-[auto_1fr] overflow-hidden p-5 sm:p-6")}" role="dialog" aria-modal="true" aria-labelledby="board-subtask-modal-title">
        <header class="board-modal__header board-detail-surface__header border-b border-[var(--board-border)] pb-5">
          <div>
            <span class="${sectionLabelClasses()}">Subtask editor</span>
            <h3 id="board-subtask-modal-title" class="mt-2 text-xl font-semibold tracking-tight text-[var(--board-text)]">${escapeHtml(subtask.title)}</h3>
          </div>
          <button type="button" class="${buttonClasses()} mt-4 sm:mt-0" data-close-subtask aria-label="Close subtask editor">Close</button>
        </header>
        <div class="board-modal__body board-detail-surface__body min-h-0 pt-5" data-scroll-surface="subtask-modal">
          <form class="grid gap-4" data-subtask-form="${escapeHtml(subtask.id)}">
            <label class="grid gap-2">
              <span class="${sectionLabelClasses()}">Title</span>
              <input class="${fieldClasses()}" name="title" value="${escapeHtml(subtask.title)}" placeholder="Subtask title\u2026" required ${isMutating ? "disabled" : ""} />
            </label>
            <label class="grid gap-2">
              <span class="${sectionLabelClasses()}">Description</span>
              <textarea class="${fieldClasses()} min-h-[144px]" name="description" rows="5" placeholder="Subtask description\u2026" ${isMutating ? "disabled" : ""}>${escapeHtml(subtask.description)}</textarea>
            </label>
            <label class="grid gap-2">
              <span class="${sectionLabelClasses()}">Status</span>
              ${renderStatusSelect("status", subtask.status, isMutating)}
            </label>
            <div class="board-modal__actions mt-2 flex flex-wrap justify-end gap-3">
              <button type="button" class="${buttonClasses()}" data-close-subtask aria-label="Cancel editing">Cancel</button>
              <button type="submit" class="${buttonClasses({ kind: "primary" })}" ${isMutating ? "disabled" : ""}>Save subtask</button>
            </div>
          </form>
        </div>
      </section>
    </div>
  `;
}

/**
 * SubtaskModal component — preserves form state across updates.
 */
export function createSubtaskModal() {
  let container = null;
  let currentSubtaskId = null;

  return {
    mount(el) {
      container = el;
      return this;
    },

    /**
     * @param {{ subtask: object|null, isMutating: boolean } | null} props
     */
    update(props) {
      if (!container) return;

      if (!props || !props.subtask) {
        if (currentSubtaskId) {
          container.innerHTML = "";
          currentSubtaskId = null;
        }
        return;
      }

      if (currentSubtaskId === props.subtask.id) {
        preserveFormState(container, () => {
          container.innerHTML = render(props);
        });
      } else {
        container.innerHTML = render(props);
        currentSubtaskId = props.subtask.id;
      }
    },

    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      currentSubtaskId = null;
    },
  };
}
