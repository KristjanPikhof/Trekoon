import { afterEach, describe, expect, test } from "bun:test";

import { runBoard, setBoardCommandHooksForTests } from "../../src/commands/board";
import { BoardInstallError, type BoardInstallResult } from "../../src/board/types";

function mockInstallResult(action: BoardInstallResult["action"] = "updated"): BoardInstallResult {
  return {
    action,
    paths: {
      sourceRoot: "/tmp/assets",
      runtimeRoot: "/tmp/runtime/.trekoon/board",
      entryFile: "/tmp/runtime/.trekoon/board/index.html",
      manifestFile: "/tmp/runtime/.trekoon/board/manifest.json",
    },
    manifest: {
      contractVersion: "1.0.0",
      assetVersion: "9.9.9",
      entryFile: "index.html",
      files: ["index.html", "assets/app.js"],
      assetDigest: "digest",
    },
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
      args: ["update", "extra"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board.update");
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

  test("refreshes board assets for update", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      updateInstalled: () => mockInstallResult("updated"),
    });

    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["update"],
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("board.update");
    expect(result.data).toEqual({
      action: "updated",
      paths: mockInstallResult("updated").paths,
      manifest: mockInstallResult("updated").manifest,
    });
  });

  test("opens board server and reports fallback URL", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      ensureInstalled: () => mockInstallResult("installed"),
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
    expect(result.data).toEqual({
      install: {
        action: "installed",
        paths: mockInstallResult("installed").paths,
        manifest: mockInstallResult("installed").manifest,
      },
      server: {
        origin: "http://127.0.0.1:4321",
        url: "http://127.0.0.1:4321/?token=secret-token",
        fallbackUrl: "http://127.0.0.1:4321",
        hostname: "127.0.0.1",
        port: 4321,
        token: "secret-token",
      },
      launch: {
        launched: true,
        url: "http://127.0.0.1:4321/?token=secret-token",
        command: "open",
        args: ["http://127.0.0.1:4321/?token=secret-token"],
        errorMessage: null,
      },
    });
  });

  test("reports fallback URL when browser launch fails", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      ensureInstalled: () => mockInstallResult("unchanged"),
      startBoardServer: () => ({
        origin: "http://127.0.0.1:4321",
        url: "http://127.0.0.1:4321/?token=secret-token",
        fallbackUrl: "http://127.0.0.1:4321/?token=secret-token",
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
    expect(result.data).toEqual({
      install: {
        action: "unchanged",
        paths: mockInstallResult("unchanged").paths,
        manifest: mockInstallResult("unchanged").manifest,
      },
      server: {
        origin: "http://127.0.0.1:4321",
        url: "http://127.0.0.1:4321/?token=secret-token",
        fallbackUrl: "http://127.0.0.1:4321/?token=secret-token",
        hostname: "127.0.0.1",
        port: 4321,
        token: "secret-token",
      },
      launch: {
        launched: false,
        url: "http://127.0.0.1:4321/?token=secret-token",
        command: "open",
        args: ["http://127.0.0.1:4321/?token=secret-token"],
        errorMessage: "mock browser failure",
      },
    });
  });

  test("surfaces install failures with stable codes", async (): Promise<void> => {
    setBoardCommandHooksForTests({
      ensureInstalled: () => {
        throw new BoardInstallError("missing_asset", "Bundled board asset directory not found", {
          sourceRoot: "/missing/assets",
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
