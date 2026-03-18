import { preserveFormState, preserveDetailsState } from "./Component.js";
import { renderTaskSurface } from "./Inspector.js";
import {
  isCompactViewport,
  panelClasses,
} from "./helpers.js";

/**
 * TaskModal component — full-screen backdrop modal for task detail.
 * Preserves form state across updates within the same task.
 */
export function createTaskModal() {
  let container = null;
  let currentTaskId = null;

  function render(props) {
    const { task, epics, snapshot, isMutating = false } = props;
    const compact = isCompactViewport();

    const surfaceOptions = {
      titleId: "board-task-modal-title",
      closeLabel: compact ? "Back to board" : "Close",
      containerClassName: "board-detail-surface board-detail-surface--modal",
      detailEyebrow: compact ? "Task focus mode" : "Task detail",
      scrollSurface: "task-modal",
    };

    return `
      <div class="board-task-modal-backdrop fixed inset-0 z-30 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-md" data-close-task>
        <section class="board-task-modal ${panelClasses("grid max-h-[calc(100dvh-2rem)] w-full grid-rows-[1fr] overflow-hidden p-5 sm:p-6")}" role="dialog" aria-modal="true" aria-labelledby="board-task-modal-title">
          <div class="h-full min-h-0">
            ${renderTaskSurface({ task, epics, snapshot, isMutating, options: surfaceOptions })}
          </div>
        </section>
      </div>
    `;
  }

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

      if (currentTaskId === props.task.id) {
        preserveDetailsState(container, () => {
          preserveFormState(container, () => {
            container.innerHTML = render(props);
          });
        });
      } else {
        container.innerHTML = render(props);
        currentTaskId = props.task.id;
      }
    },

    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      currentTaskId = null;
    },
  };
}
