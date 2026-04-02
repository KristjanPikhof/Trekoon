import {
  escapeHtml,
  renderCheckIcon,
  renderIcon,
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
     * @param {{ notice: { type: string, message: string, title?: string, retryLabel?: string } | null, onDismiss?: () => void, onRetry?: () => void }} props
     */
    update(props) {
      if (!container) return;
      const { notice, onDismiss, onRetry } = props;

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

      const noticeTitle = typeof notice.title === "string" && notice.title.trim().length > 0
        ? notice.title.trim()
        : notice.type === "error"
          ? "Action blocked"
          : "Saved";

      container.innerHTML = `
        <div class="board-toast-region" role="presentation">
          <section class="board-toast board-toast--${notice.type === "error" ? "error" : "success"}" role="${notice.type === "error" ? "alert" : "status"}" aria-live="${notice.type === "error" ? "assertive" : "polite"}" aria-atomic="true">
            <div class="board-toast__icon ${notice.type === "error" ? "board-toast__icon--error" : "board-toast__icon--success"}">
              ${notice.type === "error" ? renderIcon("warning") : renderCheckIcon()}
            </div>
            <div class="board-toast__content">
              <p class="board-toast__title" id="board-notice-title">${escapeHtml(noticeTitle)}</p>
              <p class="board-toast__message">${escapeHtml(notice.message)}</p>
              ${typeof notice.retryLabel === "string" && notice.retryLabel.trim().length > 0
    ? `<button type="button" class="mt-3 inline-flex items-center gap-2 rounded-lg border border-[var(--board-border-strong)] bg-[var(--board-surface-2)] px-3 py-2 text-sm font-medium text-[var(--board-text)] transition hover:border-[var(--board-accent)] hover:text-[var(--board-accent)]" data-board-notice-retry>${escapeHtml(notice.retryLabel.trim())}</button>`
    : ""}
            </div>
          </section>
        </div>
      `;
      lastNotice = { type: notice.type, message: notice.message };

      // Auto-dismiss after 4 s
      clearTimer();
      const retryButton = typeof container.querySelector === "function"
        ? container.querySelector("[data-board-notice-retry]")
        : null;
      if (retryButton && typeof retryButton.addEventListener === "function" && typeof onRetry === "function") {
        retryButton.addEventListener("click", onRetry, { once: true });
      }
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
