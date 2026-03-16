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
        </section>
      </div>
    `,
  };
}
