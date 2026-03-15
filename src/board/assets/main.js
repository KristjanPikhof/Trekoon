import { createApp, nextTick } from "https://unpkg.com/vue@3.5.13/dist/vue.esm-browser.js";

import { createBoardShellComponent } from "./components/AppShell.js";

window.__TREKOON_BOARD_BOOTSTRAP__ = "main";

const appRoot = document.querySelector("#app");

if (!(appRoot instanceof HTMLElement)) {
  throw new Error("Board shell could not find the app root.");
}

const shellApp = createApp(createBoardShellComponent());
shellApp.mount(appRoot);
await nextTick();

const runtimeRoot = appRoot.querySelector("[data-board-runtime-root]");

if (!(runtimeRoot instanceof HTMLElement)) {
  throw new Error("Board shell could not find the runtime mount root.");
}

const { bootLegacyBoard } = await import("./app.js");

await bootLegacyBoard({
  mountElement: runtimeRoot,
});
