window.__TREKOON_BOARD_BOOTSTRAP__ = "main";

const runtimeRoot = document.querySelector("[data-board-runtime-root]");

if (!(runtimeRoot instanceof HTMLElement)) {
  throw new Error("Board shell could not find the runtime mount root.");
}

const { bootLegacyBoard } = await import("./app.js");

await bootLegacyBoard({
  mountElement: runtimeRoot,
});
