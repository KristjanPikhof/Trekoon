import { EventEmitter } from "node:events";

import { afterEach, describe, expect, test } from "bun:test";

import { openBoardInBrowser, setBrowserLauncherForTests } from "../../src/board/open-browser";

class MockBrowserProcess extends EventEmitter {
  unref(): void {
    // no-op for tests
  }
}

afterEach((): void => {
  setBrowserLauncherForTests(null);
});

describe("openBoardInBrowser", (): void => {
  test("reports missing opener binaries via fallback metadata", async (): Promise<void> => {
    setBrowserLauncherForTests((command, args) => {
      const child = new MockBrowserProcess();

      queueMicrotask(() => {
        expect(command).toBeString();
        expect(args).toEqual(["http://127.0.0.1:4321"]);
        child.emit("error", new Error("spawn open ENOENT"));
      });

      return child;
    });

    await expect(openBoardInBrowser("http://127.0.0.1:4321")).resolves.toEqual({
      launched: false,
      url: "http://127.0.0.1:4321",
      command: process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open",
      args: process.platform === "win32" ? ["/c", "start", "", "http://127.0.0.1:4321"] : ["http://127.0.0.1:4321"],
      errorMessage: "spawn open ENOENT",
    });
  });

  test("waits for async spawn errors before reporting launch success", async (): Promise<void> => {
    setBrowserLauncherForTests(() => {
      const child = new MockBrowserProcess();

      queueMicrotask(() => {
        child.emit("error", new Error("mock async spawn failure"));
      });

      return child;
    });

    const result = await openBoardInBrowser("http://127.0.0.1:4321");

    expect(result.launched).toBeFalse();
    expect(result.errorMessage).toBe("mock async spawn failure");
  });
});
