import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

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
};

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

export function startBoardServer(options: StartBoardServerOptions = {}): BoardServerInfo {
  const cwd: string = options.cwd ?? process.cwd();
  const database: TrekoonDatabase = openTrekoonDatabase(cwd);
  const paths = resolveStoragePaths(cwd);
  const boardRoot: string = paths.boardDir;
  const token: string = options.token ?? randomBytes(18).toString("hex");
  const apiHandler = createBoardApiHandler({
    db: database.db,
    cwd,
    token,
  });

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
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

  const port: number | undefined = server.port;
  if (port === undefined) {
    server.stop(true);
    database.close();
    throw new Error("Board server did not expose a listening port");
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
