import {
  escapeHtml,
  panelClasses,
  renderIcon,
  sectionLabelClasses,
} from "./helpers.js";

/**
 * Notice component — auto-dismiss after 4 s, aria-live polite.
 */
export function createNotice() {
  let container = null;
  let dismissTimer = null;
  let lastNotice = null;

  function clearTimer() {
    if (dismissTimer !== null) {
      clearTimeout(dismissTimer);
      dismissTimer = null;
    }
  }

  return {
    mount(el) {
      container = el;
      return this;
    },

    /**
     * @param {{ notice: { type: string, message: string } | null, onDismiss?: () => void }} props
     */
    update(props) {
      if (!container) return;
      const { notice, onDismiss } = props;

      if (!notice) {
        if (lastNotice) {
          container.innerHTML = "";
          lastNotice = null;
          clearTimer();
        }
        return;
      }

      // Same notice — skip
      if (lastNotice && lastNotice.type === notice.type && lastNotice.message === notice.message) {
        return;
      }

      container.innerHTML = `
        <section class="${panelClasses("mb-4 flex items-start gap-3 p-4 sm:p-5")}" role="${notice.type === "error" ? "alert" : "status"}" aria-live="${notice.type === "error" ? "assertive" : "polite"}" aria-atomic="true">
          <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${notice.type === "error" ? "bg-red-500/10 text-red-300 ring-1 ring-red-500/20" : "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20"}">
            ${renderIcon(notice.type === "error" ? "warning" : "check_circle", "text-[20px]")}
          </div>
          <div class="min-w-0">
            <p class="${sectionLabelClasses()}" id="board-notice-title">${notice.type === "error" ? "Action blocked" : "Saved"}</p>
            <p class="mt-1 text-sm leading-6 text-[var(--board-text-muted)]">${escapeHtml(notice.message)}</p>
          </div>
        </section>
      `;
      lastNotice = { type: notice.type, message: notice.message };

      // Auto-dismiss after 4 s
      clearTimer();
      if (typeof onDismiss === "function") {
        dismissTimer = setTimeout(() => {
          onDismiss();
          dismissTimer = null;
        }, 4000);
      }
    },

    unmount() {
      clearTimer();
      if (container) container.innerHTML = "";
      container = null;
      lastNotice = null;
    },
  };
}
