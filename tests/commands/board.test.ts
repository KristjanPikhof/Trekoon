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
    expect(result.human).not.toContain("secret-token");
    expect(result.data).toEqual({
      install: {
        action: "installed",
        paths: mockInstallResult("installed").paths,
        manifest: mockInstallResult("installed").manifest,
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
    expect(result.human).not.toContain("secret-token");
    expect(result.data).toEqual({
      install: {
        action: "unchanged",
        paths: mockInstallResult("unchanged").paths,
        manifest: mockInstallResult("unchanged").manifest,
      },
      server: {
        origin: "http://127.0.0.1:4321",
        fallbackUrl: "http://127.0.0.1:4321/?token=secret-token",
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
      ensureInstalled: () => mockInstallResult("installed"),
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
    setBoardCommandHooksForTests({
      updateInstalled: () => mockInstallResult("updated"),
    });

    const result = await runBoard({
      cwd: "/tmp/workspace",
      mode: "toon",
      args: ["update", "--reveal-token"],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("board.update");
    expect(result.error?.code).toBe("invalid_input");
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
