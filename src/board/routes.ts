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

function buildCreateSubtaskFingerprint(body: Record<string, unknown>): string {
  return JSON.stringify({
    taskId: readRequiredString(body, "taskId"),
    title: readRequiredString(body, "title"),
    description: readOptionalString(body, "description") ?? null,
    status: readOptionalString(body, "status") ?? null,
  });
}

function buildCreateDependencyFingerprint(sourceId: string, dependsOnId: string): string {
  return JSON.stringify({ sourceId, dependsOnId });
}

function buildDeleteSubtaskFingerprint(subtaskId: string): string {
  return JSON.stringify({ subtaskId });
}

function buildDeleteDependencyFingerprint(sourceId: string, dependsOnId: string): string {
  return JSON.stringify({ sourceId, dependsOnId });
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

function buildMutationResponse(_domain: TrackerDomain, data: Record<string, unknown>, status = 200): Response {
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

function readRecordId(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function withFreshReplaySnapshotDelta(
  domain: TrackerDomain,
  responseData: Record<string, unknown>,
  selection: SnapshotDeltaSelection,
): Record<string, unknown> {
  return {
    ...responseData,
    snapshotDelta: buildSnapshotDelta(domain, selection),
  };
}

function readSnapshotDelta(responseData: Record<string, unknown>): Record<string, unknown> | null {
  const snapshotDelta = responseData.snapshotDelta;
  return snapshotDelta && typeof snapshotDelta === "object" ? snapshotDelta as Record<string, unknown> : null;
}

function readRecordIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((item) => readRecordId(item)).filter((id): id is string => id !== null);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
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
        const requestFingerprint = buildCreateSubtaskFingerprint(body);
        if (!idempotencyKey) {
          const subtask = mutations.createSubtask({
            taskId: readRequiredString(body, "taskId"),
            title: readRequiredString(body, "title"),
            description: readOptionalString(body, "description"),
            status: readOptionalString(body, "status"),
          });
          const task = domain.getTaskOrThrow(subtask.taskId);
          const responseData = {
            subtask,
            snapshotDelta: buildSnapshotDelta(domain, {
              epicIds: [task.epicId],
              taskIds: [task.id],
              subtaskIds: [subtask.id],
            }),
          };
          return buildMutationResponse(domain, responseData, 201);
        }

        const result = mutations.createSubtaskAtomicallyWithIdempotency({
          taskId: readRequiredString(body, "taskId"),
          title: readRequiredString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
          claim: {
            scope: "subtask",
            idempotencyKey,
            requestFingerprint,
            conflictMessage: "Idempotency key cannot be reused for a different subtask request",
          },
          buildResponseData: ({ subtask, domain: transactionDomain }) => {
            const task = transactionDomain.getTaskOrThrow(subtask.taskId);
            return {
              subtask,
              snapshotDelta: buildSnapshotDelta(transactionDomain, {
                epicIds: [task.epicId],
                taskIds: [task.id],
                subtaskIds: [subtask.id],
              }),
            };
          },
        });
        const replaySubtaskId = readRecordId(result.responseData.subtask);
        const replayTaskId = replaySubtaskId ? domain.getSubtask(replaySubtaskId)?.taskId ?? null : null;
        const replayEpicId = replayTaskId ? domain.getTask(replayTaskId)?.epicId ?? null : null;
        return buildMutationResponse(domain, result.state === "replay"
          ? withFreshReplaySnapshotDelta(domain, result.responseData, {
            epicIds: replayEpicId ? [replayEpicId] : [],
            taskIds: replayTaskId ? [replayTaskId] : [],
            subtaskIds: replaySubtaskId ? [replaySubtaskId] : [],
          })
          : result.responseData, result.status);
      }

        const deleteSubtaskMatch = request.method === "DELETE" ? url.pathname.match(/^\/api\/subtasks\/([^/]+)$/u) : null;
        if (deleteSubtaskMatch) {
          const subtaskId = deleteSubtaskMatch[1] ?? "";
          const idempotencyKey = request.headers.get("x-trekoon-idempotency-key")?.trim() || null;
          const requestFingerprint = buildDeleteSubtaskFingerprint(subtaskId);
          if (!idempotencyKey) {
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
            return buildMutationResponse(domain, responseData, 200);
          }

          const result = mutations.deleteSubtaskAtomicallyWithIdempotency({
            id: subtaskId,
            claim: {
              scope: "deleted_subtask",
              idempotencyKey,
              requestFingerprint,
              conflictMessage: "Idempotency key cannot be reused for a different subtask delete request",
            },
            buildResponseData: ({ subtaskId: deletedSubtaskId, deletedDependencyIds, domain: transactionDomain, taskId, epicId }) => ({
              subtaskId: deletedSubtaskId,
              deleted: true,
              snapshotDelta: buildSnapshotDelta(transactionDomain, {
                epicIds: [epicId],
                taskIds: [taskId],
                deletedSubtaskIds: [deletedSubtaskId],
                deletedDependencyIds,
              }),
            }),
          });
          const replaySnapshotDelta = readSnapshotDelta(result.responseData);
          return buildMutationResponse(domain, result.state === "replay"
            ? withFreshReplaySnapshotDelta(domain, result.responseData, {
              epicIds: readRecordIds(replaySnapshotDelta?.epics),
              taskIds: readRecordIds(replaySnapshotDelta?.tasks),
              deletedSubtaskIds: readStringArray(replaySnapshotDelta?.deletedSubtaskIds),
              deletedDependencyIds: readStringArray(replaySnapshotDelta?.deletedDependencyIds),
            })
            : result.responseData, result.status);
        }

      if (request.method === "POST" && url.pathname === "/api/dependencies") {
        const body = await parseJsonBody(request);
        const sourceId = readRequiredString(body, "sourceId");
        const dependsOnId = readRequiredString(body, "dependsOnId");
        const idempotencyKey = readIdempotencyKey(request, body);
        const requestFingerprint = buildCreateDependencyFingerprint(sourceId, dependsOnId);
        if (!idempotencyKey) {
          const dependency = mutations.addDependency(sourceId, dependsOnId);
          const responseData = {
            dependency,
            snapshotDelta: buildSnapshotDelta(domain, {
              taskIds: compactIds([dependency.sourceKind === "task" ? dependency.sourceId : "", dependency.dependsOnKind === "task" ? dependency.dependsOnId : ""]),
              subtaskIds: compactIds([dependency.sourceKind === "subtask" ? dependency.sourceId : "", dependency.dependsOnKind === "subtask" ? dependency.dependsOnId : ""]),
              dependencyIds: [dependency.id],
            }),
          };
          return buildMutationResponse(domain, responseData, 201);
        }

        const result = mutations.addDependencyAtomicallyWithIdempotency({
          sourceId,
          dependsOnId,
          claim: {
            scope: "dependency",
            idempotencyKey,
            requestFingerprint,
            conflictMessage: "Idempotency key cannot be reused for a different dependency request",
          },
          buildResponseData: ({ dependency, domain: transactionDomain }) => ({
            dependency,
            snapshotDelta: buildSnapshotDelta(transactionDomain, {
              taskIds: compactIds([dependency.sourceKind === "task" ? dependency.sourceId : "", dependency.dependsOnKind === "task" ? dependency.dependsOnId : ""]),
              subtaskIds: compactIds([dependency.sourceKind === "subtask" ? dependency.sourceId : "", dependency.dependsOnKind === "subtask" ? dependency.dependsOnId : ""]),
              dependencyIds: [dependency.id],
            }),
            }),
        });
        const replayDependency = result.responseData.dependency;
        const replayDependencyId = readRecordId(replayDependency);
        const replaySelection = replayDependency && typeof replayDependency === "object"
          ? {
            taskIds: compactIds([
              (replayDependency as { sourceKind?: unknown; sourceId?: unknown }).sourceKind === "task"
                ? ((replayDependency as { sourceId?: unknown }).sourceId as string ?? "")
                : "",
              (replayDependency as { dependsOnKind?: unknown; dependsOnId?: unknown }).dependsOnKind === "task"
                ? ((replayDependency as { dependsOnId?: unknown }).dependsOnId as string ?? "")
                : "",
            ]),
            subtaskIds: compactIds([
              (replayDependency as { sourceKind?: unknown; sourceId?: unknown }).sourceKind === "subtask"
                ? ((replayDependency as { sourceId?: unknown }).sourceId as string ?? "")
                : "",
              (replayDependency as { dependsOnKind?: unknown; dependsOnId?: unknown }).dependsOnKind === "subtask"
                ? ((replayDependency as { dependsOnId?: unknown }).dependsOnId as string ?? "")
                : "",
            ]),
            dependencyIds: replayDependencyId ? [replayDependencyId] : [],
          }
          : { dependencyIds: [] };
        return buildMutationResponse(domain, result.state === "replay"
          ? withFreshReplaySnapshotDelta(domain, result.responseData, replaySelection)
          : result.responseData, result.status);
      }

      if (request.method === "DELETE" && url.pathname === "/api/dependencies") {
        const sourceId = url.searchParams.get("sourceId") ?? "";
        const dependsOnId = url.searchParams.get("dependsOnId") ?? "";
        const idempotencyKey = request.headers.get("x-trekoon-idempotency-key")?.trim() || null;
        const requestFingerprint = buildDeleteDependencyFingerprint(sourceId, dependsOnId);
        if (!idempotencyKey) {
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
          return buildMutationResponse(domain, responseData, 200);
        }

        const result = mutations.removeDependencyAtomicallyWithIdempotency({
          sourceId,
          dependsOnId,
          claim: {
            scope: "deleted_dependency",
            idempotencyKey,
            requestFingerprint,
            conflictMessage: "Idempotency key cannot be reused for a different dependency delete request",
          },
          buildResponseData: ({ sourceId: deletedSourceId, dependsOnId: deletedDependsOnId, removed, existingDependencyIds, domain: transactionDomain }) => ({
            sourceId: deletedSourceId,
            dependsOnId: deletedDependsOnId,
            removed,
            snapshotDelta: buildSnapshotDelta(transactionDomain, {
              taskIds: compactIds([transactionDomain.getTask(deletedSourceId)?.id ?? "", transactionDomain.getTask(deletedDependsOnId)?.id ?? ""]),
              subtaskIds: compactIds([transactionDomain.getSubtask(deletedSourceId)?.id ?? "", transactionDomain.getSubtask(deletedDependsOnId)?.id ?? ""]),
              deletedDependencyIds: existingDependencyIds,
            }),
          }),
        });
        const replaySnapshotDelta = readSnapshotDelta(result.responseData);
        return buildMutationResponse(domain, result.state === "replay"
          ? withFreshReplaySnapshotDelta(domain, result.responseData, {
            taskIds: compactIds([domain.getTask(sourceId)?.id ?? "", domain.getTask(dependsOnId)?.id ?? ""]),
            subtaskIds: compactIds([domain.getSubtask(sourceId)?.id ?? "", domain.getSubtask(dependsOnId)?.id ?? ""]),
            deletedDependencyIds: readStringArray(replaySnapshotDelta?.deletedDependencyIds),
          })
          : result.responseData, result.status);
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
