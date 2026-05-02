import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { createBoardEventBus, type BoardEventBus } from "./event-bus";
import { createBoardApiHandler } from "./routes";
import { startWalWatcher, type WalWatcher } from "./wal-watcher";

import { openTrekoonDatabase, type TrekoonDatabase } from "../storage/database";
import { resolveStoragePaths } from "../storage/path";

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

const BOARD_SERVER_STATE_FILENAME = "board-server.json";

interface BoardServerState {
  readonly preferredPort: number;
}

export interface BoardServerInfo {
  readonly origin: string;
  readonly url: string;
  readonly fallbackUrl: string;
  readonly token: string;
  readonly hostname: "127.0.0.1";
  readonly port: number;
  stop(): void;
}

export interface StartBoardServerOptions {
  readonly cwd?: string;
  readonly token?: string;
}

function guessContentType(pathname: string): string {
  return CONTENT_TYPES[extname(pathname).toLowerCase()] ?? "application/octet-stream";
}

function readAssetPath(boardRoot: string, pathname: string): string | null {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(boardRoot, relativePath);
  if (!candidate.startsWith(resolve(boardRoot))) {
    return null;
  }

  return existsSync(candidate) ? candidate : null;
}

function readPreferredBoardPort(stateFile: string): number | null {
  if (!existsSync(stateFile)) {
    return null;
  }

  try {
    const rawState: string = readFileSync(stateFile, "utf8");
    const state = JSON.parse(rawState) as Partial<BoardServerState>;
    const preferredPort = state.preferredPort;

    if (typeof preferredPort !== "number" || !Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
      return null;
    }

    return preferredPort;
  } catch {
    return null;
  }
}

function persistPreferredBoardPort(stateFile: string, port: number): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, `${JSON.stringify({ preferredPort: port }, null, 2)}\n`, "utf8");
}

function isUnavailablePortError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { code?: unknown };
  const errorCode = typeof errorWithCode.code === "string" ? errorWithCode.code : "";
  return /^(EADDRINUSE|EACCES)$/i.test(errorCode) || /(EADDRINUSE|EACCES|address already in use|permission denied)/i.test(error.message);
}

function buildBoardSessionCookie(token: string): string {
  return `trekoon_board_session=${encodeURIComponent(token)}; Path=/; SameSite=Strict; HttpOnly`;
}

function readBoardSessionCookie(request: Request): string | null {
  const rawCookie = request.headers.get("cookie");
  if (!rawCookie) {
    return null;
  }

  for (const part of rawCookie.split(";")) {
    const [name, ...valueParts] = part.split("=");
    if (name?.trim() !== "trekoon_board_session") {
      continue;
    }

    const value = valueParts.join("=").trim();
    return value.length > 0 ? decodeURIComponent(value) : null;
  }

  return null;
}

function isAuthenticatedBoardRequest(request: Request, url: URL, token: string): boolean {
  const queryToken = url.searchParams.get("token");
  if (queryToken && queryToken === token) {
    return true;
  }

  const cookieToken = readBoardSessionCookie(request);
  return cookieToken !== null && cookieToken === token;
}

function serializeInlineJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function buildBoardBootstrapPayload(_database: TrekoonDatabase, token: string): string {
  // Only the auth token is inlined; the snapshot is fetched client-side via
  // /api/snapshot to keep index.html small and avoid disclosing data even
  // briefly through the HTML response cache.
  return serializeInlineJson({
    token,
  });
}

function injectBoardBootstrap(html: string, bootstrapJson: string): string {
  const bootstrapTag = `<script id="trekoon-board-bootstrap" type="application/json">${bootstrapJson}</script>`;
  const closingBodyIndex = html.lastIndexOf("</body>");
  if (closingBodyIndex === -1) {
    return `${html}${bootstrapTag}`;
  }

  return `${html.slice(0, closingBodyIndex)}${bootstrapTag}\n${html.slice(closingBodyIndex)}`;
}

export function startBoardServer(options: StartBoardServerOptions = {}): BoardServerInfo {
  const cwd: string = options.cwd ?? process.cwd();
  const database: TrekoonDatabase = openTrekoonDatabase(cwd);
  const paths = resolveStoragePaths(cwd);
  const boardRoot: string = paths.boardDir;
  const stateFile: string = resolve(paths.storageDir, BOARD_SERVER_STATE_FILENAME);
  const token: string = options.token ?? randomBytes(32).toString("hex");
  const eventBus: BoardEventBus = createBoardEventBus();
  const walWatcher: WalWatcher = startWalWatcher({
    db: database.db,
    databaseFile: database.paths.databaseFile,
    eventBus,
  });
  const apiHandler = createBoardApiHandler({
    db: database.db,
    cwd,
    token,
    eventBus,
  });

  const serveBoard = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      idleTimeout: 0,
      fetch(request: Request): Promise<Response> | Response {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/")) {
          return apiHandler(request);
        }

        const isAuthenticated = isAuthenticatedBoardRequest(request, url, token);
        const responseHeaders: Record<string, string> = {
          "cache-control": "no-store",
        };
        const queryTokenMatched = (url.searchParams.get("token") ?? "") === token;
        if (isAuthenticated && queryTokenMatched) {
          responseHeaders["set-cookie"] = buildBoardSessionCookie(token);

          // Token revoke on rotation (P1 finding 8): once we've installed the
          // session cookie, redirect to the same URL with the `token=` query
          // param stripped. This keeps the browser's address bar, history,
          // and Referer headers free of the secret on the very first
          // navigation, severing the leakage surface that an open URL bar
          // would otherwise expose. The cookie carries auth from here on.
          const redirectUrl = new URL(url);
          redirectUrl.searchParams.delete("token");
          // Preserve the relative location so the redirect works regardless
          // of how the client reached us (loopback IP vs. localhost name).
          const location = `${redirectUrl.pathname}${redirectUrl.search}${redirectUrl.hash}`;
          return new Response(null, {
            status: 302,
            headers: {
              ...responseHeaders,
              location: location.length > 0 ? location : "/",
            },
          });
        }

        const assetPath = readAssetPath(boardRoot, url.pathname === "/" ? "/index.html" : url.pathname);
        if (assetPath === null) {
          const fallbackPath = readAssetPath(boardRoot, "/index.html");
          if (fallbackPath === null) {
            return new Response("Board assets are not installed", { status: 500 });
          }

          const rawHtml = readFileSync(fallbackPath, "utf8");
          const html = isAuthenticated
            ? injectBoardBootstrap(rawHtml, buildBoardBootstrapPayload(database, token))
            : rawHtml;

          return new Response(html, {
            status: isAuthenticated ? 200 : 401,
            headers: {
              ...responseHeaders,
              "content-type": "text/html; charset=utf-8",
            },
          });
        }

        if (assetPath.endsWith("/index.html")) {
          const rawHtml = readFileSync(assetPath, "utf8");
          const html = isAuthenticated
            ? injectBoardBootstrap(rawHtml, buildBoardBootstrapPayload(database, token))
            : rawHtml;
          return new Response(html, {
            status: isAuthenticated ? 200 : 401,
            headers: {
              ...responseHeaders,
              "content-type": "text/html; charset=utf-8",
            },
          });
        }

        return new Response(readFileSync(assetPath), {
          headers: {
            ...responseHeaders,
            "content-type": guessContentType(assetPath),
          },
        });
      },
      error(error: Error): Response {
        return new Response(`Board server error: ${error.message}`, { status: 500 });
      },
    });

  const preferredPort: number | null = readPreferredBoardPort(stateFile);

  let server;
  try {
    server = serveBoard(preferredPort ?? 0);
  } catch (error) {
    if (preferredPort === null || !isUnavailablePortError(error)) {
      database.close();
      throw error;
    }

    server = serveBoard(0);
  }

  const port: number | undefined = server.port;
  if (port === undefined) {
    server.stop(true);
    database.close();
    throw new Error("Board server did not expose a listening port");
  }

  try {
    persistPreferredBoardPort(stateFile, port);
  } catch (error) {
    server.stop(true);
    database.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Board server could not persist preferred port at ${stateFile}: ${message}`);
  }

  const origin: string = `http://127.0.0.1:${port}`;
  const url: string = `${origin}/?token=${encodeURIComponent(token)}`;
  const fallbackUrl: string = origin;

  return {
    origin,
    url,
    fallbackUrl,
    token,
    hostname: "127.0.0.1",
    port,
    stop(): void {
      walWatcher.close();
      eventBus.close();
      server.stop(true);
      database.close();
    },
  };
}
