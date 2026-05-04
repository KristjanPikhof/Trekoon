import { afterEach, describe, expect, test } from "bun:test";

import { runBoard, setBoardCommandHooksForTests } from "../../src/commands/board";
import { BoardAssetError } from "../../src/board/types";
import type { BoardAssetRoot } from "../../src/board/asset-root";

function mockAssetRoot(): BoardAssetRoot {
  return {
    assetRoot: "/tmp/assets",
    entryFile: "/tmp/assets/index.html",
    source: "package",
  };
}

afterEach((): void => {
  setBoardCommandHooksForTests(null);
});

describe("board command", (): void => {
  test("rejects missing subcommand", async (): Promise<void> => {
    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: [],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board");
    expect(result.error?.code).toBe("invalid_subcommand");
  });

  test("rejects unexpected args", async (): Promise<void> => {
    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open", "extra"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board.open");
    expect(result.error?.code).toBe("invalid_input");
  });

  test("rejects command options for board lifecycle commands", async (): Promise<void> => {
    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open", "--port", "4321"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board.open");
    expect(result.human).toBe("Board commands do not accept options yet.");
    expect(result.data).toEqual({
      options: ["--port"],
    });
    expect(result.error).toEqual({
      code: "invalid_input",
      message: "Board commands do not accept options",
    });
  });

  test("returns invalid_subcommand for retired update subcommand", async (): Promise<void> => {
    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["update"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board");
    expect(result.error?.code).toBe("invalid_subcommand");
    expect(result.human).toBe("Usage: trekoon board <open>");
  });

  test("opens board server and reports fallback URL", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      resolveAssetRoot: () => mockAssetRoot(),
      startBoardServer: () => ({
        origin: "http://127.0.0.1:4321",
        url: "http://127.0.0.1:4321/?token=secret-token",
        fallbackUrl: "http://127.0.0.1:4321",
        hostname: "127.0.0.1",
        port: 4321,
        token: "secret-token",
        stop(): void {
          // no-op in tests
        },
      }),
      openBoardInBrowser: async (url) => ({
        launched: true,
        url,
        command: "open",
        args: [url],
        errorMessage: null,
      }),
    });

    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open"],
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("board.open");
    expect(result.human).toContain("Board ready at http://127.0.0.1:4321");
    expect(result.human).toContain("Open manually if needed: http://127.0.0.1:4321");
    expect(result.human).not.toContain("secret-token");
    expect(result.data).toEqual({
      assetRoot: {
        path: "/tmp/assets",
        entryFile: "/tmp/assets/index.html",
        source: "package",
      },
      server: {
        origin: "http://127.0.0.1:4321",
        fallbackUrl: "http://127.0.0.1:4321",
        hostname: "127.0.0.1",
        port: 4321,
      },
      launch: {
        launched: true,
        command: "open",
        errorMessage: null,
      },
    });
    expect(JSON.stringify(result.data)).not.toContain("secret-token");
  });

  test("reports fallback URL when browser launch fails", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      resolveAssetRoot: () => mockAssetRoot(),
      startBoardServer: () => ({
        origin: "http://127.0.0.1:4321",
        url: "http://127.0.0.1:4321/?token=secret-token",
        fallbackUrl: "http://127.0.0.1:4321",
        hostname: "127.0.0.1",
        port: 4321,
        token: "secret-token",
        stop(): void {
          // no-op in tests
        },
      }),
      openBoardInBrowser: async (url) => ({
        launched: false,
        url,
        command: "open",
        args: [url],
        errorMessage: "mock browser failure",
      }),
    });

    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open"],
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("board.open");
    expect(result.human).toContain("Board ready at http://127.0.0.1:4321");
    expect(result.human).toContain("Browser launch failed: mock browser failure");
    expect(result.human).toContain("Open manually if needed: http://127.0.0.1:4321");
    expect(result.human).not.toContain("secret-token");
    expect(result.data).toEqual({
      assetRoot: {
        path: "/tmp/assets",
        entryFile: "/tmp/assets/index.html",
        source: "package",
      },
      server: {
        origin: "http://127.0.0.1:4321",
        fallbackUrl: "http://127.0.0.1:4321",
        hostname: "127.0.0.1",
        port: 4321,
      },
      launch: {
        launched: false,
        command: "open",
        errorMessage: "mock browser failure",
      },
    });
  });

  test("redacts token by default and surfaces it when --reveal-token is set", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      resolveAssetRoot: () => mockAssetRoot(),
      startBoardServer: () => ({
        origin: "http://127.0.0.1:4321",
        url: "http://127.0.0.1:4321/?token=hidden-secret",
        fallbackUrl: "http://127.0.0.1:4321",
        hostname: "127.0.0.1",
        port: 4321,
        token: "hidden-secret",
        stop(): void {
          // no-op in tests
        },
      }),
      openBoardInBrowser: async (url) => ({
        launched: true,
        url,
        command: "open",
        args: [url],
        errorMessage: null,
      }),
    });

    const defaultResult = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open"],
    });

    expect(defaultResult.ok).toBeTrue();
    expect(JSON.stringify(defaultResult.data)).not.toContain("hidden-secret");
    expect(defaultResult.human).not.toContain("hidden-secret");

    const revealedResult = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open", "--reveal-token"],
    });

    expect(revealedResult.ok).toBeTrue();
    expect(JSON.stringify(revealedResult.data)).toContain("hidden-secret");
    expect(revealedResult.human).toContain("hidden-secret");
    expect(revealedResult.human).toContain("do not share");
  });

  test("rejects --reveal-token on subcommands other than open", async (): Promise<void> => {
    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["bogus", "--reveal-token"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board.bogus");
    expect(result.error?.code).toBe("invalid_input");
  });

  test("surfaces asset resolution failures with stable codes", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      resolveAssetRoot: () => {
        throw new BoardAssetError("missing_asset", "Bundled board asset directory not found", {
          assetRoot: "/missing/assets",
        });
      },
    });

    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["open"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board.open");
    expect(result.error?.code).toBe("missing_asset");
  });
});
