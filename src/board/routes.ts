import { type Database } from "bun:sqlite";

import { safeErrorMessage } from "../commands/error-utils";
import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError } from "../domain/types";
import { buildBoardSnapshot } from "./snapshot";

interface BoardRouteContext {
  readonly db: Database;
  readonly cwd: string;
  readonly token: string;
}

interface BoardRouteError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

function jsonResponse(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function extractToken(request: Request, url: URL): string | null {
  const authorization: string | null = request.headers.get("authorization");
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length).trim();
  }

  const headerToken: string | null = request.headers.get("x-trekoon-token");
  if (headerToken && headerToken.trim().length > 0) {
    return headerToken.trim();
  }

  const queryToken: string | null = url.searchParams.get("token");
  if (queryToken && queryToken.trim().length > 0) {
    return queryToken.trim();
  }

  return null;
}

function isSqliteBusyMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("database is locked") || normalized.includes("database schema is locked");
}

function toBoardRouteError(error: unknown): BoardRouteError {
  if (error instanceof DomainError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "invalid_input" || error.code === "invalid_dependency" || error.code === "dependency_blocked"
          ? 409
          : 400;
    return {
      status,
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }

  const message = safeErrorMessage(error, "Unexpected board API failure");
  if (isSqliteBusyMessage(message)) {
    return {
      status: 503,
      code: "database_busy",
      message: "Trekoon database is busy",
      details: {
        databaseMessage: message,
      },
    };
  }

  return {
    status: 500,
    code: "internal_error",
    message: "Unexpected board API failure",
    details: {
      cause: message,
    },
  };
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType: string = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new DomainError({
      code: "invalid_input",
      message: "Expected application/json request body",
    });
  }

  const body = await request.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new DomainError({
      code: "invalid_input",
      message: "Expected JSON object request body",
    });
  }

  return body as Record<string, unknown>;
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new DomainError({
      code: "invalid_input",
      message: `${field} must be a string`,
      details: { field },
    });
  }

  return value;
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
  const value = readOptionalString(body, field);
  if (value === undefined) {
    throw new DomainError({
      code: "invalid_input",
      message: `${field} is required`,
      details: { field },
    });
  }

  return value;
}

export function createBoardApiHandler(context: BoardRouteContext): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const requestToken = extractToken(request, url);
    if (requestToken !== context.token) {
      return jsonResponse(401, {
        ok: false,
        error: {
          code: "unauthorized",
          message: "Missing or invalid board session token",
        },
      });
    }

    const domain = new TrackerDomain(context.db);
    const mutations = new MutationService(context.db, context.cwd);

    try {
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        return jsonResponse(200, {
          ok: true,
          data: {
            snapshot: buildBoardSnapshot(domain),
          },
        });
      }

      const epicMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/epics\/([^/]+)$/u) : null;
      if (epicMatch) {
        const body = await parseJsonBody(request);
        const epic = mutations.updateEpic(epicMatch[1] ?? "", {
          title: readOptionalString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
        });
        return jsonResponse(200, { ok: true, data: { epic } });
      }

      const taskMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/tasks\/([^/]+)$/u) : null;
      if (taskMatch) {
        const body = await parseJsonBody(request);
        const task = mutations.updateTask(taskMatch[1] ?? "", {
          title: readOptionalString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
        });
        return jsonResponse(200, { ok: true, data: { task } });
      }

      const subtaskMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/subtasks\/([^/]+)$/u) : null;
      if (subtaskMatch) {
        const body = await parseJsonBody(request);
        const subtask = mutations.updateSubtask(subtaskMatch[1] ?? "", {
          title: readOptionalString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
        });
        return jsonResponse(200, { ok: true, data: { subtask } });
      }

      if (request.method === "POST" && url.pathname === "/api/dependencies") {
        const body = await parseJsonBody(request);
        const dependency = mutations.addDependency(readRequiredString(body, "sourceId"), readRequiredString(body, "dependsOnId"));
        return jsonResponse(201, { ok: true, data: { dependency } });
      }

      if (request.method === "DELETE" && url.pathname === "/api/dependencies") {
        const sourceId = url.searchParams.get("sourceId") ?? "";
        const dependsOnId = url.searchParams.get("dependsOnId") ?? "";
        const removed = mutations.removeDependency(sourceId, dependsOnId);
        if (removed === 0) {
          throw new DomainError({
            code: "not_found",
            message: "Dependency edge not found",
            details: {
              sourceId,
              dependsOnId,
            },
          });
        }

        return jsonResponse(200, {
          ok: true,
          data: {
            sourceId,
            dependsOnId,
            removed,
          },
        });
      }

      return jsonResponse(404, {
        ok: false,
        error: {
          code: "not_found",
          message: `Unknown board route: ${request.method} ${url.pathname}`,
        },
      });
    } catch (error: unknown) {
      const routeError = toBoardRouteError(error);
      return jsonResponse(routeError.status, {
        ok: false,
        error: {
          code: routeError.code,
          message: routeError.message,
          ...(routeError.details === undefined ? {} : { details: routeError.details }),
        },
      });
    }
  };
}
