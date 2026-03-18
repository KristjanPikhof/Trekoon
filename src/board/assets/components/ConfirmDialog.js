import {
  buttonClasses,
  escapeHtml,
  panelClasses,
  renderIcon,
  sectionLabelClasses,
} from "./helpers.js";

/**
 * ConfirmDialog component — modal for destructive actions.
 * Shows confirmation with cancel/confirm buttons before executing.
 */
export function createConfirmDialog() {
  let container = null;
  let lastProps = null;

  return {
    mount(el) {
      container = el;
      return this;
    },

    /**
     * @param {{
     *   open: boolean,
     *   title?: string,
     *   message?: string,
     *   confirmLabel?: string,
     *   cancelLabel?: string,
     * } | null} props
     */
    update(props) {
      if (!container) return;

      if (!props || !props.open) {
        if (lastProps?.open) {
          container.innerHTML = "";
        }
        lastProps = props;
        return;
      }

      const {
        title = "Confirm action",
        message = "This action cannot be undone. Are you sure?",
        confirmLabel = "Confirm",
        cancelLabel = "Cancel",
      } = props;

      container.innerHTML = `
        <div class="fixed inset-0 z-50 grid place-items-center bg-slate-950/70 p-4 backdrop-blur-md" data-action="cancel-delete" role="presentation">
          <section class="${panelClasses("w-full max-w-md p-6")}" role="alertdialog" aria-modal="true" aria-labelledby="confirm-dialog-title" aria-describedby="confirm-dialog-desc">
            <div class="flex items-start gap-4">
              <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-red-500/10 text-red-300 ring-1 ring-red-500/20">
                ${renderIcon("warning", "text-[20px]")}
              </div>
              <div class="min-w-0">
                <p class="${sectionLabelClasses()}">Destructive action</p>
                <h3 id="confirm-dialog-title" class="mt-2 text-lg font-semibold text-[var(--board-text)]">${escapeHtml(title)}</h3>
                <p id="confirm-dialog-desc" class="mt-2 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(message)}</p>
              </div>
            </div>
            <div class="mt-6 flex justify-end gap-3">
              <button type="button" class="${buttonClasses()}" data-action="cancel-delete">${escapeHtml(cancelLabel)}</button>
              <button type="button" class="${buttonClasses({ kind: "primary" })}" data-action="confirm-delete" autofocus>${escapeHtml(confirmLabel)}</button>
            </div>
          </section>
        </div>
      `;
      lastProps = props;
    },

    unmount() {
      if (container) container.innerHTML = "";
      container = null;
      lastProps = null;
    },
  };
}
