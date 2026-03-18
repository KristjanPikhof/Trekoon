import { createBoardActions } from "./state/actions.js";
import { createApi } from "./state/api.js";
import { applyTheme, createStore, readThemePreference } from "./state/store.js";
import { normalizeSnapshot, normalizeStatus } from "./state/utils.js";
import { syncUrlHash } from "./state/url.js";
import { createDelegation } from "./runtime/delegation.js";
import { createTopBar } from "./components/TopBar.js";
import { createSidebar } from "./components/Sidebar.js";
import { createWorkspace } from "./components/Workspace.js";
import { createInspector } from "./components/Inspector.js";
import { createTaskModal } from "./components/TaskModal.js";
import { createSubtaskModal } from "./components/SubtaskModal.js";
import { createNotice } from "./components/Notice.js";
import { createConfirmDialog } from "./components/ConfirmDialog.js";
import { createEpicsOverview } from "./components/EpicsOverview.js";
import { isCompactViewport, shouldUseTaskModal, panelClasses, renderIcon, sectionLabelClasses, escapeHtml } from "./components/helpers.js";

const SESSION_TOKEN_STORAGE_KEY = "trekoon-board-session-token";
const SEARCH_FOCUS_KEYS = new Set(["/", "s"]);

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
      <div data-slot="tasks-root" class="board-root board-root--tasks min-h-0 w-full grid gap-4 xl:gap-5" style="display:none">
        <div data-slot="sidebar"></div>
        <div data-slot="workspace"></div>
        <div data-slot="inspector" class="board-panel board-drawer board-detail-surface-frame"></div>
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
    sidebar: slot("sidebar"),
    workspace: slot("workspace"),
    inspector: slot("inspector"),
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
    const sidebar = createSidebar().mount(slots.sidebar);
    const workspace = createWorkspace().mount(slots.workspace);
    const inspector = createInspector().mount(slots.inspector);
    const taskModal = createTaskModal().mount(slots.taskModal);
    const subtaskModal = createSubtaskModal().mount(slots.subtaskModal);
    const notice = createNotice().mount(slots.notice);
    const confirmDialog = createConfirmDialog().mount(slots.confirmDialog);
    const epicsOverview = createEpicsOverview().mount(slots.epicsOverview);

    // Pending confirm state for destructive actions
    let pendingConfirm = null;

    // Render cycle
    function rerender() {
      const store = model.store;
      const boardState = model.getBoardState();
      const screen = boardState.screen;
      const selectedTask = boardState.selectedTask;
      const selectedSubtask = boardState.selectedSubtask;
      const useModal = shouldUseTaskModal(boardState, store);
      const currentNav = selectedTask ? "detail" : screen === "tasks" ? "board" : "epics";

      // Layout toggles
      const showTasks = screen === "tasks" && boardState.selectedEpic;
      slots.epicsOverview.style.display = showTasks ? "none" : "";
      slots.tasksRoot.style.display = showTasks ? "" : "none";

      if (showTasks) {
        const hasInspector = selectedTask && !useModal;
        slots.tasksRoot.className = `board-root ${hasInspector ? "board-root--tasks board-root--detail board-root--detail-open has-detail" : "board-root--tasks"} min-h-0 w-full grid gap-4 xl:gap-5`;
        slots.inspector.style.display = hasInspector ? "" : "none";
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
      });

      notice.update({
        notice: store.notice,
        onDismiss() { store.notice = null; rerender(); },
      });

      if (showTasks) {
        sidebar.update({ sidebarEpics: boardState.sidebarEpics, selectedEpicId: boardState.selectedEpicId });
        workspace.update({
          selectedEpic: boardState.selectedEpic,
          selectedTask,
          searchScope: boardState.searchScope,
          snapshotEpics: store.snapshot.epics,
          store,
          visibleTasks: boardState.visibleTasks,
        });

        inspector.update(selectedTask && !useModal ? {
          task: selectedTask,
          epics: store.snapshot.epics,
          snapshot: store.snapshot,
          isMutating: store.isMutating,
        } : null);

        taskModal.update(useModal && selectedTask ? {
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

      // Overlay scroll lock
      document.documentElement.style.overflow = (useModal || selectedSubtask) ? "hidden" : "";
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
      closeTopmostDisclosure: () => false,
      dismissSearch: () => false,
      focusSearch: () => document.querySelector("#board-search-input")?.focus({ preventScroll: true }),
      focusTaskDetail: () => document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      searchFocusKeys: SEARCH_FOCUS_KEYS,
    });

    // Event delegation
    createDelegation(appElement, {
      isMutating: () => model.store.isMutating,
      deleteSubtask: (id) => actions.deleteSubtask(id),
      removeDependency: (src, dep) => actions.removeDependency(src, dep),
      openSubtask: (id) => actions.openSubtask(id),
      closeSubtask: () => actions.closeSubtask(),
      closeTask: () => actions.closeTask(),
      showEpics: () => actions.showEpics(),
      showBoard: () => actions.showBoard(),
      scrollToDetail: () => document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      setView: (view) => actions.setView(view),
      toggleTheme: () => actions.toggleTheme(),
      confirmDelete: () => {},
      cancelDelete: () => {},
      openEpic: (id) => actions.openEpic(id),
      selectEpic: (id) => actions.selectEpic(id),
      selectTask: (id) => actions.selectTask(id),
      updateSearch: (value) => actions.updateSearch(value),
      submitTaskForm: (id, data) => actions.submitTaskForm(id, data),
      submitSubtaskForm: (id, data) => actions.submitSubtaskForm(id, data),
      submitCreateSubtask: (id, data) => actions.submitCreateSubtask(id, data),
      addDependency: (src, data) => actions.addDependency(src, data),
      dropTaskStatus: (id, status) => actions.dropTaskStatus(id, status),
      handleKeydown: (event) => actions.handleKeydown(event),
    });

    // URL hash sync
    syncUrlHash(model);

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
