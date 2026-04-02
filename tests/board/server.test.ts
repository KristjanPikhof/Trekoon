import { createServer, type Server as NetServer } from "node:net";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startBoardServer } from "../../src/board/server";
import { resolveStoragePaths } from "../../src/storage/path";

const BOARD_SERVER_STATE_FILENAME = "board-server.json";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-server-"));
  tempDirs.push(workspace);
  return workspace;
}

function prepareBoardAssets(workspace: string): { stateFile: string } {
  const paths = resolveStoragePaths(workspace);
  mkdirSync(dirname(paths.boardEntryFile), { recursive: true });
  writeFileSync(paths.boardEntryFile, "<html><body>board</body></html>\n", "utf8");
  return {
    stateFile: join(paths.storageDir, BOARD_SERVER_STATE_FILENAME),
  };
}

async function occupyPort(): Promise<{ blocker: NetServer; port: number }> {
  const blocker: NetServer = createServer();

  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen(0, "127.0.0.1", () => {
      blocker.off("error", reject);
      resolve();
    });
  });

  const address = blocker.address();
  if (address === null || typeof address === "string") {
    blocker.close();
    throw new Error("Expected blocker server to expose a numeric port");
  }

  return {
    blocker,
    port: address.port,
  };
}

async function closeBlocker(blocker: NetServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    blocker.close((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

afterEach(async (): Promise<void> => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("board server", (): void => {
  test("reuses the last successful repo-local port across runs", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const { stateFile } = prepareBoardAssets(workspace);

    const firstServer = startBoardServer({ cwd: workspace, token: "first-token" });
    const firstResponse = await fetch(firstServer.url);
    const firstBody = await firstResponse.text();

    expect(firstResponse.status).toBe(200);
    expect(firstBody).toContain("board");
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      preferredPort: firstServer.port,
    });

    firstServer.stop();

    const secondServer = startBoardServer({ cwd: workspace, token: "second-token" });
    const secondResponse = await fetch(secondServer.url);

    expect(secondServer.port).toBe(firstServer.port);
    expect(secondResponse.status).toBe(200);
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
      preferredPort: secondServer.port,
    });

    secondServer.stop();
  });

  test("falls back to a random port when the preferred port is unavailable", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    const { stateFile } = prepareBoardAssets(workspace);
    const { blocker, port: occupiedPort } = await occupyPort();

    try {
      writeFileSync(stateFile, `${JSON.stringify({ preferredPort: occupiedPort }, null, 2)}\n`, "utf8");

      const boardServer = startBoardServer({ cwd: workspace, token: "fallback-token" });
      const response = await fetch(boardServer.url);

      expect(response.status).toBe(200);
      expect(boardServer.port).not.toBe(occupiedPort);
      expect(boardServer.origin).toBe(`http://127.0.0.1:${boardServer.port}`);
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual({
        preferredPort: boardServer.port,
      });

      boardServer.stop();
    } finally {
      await closeBlocker(blocker);
    }
  });

  test("serves index fallback with no-store headers for deep board routes", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "overlay token" });

    try {
      const response = await fetch(`${boardServer.origin}/epics/mobile/detail`);
      const body = await response.text();

      expect(boardServer.url).toBe(`${boardServer.origin}/?token=overlay%20token`);
      expect(boardServer.fallbackUrl).toBe(boardServer.origin);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("text/html");
      expect(body).toContain("board");
      expect(body).toContain("trekoon-board-bootstrap");
      expect(body).toContain('"token":"overlay token"');
    } finally {
      boardServer.stop();
    }
  });

  test("embeds bootstrap auth and snapshot payloads for manual opens", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "manual-open-token" });

    try {
      const response = await fetch(boardServer.fallbackUrl);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("trekoon-board-bootstrap");
      expect(body).toContain('"token":"manual-open-token"');
      expect(body).toContain('"snapshot":');
    } finally {
      boardServer.stop();
    }
  });

  test("serves static assets with cache-busting headers", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);
    mkdirSync(join(resolveStoragePaths(workspace).boardDir, "static"), { recursive: true });
    writeFileSync(join(resolveStoragePaths(workspace).boardDir, "static", "app.js"), "console.log('board runtime');\n", "utf8");

    const boardServer = startBoardServer({ cwd: workspace, token: "asset-token" });

    try {
      const response = await fetch(`${boardServer.origin}/static/app.js`);
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toContain("text/javascript");
      expect(body).toContain("board runtime");
    } finally {
      boardServer.stop();
    }
  });
});
