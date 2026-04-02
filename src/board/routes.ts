import { type Database } from "bun:sqlite";

import { safeErrorMessage } from "../commands/error-utils";
import { MutationService } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError } from "../domain/types";
import { buildBoardSnapshot } from "./snapshot";

interface SnapshotDeltaSelection {
  readonly epicIds?: readonly string[];
  readonly taskIds?: readonly string[];
  readonly subtaskIds?: readonly string[];
  readonly dependencyIds?: readonly string[];
  readonly deletedSubtaskIds?: readonly string[];
  readonly deletedDependencyIds?: readonly string[];
}

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

interface IdempotentMutationRecord {
  readonly kind: "subtask" | "dependency" | "deleted_subtask" | "deleted_dependency";
  readonly entityId?: string;
  readonly sourceId?: string;
  readonly dependsOnId?: string;
  readonly responseData?: Record<string, unknown>;
  readonly status?: number;
}

function compactIds(ids: readonly string[]): string[] {
  return ids.filter((id) => id.length > 0);
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

function toBoardRouteError(error: unknown, requestLabel: string): BoardRouteError {
  if (error instanceof DomainError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "invalid_input"
          ? 400
          : error.code === "invalid_dependency" || error.code === "dependency_blocked"
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
      message: `${requestLabel} failed because the Trekoon database is busy`,
      details: {
        databaseMessage: message,
      },
    };
  }

  return {
    status: 500,
    code: "internal_error",
    message: `${requestLabel} failed unexpectedly`,
    details: {
      cause: message,
    },
  };
}

function describeBoardError(mutations: MutationService, error: unknown, requestLabel: string): BoardRouteError {
  const routeError = toBoardRouteError(error, requestLabel);
  const readableMessage = mutations.describeError(error);
  if (readableMessage === undefined) {
    return routeError;
  }

  return {
    ...routeError,
    message: readableMessage,
  };
}

function buildMutationResponse(domain: TrackerDomain, data: Record<string, unknown>, status = 200): Response {
  return jsonResponse(status, {
    ok: true,
    data,
  });
}

function buildSnapshotDelta(domain: TrackerDomain, selection: SnapshotDeltaSelection): Record<string, unknown> {
  const snapshot = buildBoardSnapshot(domain);
  const epicIdSet = new Set(selection.epicIds ?? []);
  const taskIdSet = new Set(selection.taskIds ?? []);
  const subtaskIdSet = new Set(selection.subtaskIds ?? []);
  const dependencyIdSet = new Set(selection.dependencyIds ?? []);

  return {
    generatedAt: snapshot.generatedAt,
    epics: snapshot.epics.filter((epic) => epicIdSet.has(epic.id)),
    tasks: snapshot.tasks.filter((task) => taskIdSet.has(task.id)),
    subtasks: snapshot.subtasks.filter((subtask) => subtaskIdSet.has(subtask.id)),
    dependencies: snapshot.dependencies.filter((dependency) => dependencyIdSet.has(dependency.id)),
    deletedSubtaskIds: [...(selection.deletedSubtaskIds ?? [])],
    deletedDependencyIds: [...(selection.deletedDependencyIds ?? [])],
  };
}

function buildMutationDeltaResponse(
  domain: TrackerDomain,
  data: Record<string, unknown>,
  selection: SnapshotDeltaSelection,
  status = 200,
): Response {
  return buildMutationResponse(domain, {
    ...data,
    snapshotDelta: buildSnapshotDelta(domain, selection),
  }, status);
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  const contentType: string = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new DomainError({
      code: "invalid_input",
      message: "Expected application/json request body",
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new DomainError({
      code: "invalid_input",
      message: "Malformed JSON request body",
    });
  }

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

function readOptionalNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  const value = body[field];
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== "string") {
    throw new DomainError({
      code: "invalid_input",
      message: `${field} must be a string or null`,
      details: { field },
    });
  }

  return value;
}

function readIdempotencyKey(request: Request, body: Record<string, unknown>): string | null {
  const headerKey = request.headers.get("x-trekoon-idempotency-key");
  if (typeof headerKey === "string" && headerKey.trim().length > 0) {
    return headerKey.trim();
  }

  const bodyKey = body.clientRequestId;
  if (typeof bodyKey === "string" && bodyKey.trim().length > 0) {
    return bodyKey.trim();
  }

  return null;
}

export function createBoardApiHandler(context: BoardRouteContext): (request: Request) => Promise<Response> {
  const idempotentMutations = new Map<string, IdempotentMutationRecord>();

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const requestLabel = `${request.method} ${url.pathname}`;
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

        const epicCascadeMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/epics\/([^/]+)\/cascade$/u) : null;
        if (epicCascadeMatch) {
          const body = await parseJsonBody(request);
          const status = readRequiredString(body, "status");
          const plan = mutations.updateEpicStatusCascade(epicCascadeMatch[1] ?? "", status);
          return buildMutationDeltaResponse(domain, {
            plan,
          }, {
            epicIds: [epicCascadeMatch[1] ?? ""],
            taskIds: plan.orderedChanges.filter((change) => change.kind === "task").map((change) => change.id),
            subtaskIds: plan.orderedChanges.filter((change) => change.kind === "subtask").map((change) => change.id),
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
          return buildMutationDeltaResponse(domain, { epic }, { epicIds: [epic.id] });
        }

      const taskMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/tasks\/([^/]+)$/u) : null;
      if (taskMatch) {
        const body = await parseJsonBody(request);
          const task = mutations.updateTask(taskMatch[1] ?? "", {
            title: readOptionalString(body, "title"),
            description: readOptionalString(body, "description"),
            status: readOptionalString(body, "status"),
            owner: readOptionalNullableString(body, "owner"),
          });
          return buildMutationDeltaResponse(domain, { task }, { epicIds: [task.epicId], taskIds: [task.id] });
        }

      const subtaskMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/subtasks\/([^/]+)$/u) : null;
      if (subtaskMatch) {
        const body = await parseJsonBody(request);
          const subtask = mutations.updateSubtask(subtaskMatch[1] ?? "", {
            title: readOptionalString(body, "title"),
            description: readOptionalString(body, "description"),
            status: readOptionalString(body, "status"),
            owner: readOptionalNullableString(body, "owner"),
          });
          const task = domain.getTaskOrThrow(subtask.taskId);
          return buildMutationDeltaResponse(domain, { subtask }, { epicIds: [task.epicId], taskIds: [task.id], subtaskIds: [subtask.id] });
        }

      if (request.method === "POST" && url.pathname === "/api/subtasks") {
        const body = await parseJsonBody(request);
        const idempotencyKey = readIdempotencyKey(request, body);
        if (idempotencyKey) {
          const cached = idempotentMutations.get(`subtask:${idempotencyKey}`);
            if (cached?.kind === "subtask") {
              const subtask = domain.getSubtaskOrThrow(cached.entityId);
              const task = domain.getTaskOrThrow(subtask.taskId);
              return buildMutationDeltaResponse(domain, { subtask }, { epicIds: [task.epicId], taskIds: [task.id], subtaskIds: [subtask.id] }, 201);
            }
          }

        const subtask = mutations.createSubtask({
          taskId: readRequiredString(body, "taskId"),
          title: readRequiredString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
        });
        if (idempotencyKey) {
          idempotentMutations.set(`subtask:${idempotencyKey}`, {
            kind: "subtask",
            entityId: subtask.id,
          });
        }
        const task = domain.getTaskOrThrow(subtask.taskId);
        return buildMutationDeltaResponse(domain, { subtask }, { epicIds: [task.epicId], taskIds: [task.id], subtaskIds: [subtask.id] }, 201);
      }

        const deleteSubtaskMatch = request.method === "DELETE" ? url.pathname.match(/^\/api\/subtasks\/([^/]+)$/u) : null;
        if (deleteSubtaskMatch) {
          const subtaskId = deleteSubtaskMatch[1] ?? "";
          const idempotencyKey = request.headers.get("x-trekoon-idempotency-key")?.trim() || null;
          if (idempotencyKey) {
            const cached = idempotentMutations.get(`deleted_subtask:${idempotencyKey}`);
            if (cached?.kind === "deleted_subtask" && cached.responseData) {
              return buildMutationResponse(domain, cached.responseData, cached.status ?? 200);
            }
          }
          const existingSubtask = domain.getSubtaskOrThrow(subtaskId);
          const task = domain.getTaskOrThrow(existingSubtask.taskId);
          const { deletedDependencyIds } = mutations.deleteSubtask(subtaskId);
          const responseData = {
            subtaskId,
            deleted: true,
            snapshotDelta: buildSnapshotDelta(domain, {
              epicIds: [task.epicId],
              taskIds: [task.id],
              deletedSubtaskIds: [subtaskId],
              deletedDependencyIds,
            }),
          };
          if (idempotencyKey) {
            idempotentMutations.set(`deleted_subtask:${idempotencyKey}`, {
              kind: "deleted_subtask",
              entityId: subtaskId,
              responseData,
              status: 200,
            });
          }
          return buildMutationResponse(domain, responseData, 200);
        }

      if (request.method === "POST" && url.pathname === "/api/dependencies") {
        const body = await parseJsonBody(request);
        const sourceId = readRequiredString(body, "sourceId");
        const dependsOnId = readRequiredString(body, "dependsOnId");
        const idempotencyKey = readIdempotencyKey(request, body);
        if (idempotencyKey) {
          const cached = idempotentMutations.get(`dependency:${idempotencyKey}`);
            if (cached?.kind === "dependency" && cached.sourceId && cached.dependsOnId) {
              const dependency = domain.listDependencies(cached.sourceId).find((candidate) => candidate.dependsOnId === cached.dependsOnId);
              if (dependency) {
                return buildMutationDeltaResponse(domain, { dependency }, {
                  taskIds: compactIds([dependency.sourceKind === "task" ? dependency.sourceId : "", dependency.dependsOnKind === "task" ? dependency.dependsOnId : ""]),
                  subtaskIds: compactIds([dependency.sourceKind === "subtask" ? dependency.sourceId : "", dependency.dependsOnKind === "subtask" ? dependency.dependsOnId : ""]),
                  dependencyIds: [dependency.id],
                }, 201);
              }
            }
          }

        const dependency = mutations.addDependency(sourceId, dependsOnId);
        if (idempotencyKey) {
          idempotentMutations.set(`dependency:${idempotencyKey}`, {
            kind: "dependency",
            entityId: dependency.id,
            sourceId: dependency.sourceId,
            dependsOnId: dependency.dependsOnId,
          });
        }
        return buildMutationDeltaResponse(domain, { dependency }, {
          taskIds: compactIds([dependency.sourceKind === "task" ? dependency.sourceId : "", dependency.dependsOnKind === "task" ? dependency.dependsOnId : ""]),
          subtaskIds: compactIds([dependency.sourceKind === "subtask" ? dependency.sourceId : "", dependency.dependsOnKind === "subtask" ? dependency.dependsOnId : ""]),
          dependencyIds: [dependency.id],
        }, 201);
      }

      if (request.method === "DELETE" && url.pathname === "/api/dependencies") {
        const sourceId = url.searchParams.get("sourceId") ?? "";
        const dependsOnId = url.searchParams.get("dependsOnId") ?? "";
        const idempotencyKey = request.headers.get("x-trekoon-idempotency-key")?.trim() || null;
        if (idempotencyKey) {
          const cached = idempotentMutations.get(`deleted_dependency:${idempotencyKey}`);
          if (cached?.kind === "deleted_dependency" && cached.responseData) {
            return buildMutationResponse(domain, cached.responseData, cached.status ?? 200);
          }
        }
        const existingDependencyIds = domain.listDependencies(sourceId)
          .filter((dependency) => dependency.dependsOnId === dependsOnId)
          .map((dependency) => dependency.id);
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
        const responseData = {
          sourceId,
          dependsOnId,
          removed,
          snapshotDelta: buildSnapshotDelta(domain, {
            taskIds: compactIds([domain.getTask(sourceId)?.id ?? "", domain.getTask(dependsOnId)?.id ?? ""]),
            subtaskIds: compactIds([domain.getSubtask(sourceId)?.id ?? "", domain.getSubtask(dependsOnId)?.id ?? ""]),
            deletedDependencyIds: existingDependencyIds,
          }),
        };
        if (idempotencyKey) {
          idempotentMutations.set(`deleted_dependency:${idempotencyKey}`, {
            kind: "deleted_dependency",
            sourceId,
            dependsOnId,
            responseData,
            status: 200,
          });
        }
        return buildMutationResponse(domain, responseData, 200);
      }

      return jsonResponse(404, {
        ok: false,
        error: {
          code: "not_found",
          message: `Unknown board route: ${request.method} ${url.pathname}`,
        },
      });
    } catch (error: unknown) {
      const routeError = describeBoardError(mutations, error, requestLabel);
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
