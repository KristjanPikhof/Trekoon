import { listBoardAssetFamilies } from "./assetMap.js";

export function createBoardShellComponent() {
  return {
    data() {
      return {
        assetFamilies: listBoardAssetFamilies(),
      };
    },
    template: `
      <div class="board-shell-v2">
        <section class="board-shell-v2__frame">
          <div class="board-shell-v2__runtime-shell">
            <div
              id="board-runtime-root"
              class="board-shell-v2__runtime"
              data-board-runtime-root
            ></div>
          </div>
          <header class="board-shell-v2__header">
            <div class="board-shell-v2__intro">
              <p class="board-shell-v2__eyebrow">Trekoon board runtime</p>
              <div class="board-shell-v2__title-row">
                <h1 class="board-shell-v2__title">Zero-build component shell</h1>
                <span class="board-shell-v2__badge">CDN runtime</span>
              </div>
              <p class="board-shell-v2__summary">
                Compact shell chrome for the local board runtime, shared tokens,
                and the compatibility mount for the legacy workspace.
              </p>
            </div>
            <details class="board-shell-v2__ownership">
              <summary>Asset ownership</summary>
              <div class="board-shell-v2__chip-list" aria-label="Board asset ownership">
                <span
                  v-for="assetFamily in assetFamilies"
                  :key="assetFamily.family"
                  class="board-shell-v2__chip"
                >
                  {{ assetFamily.family }} · {{ assetFamily.owner }}
                </span>
              </div>
            </details>
          </header>
        </section>
      </div>
    `,
  };
}
