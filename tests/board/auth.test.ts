import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { startBoardServer } from "../../src/board/server";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-auth-"));
  tempDirs.push(workspace);
  return workspace;
}

function prepareBoardAssets(workspace: string): void {
  const paths = resolveStoragePaths(workspace);
  mkdirSync(dirname(paths.boardEntryFile), { recursive: true });
  writeFileSync(
    paths.boardEntryFile,
    "<html><head><title>Trekoon Board</title></head><body><div id=\"app\">board</div></body></html>\n",
    "utf8",
  );
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("board server auth", (): void => {
  test("returns 401 with no snapshot or token when no credentials are provided", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "secret-token-value" });

    try {
      const response = await fetch(boardServer.fallbackUrl);
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).not.toContain("secret-token-value");
      expect(body).not.toContain("trekoon-board-bootstrap");
      expect(body).not.toContain('"snapshot":');
      expect(body).not.toContain('"token":');
    } finally {
      boardServer.stop();
    }
  });

  test("returns 401 with no snapshot or token for deep routes without credentials", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "deep-route-token" });

    try {
      const response = await fetch(`${boardServer.origin}/epics/some-epic`);
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).not.toContain("deep-route-token");
      expect(body).not.toContain("trekoon-board-bootstrap");
      expect(body).not.toContain('"snapshot":');
    } finally {
      boardServer.stop();
    }
  });

  test("returns 401 when an invalid query token is supplied", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "valid-token" });

    try {
      const response = await fetch(`${boardServer.origin}/?token=wrong-token`);
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).not.toContain("valid-token");
      expect(body).not.toContain("trekoon-board-bootstrap");
    } finally {
      boardServer.stop();
    }
  });

  test("redirects with HttpOnly cookie and strips token from URL when valid query token is provided", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "session-token" });

    try {
      // Token-revoke-on-rotation: the first GET with `?token=` must respond
      // with a 302 that installs the cookie and removes the token from the
      // URL bar, then redirect to the same path without the token query
      // parameter (P1 finding 8).
      const redirect = await fetch(boardServer.url, { redirect: "manual" });

      expect(redirect.status).toBe(302);

      const setCookie = redirect.headers.get("set-cookie");
      expect(setCookie).not.toBeNull();
      expect(setCookie ?? "").toContain("trekoon_board_session=session-token");
      expect(setCookie ?? "").toContain("HttpOnly");
      expect(setCookie ?? "").toContain("Max-Age=86400");
      expect(setCookie ?? "").toContain("SameSite=Strict");
      expect(redirect.headers.get("referrer-policy")).toBe("no-referrer");

      const location = redirect.headers.get("location");
      expect(location).not.toBeNull();
      expect(location ?? "").not.toContain("token=");
      expect(location ?? "").not.toContain("session-token");
      // Path-relative location to / preserves the loopback hostname the
      // browser dialed in with.
      expect(location ?? "").toBe("/");

      // Following the redirect with the just-installed cookie should yield
      // the bootstrap HTML.
      const followed = await fetch(`${boardServer.origin}${location ?? "/"}`, {
        headers: {
          cookie: `trekoon_board_session=${encodeURIComponent("session-token")}`,
        },
      });
      const body = await followed.text();
      expect(followed.status).toBe(200);
      expect(body).toContain("trekoon-board-bootstrap");
      expect(body).toContain('"token":"session-token"');
    } finally {
      boardServer.stop();
    }
  });

  test("accepts session cookie as valid credentials without query token", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "cookie-only-token" });

    try {
      const response = await fetch(boardServer.fallbackUrl, {
        headers: {
          cookie: `trekoon_board_session=${encodeURIComponent("cookie-only-token")}`,
        },
      });
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(body).toContain("trekoon-board-bootstrap");
    } finally {
      boardServer.stop();
    }
  });

  test("rejects invalid cookie credentials", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "real-token" });

    try {
      const response = await fetch(boardServer.fallbackUrl, {
        headers: {
          cookie: "trekoon_board_session=fake-cookie",
        },
      });
      const body = await response.text();

      expect(response.status).toBe(401);
      expect(body).not.toContain("real-token");
      expect(body).not.toContain("trekoon-board-bootstrap");
    } finally {
      boardServer.stop();
    }
  });

  test("rejects token query parameters on API routes", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "api-query-token" });

    try {
      const response = await fetch(`${boardServer.origin}/api/snapshot?token=api-query-token`);
      const body = await response.json() as { ok: boolean; error: { code: string } };

      expect(response.status).toBe(401);
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe("unauthorized");
    } finally {
      boardServer.stop();
    }
  });

  test("snapshot stream authenticates with cookie but rejects query tokens", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    prepareBoardAssets(workspace);

    const boardServer = startBoardServer({ cwd: workspace, token: "sse-cookie-token" });

    try {
      const queryResponse = await fetch(`${boardServer.origin}/api/snapshot/stream?token=sse-cookie-token`, {
        headers: { accept: "text/event-stream" },
      });
      expect(queryResponse.status).toBe(401);

      const cookieResponse = await fetch(`${boardServer.origin}/api/snapshot/stream`, {
        headers: {
          accept: "text/event-stream",
          cookie: `trekoon_board_session=${encodeURIComponent("sse-cookie-token")}`,
        },
      });
      expect(cookieResponse.status).toBe(200);
      expect(cookieResponse.headers.get("content-type")).toContain("text/event-stream");
      await cookieResponse.body?.cancel().catch(() => {});
    } finally {
      boardServer.stop();
    }
  });
});
