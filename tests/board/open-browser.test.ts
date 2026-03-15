import { afterEach, describe, expect, test } from "bun:test";

import { openBoardInBrowser, setBrowserLauncherForTests } from "../../src/board/open-browser";

type BrowserLaunchEvent = "error" | "spawn";
type BrowserLaunchListener = (error?: Error) => void;

class MockBrowserProcess {
  private readonly listeners = new Map<BrowserLaunchEvent, BrowserLaunchListener[]>();

  once(event: BrowserLaunchEvent, listener: BrowserLaunchListener): MockBrowserProcess {
    const wrappedListener: BrowserLaunchListener = (error?: Error): void => {
      this.removeListener(event, wrappedListener);
      listener(error);
    };
    const currentListeners = this.listeners.get(event) ?? [];
    currentListeners.push(wrappedListener);
    this.listeners.set(event, currentListeners);
    return this;
  }

  removeListener(event: BrowserLaunchEvent, listener: BrowserLaunchListener): MockBrowserProcess {
    const currentListeners = this.listeners.get(event) ?? [];
    this.listeners.set(
      event,
      currentListeners.filter((currentListener) => currentListener !== listener),
    );
    return this;
  }

  emit(event: BrowserLaunchEvent, error?: Error): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(error);
    }
  }

  unref(): void {
    // no-op for tests
  }
}

function expectedLaunch(url: string): { command: string; args: string[] } {
  if (process.platform === "darwin") {
    return { command: "open", args: [url] };
  }

  if (process.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }

  return { command: "xdg-open", args: [url] };
}

afterEach((): void => {
  setBrowserLauncherForTests(null);
});

describe("openBoardInBrowser", (): void => {
  test("reports missing opener binaries via fallback metadata", async (): Promise<void> => {
    const url = "http://127.0.0.1:4321";
    const launch = expectedLaunch(url);

    setBrowserLauncherForTests((command, args) => {
      const child = new MockBrowserProcess();

      queueMicrotask(() => {
        expect(command).toBe(launch.command);
        expect(args).toEqual(launch.args);
        child.emit("error", new Error("spawn open ENOENT"));
      });

      return child;
    });

    await expect(openBoardInBrowser(url)).resolves.toEqual({
      launched: false,
      url,
      command: launch.command,
      args: launch.args,
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
