import { createApp } from "https://esm.sh/vue@3.5.13";

import { createBoardShellComponent } from "./components/AppShell.js";

window.__TREKOON_BOARD_BOOTSTRAP__ = "main";

const shellApp = createApp(createBoardShellComponent());
shellApp.mount("#app");

const runtimeRoot = document.querySelector("[data-board-runtime-root]");

if (!(runtimeRoot instanceof HTMLElement)) {
  throw new Error("Board shell could not find the runtime mount root.");
}

const { bootLegacyBoard } = await import("./app.js");

await bootLegacyBoard({
  mountElement: runtimeRoot,
});
