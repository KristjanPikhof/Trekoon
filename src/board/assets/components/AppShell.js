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
          <header class="board-shell-v2__header">
            <div>
              <p class="board-shell-v2__eyebrow">Trekoon board runtime</p>
              <h1 class="board-shell-v2__title">Zero-build component shell</h1>
              <p class="board-shell-v2__summary">
                The shell owns CDN bootstrap, shared design tokens, and the
                compatibility mount for the legacy board runtime.
              </p>
            </div>
            <div class="board-shell-v2__chip-list" aria-label="Board asset ownership">
              <span
                v-for="assetFamily in assetFamilies"
                :key="assetFamily.family"
                class="board-shell-v2__chip"
              >
                {{ assetFamily.family }} · {{ assetFamily.owner }}
              </span>
            </div>
          </header>
          <div
            id="board-runtime-root"
            class="board-shell-v2__runtime"
            data-board-runtime-root
          ></div>
        </section>
      </div>
    `,
  };
}
