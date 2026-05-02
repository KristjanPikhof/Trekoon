import { type Database } from "bun:sqlite";

import { safeErrorMessage } from "../commands/error-utils";
import { MutationService, PreconditionFailedError } from "../domain/mutation-service";
import { TrackerDomain } from "../domain/tracker-domain";
import { DomainError } from "../domain/types";
import { type BoardEventBus } from "./event-bus";
import { buildBoardSnapshot, buildBoardSnapshotDelta } from "./snapshot";

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
  readonly eventBus?: BoardEventBus;
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

function readCookieToken(request: Request): string | null {
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

  return readCookieToken(request);
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

function publishSnapshotDeltaIfPresent(
  eventBus: BoardEventBus | undefined,
  data: Record<string, unknown>,
): void {
  if (!eventBus) {
    return;
  }

  const delta = readSnapshotDelta(data);
  if (delta) {
    eventBus.publishSnapshotDelta(delta);
  }
}

function formatSseEvent(eventName: string, data: unknown, id?: number): string {
  const idLine = id === undefined ? "" : `id: ${id}\n`;
  return `${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openSnapshotStream(
  request: Request,
  domain: TrackerDomain,
  eventBus: BoardEventBus | undefined,
): Response {
  if (!eventBus) {
    return jsonResponse(503, {
      ok: false,
      error: {
        code: "stream_unavailable",
        message: "Snapshot stream is not available on this server",
      },
    });
  }

  const encoder = new TextEncoder();
  const initialSnapshot = buildBoardSnapshot(domain);
  let unsubscribe: (() => void) | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller): void {
      const enqueue = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller closed; cleanup will happen via cancel.
        }
      };

      // Initial snapshot so late-joining tabs converge immediately.
      enqueue(formatSseEvent("snapshot", { snapshot: initialSnapshot }));

      unsubscribe = eventBus.subscribe((event) => {
        if (event.type === "snapshotDelta") {
          enqueue(formatSseEvent("snapshotDelta", { snapshotDelta: event.snapshotDelta }, event.id));
        }
      });

      // Heartbeats keep proxies and stale-connection detectors happy.
      heartbeatTimer = setInterval(() => {
        enqueue(": heartbeat\n\n");
      }, 15000);

      const onAbort = (): void => {
        if (unsubscribe) {
          unsubscribe();
          unsubscribe = null;
        }
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };

      if (request.signal.aborted) {
        onAbort();
        return;
      }
      request.signal.addEventListener("abort", onAbort);
    },
    cancel(): void {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

function buildMutationResponse(_domain: TrackerDomain, data: Record<string, unknown>, status = 200): Response {
  return jsonResponse(status, {
    ok: true,
    data,
  });
}

const buildSnapshotDelta = buildBoardSnapshotDelta;

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

function parseIfMatchHeader(request: Request): number | null {
  const raw = request.headers.get("if-match");
  if (raw === null) {
    return null;
  }

  // RFC 7232 §3.1 allows a strong ETag (`"<value>"`) or a weak ETag
  // (`W/"<value>"`). Trekoon does not differentiate strong from weak
  // semantics — a millisecond updatedAt is exact either way — so we
  // accept both shapes. The wildcard `*` is intentionally NOT supported:
  // it would mean "any current representation matches" and would defeat
  // the whole purpose of the optimistic-concurrency check, so we surface
  // it as 400 invalid_input below rather than treating it as a no-op.
  const stripped = raw.trim().replace(/^W\//iu, "");
  const trimmed = stripped.replace(/^"+|"+$/g, "");
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new DomainError({
      code: "invalid_input",
      message:
        "If-Match header must be an integer updatedAt millisecond timestamp (RFC 7232 strong or W/-prefixed weak ETag); the `*` wildcard is not supported",
      details: { header: "If-Match", value: raw },
    });
  }

  return parsed;
}

interface PreconditionFailedDetails {
  readonly entityKind: "epic" | "task" | "subtask";
  readonly entityId: string;
  readonly currentUpdatedAt: number;
  readonly providedUpdatedAt: number;
}

function preconditionFailedResponse(details: PreconditionFailedDetails): Response {
  return jsonResponse(409, {
    ok: false,
    error: {
      code: "precondition_failed",
      message: "If-Match version does not match current updatedAt",
      details: {
        entityKind: details.entityKind,
        entityId: details.entityId,
        currentUpdatedAt: details.currentUpdatedAt,
        providedUpdatedAt: details.providedUpdatedAt,
      },
    },
  });
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
    // Plain `!==` instead of a constant-time compare is a deliberate choice
    // (System Hardening 0.4.2, finding 32). The board server only binds to
    // 127.0.0.1, the session token is a 256-bit cryptographically-random
    // value rotated per board-server lifetime, and the comparison happens
    // against an in-memory string — there is no remote-timing side-channel
    // realistic enough to attack. Adopting `crypto.timingSafeEqual` would
    // also require handling length-mismatch as a separate non-leaking case.
    // Re-evaluate this decision if the board server ever listens on a
    // non-loopback interface or uses a low-entropy / static token.
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
    const eventBus = context.eventBus;

    const respondWithMutation = (
      domainArg: TrackerDomain,
      data: Record<string, unknown>,
      status = 200,
    ): Response => {
      publishSnapshotDeltaIfPresent(eventBus, data);
      return buildMutationResponse(domainArg, data, status);
    };

    const respondWithMutationDelta = (
      domainArg: TrackerDomain,
      data: Record<string, unknown>,
      selection: SnapshotDeltaSelection,
      status = 200,
    ): Response => {
      const enrichedData = { ...data, snapshotDelta: buildSnapshotDelta(domainArg, selection) };
      publishSnapshotDeltaIfPresent(eventBus, enrichedData);
      return buildMutationResponse(domainArg, enrichedData, status);
    };

    try {
      if (request.method === "GET" && url.pathname === "/api/snapshot") {
        return jsonResponse(200, {
          ok: true,
          data: {
            snapshot: buildBoardSnapshot(domain),
          },
        });
      }

      if (request.method === "GET" && url.pathname === "/api/snapshot/stream") {
        return openSnapshotStream(request, domain, eventBus);
      }

        const epicCascadeMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/epics\/([^/]+)\/cascade$/u) : null;
        if (epicCascadeMatch) {
          const epicId = epicCascadeMatch[1] ?? "";
          const body = await parseJsonBody(request);
          const status = readRequiredString(body, "status");
          const ifMatch = parseIfMatchHeader(request);
          // CAS path: precondition is enforced inside the write transaction
          // (see PreconditionFailedError catch below). Missing-header path
          // preserves back-compat with clients that don't send If-Match.
          const plan = ifMatch !== null
            ? mutations.updateEpicStatusCascadeWithIfMatch(epicId, ifMatch, status)
            : mutations.updateEpicStatusCascade(epicId, status);
          return respondWithMutationDelta(domain, {
            plan,
          }, {
            epicIds: [epicId],
            taskIds: plan.orderedChanges.filter((change) => change.kind === "task").map((change) => change.id),
            subtaskIds: plan.orderedChanges.filter((change) => change.kind === "subtask").map((change) => change.id),
          });
        }

      const epicMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/epics\/([^/]+)$/u) : null;
        if (epicMatch) {
        const epicId = epicMatch[1] ?? "";
        const body = await parseJsonBody(request);
        const ifMatch = parseIfMatchHeader(request);
        const epicInput = {
          title: readOptionalString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
        };
        const epic = ifMatch !== null
          ? mutations.updateEpicWithIfMatch(epicId, ifMatch, epicInput)
          : mutations.updateEpic(epicId, epicInput);
          return respondWithMutationDelta(domain, { epic }, { epicIds: [epic.id] });
        }

      const taskMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/tasks\/([^/]+)$/u) : null;
      if (taskMatch) {
        const taskId = taskMatch[1] ?? "";
        const body = await parseJsonBody(request);
        const ifMatch = parseIfMatchHeader(request);
        const taskInput = {
          title: readOptionalString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
          owner: readOptionalNullableString(body, "owner"),
        };
        const task = ifMatch !== null
          ? mutations.updateTaskWithIfMatch(taskId, ifMatch, taskInput)
          : mutations.updateTask(taskId, taskInput);
          return respondWithMutationDelta(domain, { task }, { epicIds: [task.epicId], taskIds: [task.id] });
        }

      const subtaskMatch = request.method === "PATCH" ? url.pathname.match(/^\/api\/subtasks\/([^/]+)$/u) : null;
      if (subtaskMatch) {
        const subtaskId = subtaskMatch[1] ?? "";
        const body = await parseJsonBody(request);
        const ifMatch = parseIfMatchHeader(request);
        const subtaskInput = {
          title: readOptionalString(body, "title"),
          description: readOptionalString(body, "description"),
          status: readOptionalString(body, "status"),
          owner: readOptionalNullableString(body, "owner"),
        };
        const subtask = ifMatch !== null
          ? mutations.updateSubtaskWithIfMatch(subtaskId, ifMatch, subtaskInput)
          : mutations.updateSubtask(subtaskId, subtaskInput);
          const task = domain.getTaskOrThrow(subtask.taskId);
          return respondWithMutationDelta(domain, { subtask }, { epicIds: [task.epicId], taskIds: [task.id], subtaskIds: [subtask.id] });
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
          return respondWithMutation(domain, responseData, 201);
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
        return respondWithMutation(domain, result.state === "replay"
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
            return respondWithMutation(domain, responseData, 200);
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
          return respondWithMutation(domain, result.state === "replay"
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
          return respondWithMutation(domain, responseData, 201);
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
        return respondWithMutation(domain, result.state === "replay"
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
          return respondWithMutation(domain, responseData, 200);
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
        return respondWithMutation(domain, result.state === "replay"
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
      // PreconditionFailedError is a typed signal from the *WithIfMatch
      // CAS variants. It carries the freshly-fetched currentUpdatedAt so
      // the 409 payload is always consistent with the post-rollback state.
      if (error instanceof PreconditionFailedError) {
        return preconditionFailedResponse({
          entityKind: error.entityKind,
          entityId: error.entityId,
          currentUpdatedAt: error.currentUpdatedAt,
          providedUpdatedAt: error.providedUpdatedAt,
        });
      }

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
