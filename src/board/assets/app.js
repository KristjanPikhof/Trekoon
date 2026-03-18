import { createBoardActions } from "./state/actions.js";
import { createApi } from "./state/api.js";
import { applyTheme, createStore, readThemePreference } from "./state/store.js";
import { normalizeSnapshot, normalizeStatus } from "./state/utils.js";
import { syncUrlHash } from "./state/url.js";
import { createDelegation } from "./runtime/delegation.js";
import { createTopBar } from "./components/TopBar.js";
import { createWorkspace } from "./components/Workspace.js";
import { createTaskModal } from "./components/TaskModal.js";
import { createSubtaskModal } from "./components/SubtaskModal.js";
import { createNotice } from "./components/Notice.js";
import { createConfirmDialog } from "./components/ConfirmDialog.js";
import { createEpicsOverview } from "./components/EpicsOverview.js";
import { panelClasses, renderIcon, sectionLabelClasses, escapeHtml } from "./components/helpers.js";

const SESSION_TOKEN_STORAGE_KEY = "trekoon-board-session-token";
const SEARCH_FOCUS_KEYS = new Set(["/", "s"]);
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

// ---------------------------------------------------------------------------
// Session token management
// ---------------------------------------------------------------------------

function readSessionTokenFromStorage() {
  try {
    return (sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY) || "").trim();
  } catch {
    return "";
  }
}

function persistSessionToken(token) {
  try {
    sessionStorage.setItem(SESSION_TOKEN_STORAGE_KEY, token);
    return true;
  } catch {
    return false;
  }
}

function resolveRuntimeSession() {
  const url = new URL(window.location.href);
  const queryToken = (url.searchParams.get("token") || "").trim();
  if (queryToken.length > 0) {
    return { token: queryToken, shouldScrubAddressBar: persistSessionToken(queryToken) };
  }
  return { token: readSessionTokenFromStorage(), shouldScrubAddressBar: false };
}

function scrubTokenFromAddressBar() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("token") || typeof window.history?.replaceState !== "function") return;
  url.searchParams.delete("token");
  window.history.replaceState(window.history.state, document.title, `${url.pathname}${url.search}${url.hash}` || "/");
}

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getScrollBehavior() {
  return prefersReducedMotion() ? "auto" : "smooth";
}

function isFocusableElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  if (element.hidden) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (element.closest("[hidden], [inert]")) return false;
  return element.getClientRects().length > 0;
}

function getFocusableElements(container) {
  if (!(container instanceof HTMLElement)) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isFocusableElement);
}

function readJsonScript(scriptId) {
  const script = document.getElementById(scriptId);
  if (!script) return null;
  try {
    return JSON.parse(script.textContent || "null");
  } catch (error) {
    throw new Error(`Failed to parse ${scriptId}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Board shell layout
// ---------------------------------------------------------------------------

function createBoardShell(appElement) {
  appElement.innerHTML = `
    <div class="board-layout mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6 xl:px-8" id="board-shell">
      <div data-slot="notice"></div>
      <div data-slot="topbar"></div>
      <div data-slot="epics-overview"></div>
      <div data-slot="tasks-root" class="board-root board-root--tasks min-h-0 w-full" style="display:none">
        <div data-slot="workspace"></div>
      </div>
      <div data-slot="task-modal"></div>
      <div data-slot="subtask-modal"></div>
      <div data-slot="confirm-dialog"></div>
    </div>
  `;

  const slot = (name) => appElement.querySelector(`[data-slot="${name}"]`);
  return {
    notice: slot("notice"),
    topbar: slot("topbar"),
    epicsOverview: slot("epics-overview"),
    tasksRoot: slot("tasks-root"),
    workspace: slot("workspace"),
    taskModal: slot("task-modal"),
    subtaskModal: slot("subtask-modal"),
    confirmDialog: slot("confirm-dialog"),
    shell: appElement.querySelector("#board-shell"),
  };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export async function bootLegacyBoard(options = {}) {
  const appElement = options.mountElement instanceof HTMLElement
    ? options.mountElement
    : document.querySelector("#app");

  if (!(appElement instanceof HTMLElement)) {
    throw new Error("Board runtime could not find its mount element.");
  }

  try {
    applyTheme(readThemePreference());
    const runtimeSession = resolveRuntimeSession();
    if (runtimeSession.shouldScrubAddressBar) scrubTokenFromAddressBar();

    // Fetch snapshot
    let snapshotPayload = readJsonScript("trekoon-board-snapshot") ?? {};
    if (runtimeSession.token.length > 0) {
      const headers = new Headers();
      headers.set("authorization", `Bearer ${runtimeSession.token}`);
      const response = await fetch("/api/snapshot", { headers });
      const payload = await response.json();
      if (!payload?.ok) throw new Error(payload?.error?.message || "Board request failed");
      snapshotPayload = payload?.data?.snapshot ?? {};
    }

    const snapshot = normalizeSnapshot(snapshotPayload);

    // Empty board
    if (snapshot.epics.length === 0 && snapshot.tasks.length === 0) {
      appElement.innerHTML = `
        <section class="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10 sm:px-6">
          <div class="${panelClasses("w-full p-8 text-center")}">
            <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--board-accent-soft)] text-[var(--board-accent)] ring-1 ring-[var(--board-border-strong)]">
              ${renderIcon("inventory_2", "text-[22px]")}
            </div>
            <span class="${sectionLabelClasses()}">Board ready</span>
            <h1 class="mt-2 text-3xl font-semibold tracking-tight text-[var(--board-text)]">No work has been published yet</h1>
            <p class="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[var(--board-text-muted)] sm:text-base">Once the board snapshot is installed into <code class="rounded-lg border border-[var(--board-border)] bg-white/[0.04] px-2 py-1 text-[var(--board-text)]">.trekoon/board</code>, epics and tasks will appear here.</p>
          </div>
        </section>
      `;
      return;
    }

    // Create store and API
    const model = createStore(snapshot, { normalizeSnapshot });
    const slots = createBoardShell(appElement);

    // Mount components
    const topBar = createTopBar().mount(slots.topbar);
    const workspace = createWorkspace().mount(slots.workspace);
    const taskModal = createTaskModal().mount(slots.taskModal);
    const subtaskModal = createSubtaskModal().mount(slots.subtaskModal);
    const notice = createNotice().mount(slots.notice);
    const confirmDialog = createConfirmDialog().mount(slots.confirmDialog);
    const epicsOverview = createEpicsOverview().mount(slots.epicsOverview);

    // Pending confirm state for destructive actions
    let pendingConfirm = null;
    let activeOverlay = null;
    let overlayOpener = null;
    let restoreFocusPending = false;
    let previousBodyOverflow = "";
    let previousBodyPaddingRight = "";
    let scrollLockDepth = 0;

    const backgroundSlots = [
      slots.notice,
      slots.topbar,
      slots.epicsOverview,
      slots.tasksRoot,
    ];

    function setOverlayOpener(candidate) {
      overlayOpener = candidate instanceof HTMLElement ? candidate : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }

    function restoreOverlayFocus() {
      if (!restoreFocusPending) return;
      restoreFocusPending = false;
      if (overlayOpener instanceof HTMLElement && overlayOpener.isConnected && !overlayOpener.closest("[inert]")) {
        overlayOpener.focus({ preventScroll: true });
      }
      overlayOpener = null;
    }

    function lockBackgroundScroll() {
      if (scrollLockDepth > 0) {
        scrollLockDepth += 1;
        return;
      }
      previousBodyOverflow = document.body.style.overflow;
      previousBodyPaddingRight = document.body.style.paddingRight;
      const scrollbarWidth = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
      document.documentElement.classList.add("board-scroll-locked");
      document.body.classList.add("board-scroll-locked");
      document.body.style.overflow = "hidden";
      if (scrollbarWidth > 0) document.body.style.paddingRight = `${scrollbarWidth}px`;
      scrollLockDepth = 1;
    }

    function unlockBackgroundScroll() {
      if (scrollLockDepth === 0) return;
      scrollLockDepth -= 1;
      if (scrollLockDepth > 0) return;
      document.documentElement.classList.remove("board-scroll-locked");
      document.body.classList.remove("board-scroll-locked");
      document.body.style.overflow = previousBodyOverflow;
      document.body.style.paddingRight = previousBodyPaddingRight;
    }

    function setBackgroundInert(isInert) {
      for (const slot of backgroundSlots) {
        if (!(slot instanceof HTMLElement)) continue;
        if (isInert) {
          slot.inert = true;
          slot.setAttribute("aria-hidden", "true");
        } else {
          slot.inert = false;
          slot.removeAttribute("aria-hidden");
        }
      }
    }

    function getActiveOverlayElement() {
      return slots.confirmDialog.querySelector("[data-overlay-root]")
        || slots.subtaskModal.querySelector("[data-overlay-root]")
        || slots.taskModal.querySelector("[data-overlay-root]")
        || null;
    }

    function focusOverlay(overlay) {
      if (!(overlay instanceof HTMLElement)) return;
      const autofocusTarget = overlay.querySelector("[data-overlay-initial-focus]");
      if (autofocusTarget instanceof HTMLElement && isFocusableElement(autofocusTarget)) {
        autofocusTarget.focus({ preventScroll: true });
        return;
      }
      overlay.focus({ preventScroll: true });
    }

    function syncOverlayEnvironment() {
      const hadOverlay = activeOverlay instanceof HTMLElement;
      const nextOverlay = getActiveOverlayElement();
      if (nextOverlay === activeOverlay) {
        return;
      }

      if (nextOverlay) {
        activeOverlay = nextOverlay;
        if (!hadOverlay) {
          lockBackgroundScroll();
          setBackgroundInert(true);
        }
        queueMicrotask(() => focusOverlay(nextOverlay));
        return;
      }

      activeOverlay = null;
      if (hadOverlay) {
        unlockBackgroundScroll();
        setBackgroundInert(false);
      }
      queueMicrotask(() => restoreOverlayFocus());
    }

    function trapOverlayFocus(event) {
      if (event.key !== "Tab" || !(activeOverlay instanceof HTMLElement)) return;
      const focusableElements = getFocusableElements(activeOverlay);
      if (focusableElements.length === 0) {
        event.preventDefault();
        activeOverlay.focus({ preventScroll: true });
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const current = document.activeElement;

      if (event.shiftKey) {
        if (current === first || !activeOverlay.contains(current)) {
          event.preventDefault();
          last.focus({ preventScroll: true });
        }
        return;
      }

      if (current === last || !activeOverlay.contains(current)) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    }

    function containOverlayFocus(event) {
      if (!(activeOverlay instanceof HTMLElement)) return;
      if (activeOverlay.contains(event.target)) return;
      const [firstFocusable] = getFocusableElements(activeOverlay);
      (firstFocusable || activeOverlay).focus({ preventScroll: true });
    }

    function closeTopmostDisclosure() {
      const openDetails = Array.from(document.querySelectorAll("details[open]"))
        .filter((element) => !element.closest("[data-overlay-root]"));
      const topmost = openDetails.at(-1);
      if (!(topmost instanceof HTMLDetailsElement)) {
        return false;
      }

      topmost.open = false;
      const summary = topmost.querySelector("summary");
      if (summary instanceof HTMLElement) {
        summary.focus({ preventScroll: true });
      }
      return true;
    }

    function dismissSearch(boardState, activeElement) {
      const searchInput = document.querySelector("#board-search-input");
      if (!(searchInput instanceof HTMLInputElement)) {
        return false;
      }

      const searchHasValue = boardState.search.trim().length > 0;
      const searchIsFocused = activeElement === searchInput;
      if (!searchHasValue && !searchIsFocused) {
        return false;
      }

      if (searchHasValue) {
        actions.updateSearch("");
      }

      searchInput.blur();
      return true;
    }

    document.addEventListener("keydown", trapOverlayFocus, true);
    document.addEventListener("focusin", containOverlayFocus, true);

    // Render cycle
    function rerender() {
      const store = model.store;
      const boardState = model.getBoardState();
      const screen = boardState.screen;
      const selectedTask = boardState.selectedTask;
      const selectedSubtask = boardState.selectedSubtask;
      const currentNav = selectedTask ? "detail" : screen === "tasks" ? "board" : "epics";

      // Layout toggles
      const showTasks = screen === "tasks" && boardState.selectedEpic;
      slots.epicsOverview.style.display = showTasks ? "none" : "";
      slots.tasksRoot.style.display = showTasks ? "" : "none";

      if (showTasks) {
        slots.tasksRoot.className = "board-root board-root--tasks min-h-0 w-full";
      }

      slots.shell.className = `board-layout ${screen === "tasks" ? "board-layout--workspace" : "board-layout--overview"} mx-auto flex w-full max-w-[1600px] flex-col gap-4 px-4 py-4 sm:px-6 sm:py-6 xl:px-8 ${screen === "tasks" ? "min-h-0" : "min-h-screen"}`;

      // Update components
      topBar.update({
        currentNav,
        screen,
        search: store.search,
        searchScope: boardState.searchScope,
        selectedEpic: boardState.selectedEpic,
        theme: store.theme,
        isMutating: store.isMutating,
      });

      notice.update({
        notice: store.notice,
        onDismiss() { store.notice = null; rerender(); },
      });

      if (showTasks) {
        workspace.update({
          selectedEpic: boardState.selectedEpic,
          selectedTask,
          searchScope: boardState.searchScope,
          snapshotEpics: store.snapshot.epics,
          store,
          visibleTasks: boardState.visibleTasks,
        });

        taskModal.update(selectedTask ? {
          task: selectedTask,
          epics: store.snapshot.epics,
          snapshot: store.snapshot,
          isMutating: store.isMutating,
        } : null);
      } else {
        epicsOverview.update({
          visibleEpics: boardState.visibleEpics,
          selectedEpicId: boardState.selectedEpicId,
          store,
        });
      }

      subtaskModal.update(selectedSubtask ? {
        subtask: selectedSubtask,
        isMutating: store.isMutating,
      } : null);

      syncOverlayEnvironment();
    }

    const api = createApi(model, { sessionToken: runtimeSession.token, rerender });

    // Actions for delegation
    const actions = createBoardActions({
      model,
      api,
      rerender,
      normalizeSnapshot,
      normalizeStatus,
      applyTheme,
      closeTopmostDisclosure,
      dismissSearch,
      hasOpenOverlay: () => activeOverlay instanceof HTMLElement,
      closeActiveOverlay: () => {
        if (pendingConfirm) {
          restoreFocusPending = true;
          pendingConfirm = null;
          confirmDialog.update(null);
          syncOverlayEnvironment();
          return;
        }

        if (model.getBoardState().selectedSubtaskId) {
          restoreFocusPending = true;
          actions.closeSubtask();
          return;
        }

        if (model.getBoardState().selectedTaskId) {
          restoreFocusPending = true;
          actions.closeTask();
        }
      },
      focusSearch: () => document.querySelector("#board-search-input")?.focus({ preventScroll: true }),
      focusTaskDetail: () => document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: getScrollBehavior() }),
      searchFocusKeys: SEARCH_FOCUS_KEYS,
    });

    // Event delegation
    createDelegation(appElement, {
      isMutating: () => model.store.isMutating,
      deleteSubtask: (id, opener) => {
        setOverlayOpener(opener);
        pendingConfirm = { action: () => actions.deleteSubtask(id), title: "Remove subtask", message: "This subtask will be permanently removed. Are you sure?" };
        confirmDialog.update({ open: true, title: pendingConfirm.title, message: pendingConfirm.message, confirmLabel: "Remove", cancelLabel: "Cancel", tone: "destructive" });
        syncOverlayEnvironment();
      },
      removeDependency: (src, dep, opener) => {
        setOverlayOpener(opener);
        pendingConfirm = { action: () => actions.removeDependency(src, dep), title: "Remove dependency", message: "This dependency link will be removed. Are you sure?" };
        confirmDialog.update({ open: true, title: pendingConfirm.title, message: pendingConfirm.message, confirmLabel: "Remove", cancelLabel: "Cancel", tone: "destructive" });
        syncOverlayEnvironment();
      },
      openSubtask: (id, opener) => {
        setOverlayOpener(opener);
        actions.openSubtask(id);
      },
      closeSubtask: () => {
        restoreFocusPending = true;
        actions.closeSubtask();
      },
      closeTask: () => {
        restoreFocusPending = true;
        actions.closeTask();
      },
      showEpics: () => actions.showEpics(),
      showBoard: () => actions.showBoard(),
      scrollToDetail: () => document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: getScrollBehavior() }),
      setView: (view) => actions.setView(view),
      toggleTheme: () => actions.toggleTheme(),
      toggleNotesPanel: () => actions.toggleNotesPanel(),
      confirmDelete: () => {
        if (pendingConfirm) {
          restoreFocusPending = true;
          pendingConfirm.action();
          pendingConfirm = null;
          confirmDialog.update(null);
          syncOverlayEnvironment();
        }
      },
      cancelDelete: () => {
        restoreFocusPending = true;
        pendingConfirm = null;
        confirmDialog.update(null);
        syncOverlayEnvironment();
      },
      openEpic: (id) => actions.openEpic(id),
      selectEpic: (id) => actions.selectEpic(id),
      selectTask: (id, opener) => {
        setOverlayOpener(opener);
        actions.selectTask(id);
      },
      updateSearch: (value) => actions.updateSearch(value),
      submitTaskForm: (id, data) => actions.submitTaskForm(id, data),
      submitSubtaskForm: (id, data) => actions.submitSubtaskForm(id, data),
      submitCreateSubtask: (id, data) => actions.submitCreateSubtask(id, data),
      addDependency: (src, data) => actions.addDependency(src, data),
      dropTaskStatus: (id, status) => actions.dropTaskStatus(id, status),
      changeEpicStatus: (epicId, status) => actions.changeEpicStatus(epicId, status),
      bulkSetStatus: (epicId, status) => actions.bulkSetStatus(epicId, status),
      handleKeydown: (event) => actions.handleKeydown(event),
    });

    // URL hash sync
    syncUrlHash(model, { onRestore: rerender });

    // Initial render
    applyTheme(model.store.theme);
    rerender();
  } catch (error) {
    appElement.innerHTML = `
      <section class="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-4 py-10 sm:px-6">
        <div class="${panelClasses("w-full p-8 text-center")}">
          <div class="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-red-500/10 text-red-300 ring-1 ring-red-500/20">
            ${renderIcon("warning", "text-[22px]")}
          </div>
          <span class="${sectionLabelClasses()}">Board error</span>
          <h1 class="mt-2 text-3xl font-semibold tracking-tight text-[var(--board-text)]">Could not load the board snapshot</h1>
          <p class="mx-auto mt-3 max-w-2xl text-sm leading-6 text-[var(--board-text-muted)] sm:text-base">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>
        </div>
      </section>
    `;
  }
}

if (window.__TREKOON_BOARD_BOOTSTRAP__ !== "main") {
  void bootLegacyBoard();
}
