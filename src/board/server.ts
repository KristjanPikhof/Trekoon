import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { createBoardApiHandler } from "./routes";

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

export function startBoardServer(options: StartBoardServerOptions = {}): BoardServerInfo {
  const cwd: string = options.cwd ?? process.cwd();
  const database: TrekoonDatabase = openTrekoonDatabase(cwd);
  const paths = resolveStoragePaths(cwd);
  const boardRoot: string = paths.boardDir;
  const stateFile: string = resolve(paths.storageDir, BOARD_SERVER_STATE_FILENAME);
  const token: string = options.token ?? randomBytes(18).toString("hex");
  const apiHandler = createBoardApiHandler({
    db: database.db,
    cwd,
    token,
  });

  const serveBoard = (port: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(request: Request): Promise<Response> | Response {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/")) {
          return apiHandler(request);
        }

        const assetPath = readAssetPath(boardRoot, url.pathname === "/" ? "/index.html" : url.pathname);
        if (assetPath === null) {
          const fallbackPath = readAssetPath(boardRoot, "/index.html");
          if (fallbackPath === null) {
            return new Response("Board assets are not installed", { status: 500 });
          }

          return new Response(readFileSync(fallbackPath), {
            headers: {
              "cache-control": "no-store",
              "content-type": "text/html; charset=utf-8",
            },
          });
        }

        return new Response(readFileSync(assetPath), {
          headers: {
            "cache-control": "no-store",
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

  return {
    origin,
    url,
    fallbackUrl: url,
    token,
    hostname: "127.0.0.1",
    port,
    stop(): void {
      server.stop(true);
      database.close();
    },
  };
}
