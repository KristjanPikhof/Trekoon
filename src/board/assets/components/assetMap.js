export const BOARD_SHARED_TOKENS = {
  theme: "src/board/assets/styles/board.css",
  shell: "src/board/assets/components/AppShell.js",
  bootstrap: "src/board/assets/main.js",
  legacyRuntime: "src/board/assets/app.js",
};

export const BOARD_ASSET_MAP = {
  shell: {
    entry: "src/board/assets/main.js",
    files: [
      "src/board/assets/index.html",
      "src/board/assets/main.js",
      "src/board/assets/styles/board.css",
      "src/board/assets/components/AppShell.js",
      "src/board/assets/components/assetMap.js",
    ],
    owner: "board-runtime",
    description: "Zero-build CDN entry shell and runtime handoff.",
  },
  overview: {
    files: ["src/board/assets/components/EpicsOverview.js", "src/board/assets/components/EpicRow.js", "src/board/assets/components/ClampedText.js"],
    owner: "overview-lane",
    description: "Epic list density, overview rows, and long-copy disclosure.",
  },
  workspace: {
    files: [
      "src/board/assets/components/TaskWorkspace.js",
      "src/board/assets/components/KanbanBoard.js",
      "src/board/assets/components/KanbanColumn.js",
      "src/board/assets/components/TaskCard.js",
      "src/board/assets/components/TaskList.js",
      "src/board/assets/components/TaskListRow.js",
    ],
    owner: "workspace-lane",
    description: "Task browsing surfaces and drag-friendly work views.",
  },
  detail: {
    files: [
      "src/board/assets/components/TaskInspector.js",
      "src/board/assets/components/TaskModal.js",
      "src/board/assets/components/SubtaskModal.js",
      "src/board/assets/components/DependencyList.js",
      "src/board/assets/components/SubtaskList.js",
    ],
    owner: "detail-lane",
    description: "Task and subtask detail surfaces, forms, and disclosures.",
  },
  state: {
    files: [
      "src/board/assets/state/store.js",
      "src/board/assets/state/actions.js",
      "src/board/assets/state/api.js",
    ],
    owner: "state-lane",
    description: "Snapshot normalization, persistence, mutations, and API wiring.",
  },
};

export function listBoardAssetFamilies() {
  return Object.entries(BOARD_ASSET_MAP).map(([family, value]) => ({
    family,
    ...value,
  }));
}
