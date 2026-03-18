export const BOARD_SHARED_TOKENS = {
  theme: "src/board/assets/styles/board.css",
  fonts: "src/board/assets/styles/fonts.css",
  bootstrap: "src/board/assets/main.js",
  legacyRuntime: "src/board/assets/app.js",
};

export const BOARD_ASSET_MAP = {
  shell: {
    entry: "src/board/assets/main.js",
    files: [
      "src/board/assets/index.html",
      "src/board/assets/main.js",
      "src/board/assets/app.js",
      "src/board/assets/styles/board.css",
      "src/board/assets/styles/fonts.css",
      "src/board/assets/fonts/inter-latin.woff2",
      "src/board/assets/fonts/material-symbols-rounded.woff2",
      "src/board/assets/components/assetMap.js",
      "src/board/assets/components/helpers.js",
      "src/board/assets/components/Component.js",
    ],
    owner: "board-runtime",
    description: "Zero-build CDN entry shell, runtime handoff, and shared helpers.",
  },
  overview: {
    files: [
      "src/board/assets/components/EpicsOverview.js",
      "src/board/assets/components/EpicRow.js",
      "src/board/assets/components/ClampedText.js",
    ],
    owner: "overview-lane",
    description: "Epic list density, overview rows, and long-copy disclosure.",
  },
  workspace: {
    files: [
      "src/board/assets/components/TopBar.js",
      "src/board/assets/components/Workspace.js",
      "src/board/assets/components/TaskCard.js",
      "src/board/assets/components/Notice.js",
    ],
    owner: "workspace-lane",
    description: "Task browsing surfaces, topbar, notices, and drag-friendly work views.",
  },
  detail: {
    files: [
      "src/board/assets/components/Inspector.js",
      "src/board/assets/components/TaskModal.js",
      "src/board/assets/components/SubtaskModal.js",
      "src/board/assets/components/ConfirmDialog.js",
    ],
    owner: "detail-lane",
    description: "Task and subtask detail surfaces, forms, and disclosures.",
  },
  state: {
    files: [
      "src/board/assets/state/store.js",
      "src/board/assets/state/actions.js",
      "src/board/assets/state/api.js",
      "src/board/assets/state/utils.js",
      "src/board/assets/state/url.js",
    ],
    owner: "state-lane",
    description: "Observable store, mutations, API wiring, URL hash sync, and shared utilities.",
  },
  runtime: {
    files: [
      "src/board/assets/runtime/delegation.js",
    ],
    owner: "runtime-lane",
    description: "Event delegation and DOM utility helpers.",
  },
};

export function listBoardAssetFamilies() {
  return Object.entries(BOARD_ASSET_MAP).map(([family, value]) => ({
    family,
    ...value,
  }));
}
