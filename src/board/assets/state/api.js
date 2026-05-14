/**
 * API layer with serial mutation queue.
 *
 * Replaces the boolean isMutating gate with a proper queue that processes
 * mutations sequentially, applies optimistic updates immediately, and
 * reverts on error.
 */

function cloneSnapshot(snapshot) {
  if (typeof structuredClone === "function") {
    return structuredClone(snapshot);
  }
  return JSON.parse(JSON.stringify(snapshot));
}

const SNAPSHOT_COLLECTIONS = ["epics", "tasks", "subtasks", "dependencies"];

const COLLECTION_TO_DELETED_KEY = {
  epics: "deletedEpicIds",
  tasks: "deletedTaskIds",
  subtasks: "deletedSubtaskIds",
  dependencies: "deletedDependencyIds",
};

function arraysShallowEqual(left, right) {
  if (left === right) return true;
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

/**
 * Shallow equality on plain board records.
 *
 * Board records are flat objects whose values are primitives or arrays of
 * primitives (e.g. dependency-id arrays). A field-by-field shallow comparison
 * is therefore equivalent to a structural deep-equal but avoids the
 * O(snapshot) JSON.stringify cost the previous implementation paid on every
 * rollback. Cross-realm values and odd nested objects fall back to
 * reference equality, which is a safe over-restore (worst case: an unchanged
 * record is included in the inverse delta).
 */
function recordsShallowEqual(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    const leftValue = left[key];
    const rightValue = right[key];
    if (leftValue === rightValue) continue;
    if (Array.isArray(leftValue) || Array.isArray(rightValue)) {
      if (!arraysShallowEqual(leftValue, rightValue)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function indexById(records) {
  const map = new Map();
  if (!Array.isArray(records)) {
    return map;
  }

  for (const record of records) {
    if (record && typeof record === "object" && typeof record.id === "string" && record.id.length > 0) {
      map.set(record.id, record);
    }
  }

  return map;
}

/**
 * Compute the inverse delta needed to revert an optimistic mutation.
 *
 * The inverse is built by diffing the snapshot _before_ the optimistic patch
 * against the snapshot _after_ the patch. We only describe entities the
 * optimistic patch actually touched so that concurrent deltas pushed by the
 * server (for unrelated entities) are preserved when we apply the inverse.
 *
 * @param {object} previousSnapshot - Snapshot prior to optimistic apply.
 * @param {object} optimisticSnapshot - Snapshot after optimistic apply.
 * @returns {{
 *   epics?: object[], tasks?: object[], subtasks?: object[], dependencies?: object[],
 *   deletedEpicIds?: string[], deletedTaskIds?: string[], deletedSubtaskIds?: string[], deletedDependencyIds?: string[],
 * }}
 */
export function computeInverseDelta(previousSnapshot, optimisticSnapshot) {
  const inverse = {};
  for (const collection of SNAPSHOT_COLLECTIONS) {
    const before = indexById(previousSnapshot?.[collection]);
    const after = indexById(optimisticSnapshot?.[collection]);

    const restored = [];
    const deletedIds = [];

    // Entities that the optimistic patch deleted -> restore them.
    for (const [id, beforeRecord] of before) {
      if (!after.has(id)) {
        restored.push(beforeRecord);
      }
    }

    // Entities present in both but mutated -> restore the previous version.
    // cloneSnapshot/normalizeSnapshot always produce fresh references for
    // every record in the optimistic snapshot, so plain reference inequality
    // would flag every entity. Use a shallow field-by-field equality check
    // instead — equivalent to a structural compare for these flat records but
    // O(field) per record rather than O(snapshot) JSON.stringify on each
    // rollback (P2 perf finding).
    for (const [id, afterRecord] of after) {
      const beforeRecord = before.get(id);
      if (beforeRecord && beforeRecord !== afterRecord && !recordsShallowEqual(beforeRecord, afterRecord)) {
        restored.push(beforeRecord);
      }
    }

    // Entities the optimistic patch added -> mark for deletion.
    for (const id of after.keys()) {
      if (!before.has(id)) {
        deletedIds.push(id);
      }
    }

    if (restored.length > 0) {
      inverse[collection] = restored;
    }
    if (deletedIds.length > 0) {
      inverse[COLLECTION_TO_DELETED_KEY[collection]] = deletedIds;
    }
  }

  return inverse;
}

/**
 * Filter an inverse delta produced by computeInverseDelta so we don't undo
 * concurrent SSE-pushed advances that landed on the same entity while a
 * mutation was in flight. Any record whose live snapshot `version` is strictly
 * greater than the optimistic `ifMatchVersion` we sent is dropped from the
 * `restored` arrays — the server-pushed state stays.
 *
 * If `optimisticVersion` is undefined/null/not-a-number we conservatively
 * return the inverse delta unchanged (back-compat: legacy mutations without an
 * If-Match version can't be reasoned about, so the original behavior wins).
 *
 * @param {object} inverseDelta - Inverse delta from computeInverseDelta.
 * @param {object|null|undefined} currentSnapshot - Latest store snapshot.
 * @param {number|null|undefined} optimisticVersion - The version we sent as If-Match.
 * @returns {object}
 */
export function stripUpToDateEntitiesFromInverse(inverseDelta, currentSnapshot, optimisticVersion) {
  if (typeof optimisticVersion !== "number" || !Number.isFinite(optimisticVersion)) {
    return inverseDelta;
  }
  if (!inverseDelta || typeof inverseDelta !== "object") {
    return inverseDelta;
  }

  const next = { ...inverseDelta };
  for (const collection of SNAPSHOT_COLLECTIONS) {
    const restored = inverseDelta[collection];
    if (!Array.isArray(restored) || restored.length === 0) continue;

    const liveRecords = Array.isArray(currentSnapshot?.[collection]) ? currentSnapshot[collection] : [];
    const liveById = indexById(liveRecords);
    const filtered = restored.filter((record) => {
      if (!record || typeof record !== "object" || typeof record.id !== "string") return true;
      const live = liveById.get(record.id);
      const liveVersion = typeof live?.version === "number" ? live.version : null;
      if (liveVersion === null) return true;
      // Drop the restore when the live snapshot's version has already advanced
      // past what we sent — an SSE delta or another mutation reconciliation
      // moved this record forward and the user must see that.
      return !(liveVersion > optimisticVersion);
    });

    if (filtered.length === 0) {
      delete next[collection];
    } else if (filtered.length !== restored.length) {
      next[collection] = filtered;
    }
  }
  return next;
}

async function readJsonPayload(response) {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`Board API returned malformed JSON (${response.status} ${response.statusText || "unknown"})`);
    error.code = "invalid_response";
    error.status = response.status;
    error.statusText = response.statusText;
    error.details = {
      responseText: text.slice(0, 240),
    };
    throw error;
  }
}

function buildRequestError(method, path, response, payload) {
  const code = payload?.error?.code;
  const routeMessage = payload?.error?.message;
  const message = routeMessage
    ? `${method} ${path} failed (${response.status}${code ? ` ${code}` : ""}): ${routeMessage}`
    : `${method} ${path} failed with ${response.status} ${response.statusText || "unknown error"}`;
  const error = new Error(message);
  error.code = code;
  error.status = response.status;
  error.statusText = response.statusText;
  error.details = payload?.error?.details;
  return error;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;

function createClientRequestId() {
  return crypto.randomUUID();
}

function createOptimisticId(prefix, clientRequestId) {
  return `optimistic:${prefix}:${clientRequestId}`;
}

function augmentSnapshotDeltaWithOptimisticDelete(snapshotDelta, key, optimisticId) {
  if (!snapshotDelta || typeof snapshotDelta !== "object" || typeof optimisticId !== "string" || optimisticId.length === 0) {
    return snapshotDelta;
  }

  const deletedKey = key === "subtasks" ? "deletedSubtaskIds" : "deletedDependencyIds";
  const deletedIds = Array.isArray(snapshotDelta[deletedKey]) ? snapshotDelta[deletedKey] : [];
  if (deletedIds.includes(optimisticId)) {
    return snapshotDelta;
  }

  return {
    ...snapshotDelta,
    [deletedKey]: [...deletedIds, optimisticId],
  };
}

function createTimeoutError(method, path, timeoutMs) {
  const error = new Error(`${method} ${path} timed out after ${timeoutMs}ms. Retry your change.`);
  error.code = "request_timeout";
  error.timeoutMs = timeoutMs;
  return error;
}

/**
 * Normalize a caller-supplied entity version into a bare integer suitable for
 * the If-Match header. The server accepts a bare integer, a quoted ETag, or a
 * W/-prefixed weak ETag (RFC 7232 §3.1) — we emit the bare integer form for
 * simplicity. Returns null when the caller didn't pass a usable version
 * (preserves back-compat with older callers that omit the argument).
 *
 * Logs a single console.warn when a non-null/non-undefined input is rejected so
 * a regression silently dropping the If-Match header is easy to spot in dev.
 */
function normalizeIfMatchVersion(version) {
  if (version === undefined || version === null) {
    return null;
  }
  if (typeof version === "number" && Number.isFinite(version) && version >= 0 && Number.isInteger(version)) {
    return String(version);
  }
  try {
    console.warn(`normalizeIfMatchVersion: ignoring non-integer/negative version ${JSON.stringify(version)} — If-Match header will be omitted`);
  } catch {
    // best-effort logging only
  }
  return null;
}

const ENTITY_KIND_COLLECTION = {
  epic: "epics",
  task: "tasks",
  subtask: "subtasks",
};

/**
 * Look up the current version of an entity from the live store snapshot.
 *
 * Resolved lazily at queue-executor fire time (rather than at action-enqueue
 * time) so a second mutation enqueued while the first is in flight reads the
 * post-success version — the server-acked snapshot landed via mutation
 * response or SSE delta before processNext shifts the next mutation off the
 * queue. Without this lazy read, rapid double-edits would carry stale
 * If-Match versions and 409.
 *
 * @param {object} storeState - The live `model.store` mutable state object.
 * @param {"epic"|"task"|"subtask"} kind
 * @param {string} id
 * @returns {number|undefined}
 */
function getCurrentVersion(storeState, kind, id) {
  const collection = ENTITY_KIND_COLLECTION[kind];
  if (!collection) return undefined;
  const records = storeState?.snapshot?.[collection];
  if (!Array.isArray(records)) return undefined;
  const record = records.find((entry) => entry?.id === id);
  return typeof record?.version === "number" ? record.version : undefined;
}

/**
 * Create a serial mutation queue.
 *
 * Mutations are enqueued and processed one at a time in FIFO order.
 * Each mutation can apply an optimistic update, make an async request,
 * and handle success or error.
 *
 * @returns {{
 *   enqueue: (mutation: object) => void,
 *   isPending: boolean,
 *   flush: () => Promise<void>,
 * }}
 */
export function createMutationQueue(model, rerender) {
  /** @type {Array<{ mutationId: string, optimistic?: function, request: function, onSuccess?: function, onError?: function, successMessage?: string, resolveIfMatch?: function }>} */
  const queue = [];
  let processing = false;
  /** @type {Array<() => void>} */
  let flushResolvers = [];

  function resolveFlushes() {
    if (processing || queue.length > 0 || flushResolvers.length === 0) {
      return;
    }

    const pendingResolvers = flushResolvers;
    flushResolvers = [];
    pendingResolvers.forEach((resolve) => resolve());
  }

  async function processNext() {
    if (processing || queue.length === 0) return;
    processing = true;
    model.store.isMutating = true;

    while (queue.length > 0) {
      const mutation = queue.shift();
      if (model.store.notice?.retryMutationId !== mutation.mutationId) {
        model.store.notice = null;
      }

      // Capture per-mutation inverse delta if the optimistic patch ran.
      // Using an inverse delta (rather than wholesale replaceSnapshot) means
      // concurrent server-pushed deltas applied to unrelated entities while
      // the request was in flight survive a rollback.
      let inverseDelta = null;

      // Resolve the If-Match version LAZILY at fire-time so a queued
      // second mutation on the same entity sees the post-success version that
      // landed via mutation response or SSE delta. Capturing at enqueue time
      // would 409 every rapid double-edit.
      let ifMatchVersion;
      if (typeof mutation.resolveIfMatch === "function") {
        try {
          ifMatchVersion = mutation.resolveIfMatch();
        } catch {
          ifMatchVersion = undefined;
        }
      }

      try {
        if (typeof mutation.optimistic === "function") {
          const previousSnapshot = model.store.snapshot;
          const optimisticSnapshot = mutation.optimistic(cloneSnapshot(previousSnapshot));
          inverseDelta = computeInverseDelta(previousSnapshot, optimisticSnapshot);
          model.store.snapshot = optimisticSnapshot;
          // Direct snapshot mutation bypasses setState/syncState; invalidate
          // the memo so the next getBoardState() reflects the optimistic write.
          if (typeof model.invalidateBoardStateMemo === "function") {
            model.invalidateBoardStateMemo();
          }
          rerender();
        }

        const data = await mutation.request({ ifMatchVersion });

        if (data?.snapshot) {
          model.replaceSnapshot(data.snapshot);
        } else if (data?.snapshotDelta) {
          model.applySnapshotDelta(data.snapshotDelta);
        }

        if (typeof mutation.onSuccess === "function") {
          mutation.onSuccess(data);
        }

        model.store.notice = mutation.successMessage
          ? { type: "success", message: mutation.successMessage }
          : null;
      } catch (error) {
        const isStaleVersion = error?.code === "precondition_failed";

        // Revert only the entities this mutation touched, but ALSO drop any
        // entity whose live store version has already advanced past the
        // optimistic version we sent: that means an SSE delta (or another
        // queued mutation reconciliation) landed mid-flight and clobbering it
        // with the pre-optimistic record would lose the user's most recent
        // server-authoritative state.
        const adjustedInverseDelta = inverseDelta
          ? stripUpToDateEntitiesFromInverse(inverseDelta, model.store?.snapshot, ifMatchVersion)
          : null;

        if (adjustedInverseDelta) {
          model.applySnapshotDelta(adjustedInverseDelta);
        }

        if (isStaleVersion) {
          // Typed `stale_version` notice — no retry button because replaying
          // the optimistic payload against the post-advance state would 409
          // again. The user needs to refresh to compose against latest.
          model.store.notice = {
            type: "warning",
            code: "stale_version",
            title: "Stale update",
            message: "Updated by another session — refresh to load the latest version.",
          };
        } else {
          const message = error instanceof Error ? error.message : String(error);
          model.store.notice = {
            type: "error",
            title: "Action failed",
            message,
            retryLabel: "Retry",
            retryMutationId: mutation.mutationId,
          };
        }

        if (typeof mutation.onError === "function") {
          mutation.onError(error);
        }
      }
    }

    processing = false;
    model.store.isMutating = false;
    if (typeof model.invalidateBoardStateMemo === "function") {
      model.invalidateBoardStateMemo();
    }
    rerender();
    resolveFlushes();
  }

  return {
    enqueue(mutation) {
      queue.push({
        ...mutation,
        mutationId: mutation.mutationId ?? crypto.randomUUID(),
      });
      processNext();
    },

    get isPending() {
      return processing || queue.length > 0;
    },

    flush() {
      if (!processing && queue.length === 0) return Promise.resolve();
      return new Promise((resolve) => {
        flushResolvers.push(resolve);
      });
    },
  };
}

/**
 * Create the API layer with mutation queue.
 *
 * @param {object} model - Store model from createStore
 * @param {object} options
 * @param {string} options.sessionToken - Auth token for API requests
 * @param {function} options.rerender - Trigger a UI rerender
 * @returns {object} API methods: patchTask, patchSubtask, createSubtask, deleteSubtask, addDependency, removeDependency
 */
export function createApi(model, options) {
  const { sessionToken, rerender, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = options;
  let lastFailedMutation = null;

  function enqueueMutation(definition) {
    // Assign a stable identity token so success callbacks can clear
    // lastFailedMutation by id rather than by function-reference equality
    // (inline arrow functions are never the same reference across retries).
    const mutationId = crypto.randomUUID();
    const tagged = { ...definition, mutationId };

    queue.enqueue({
      ...tagged,
      onSuccess(data) {
        if (lastFailedMutation?.mutationId === mutationId) {
          lastFailedMutation = null;
        }
        if (typeof tagged.onSuccess === "function") {
          tagged.onSuccess(data);
        }
      },
      onError(error) {
        lastFailedMutation = tagged;
        if (typeof tagged.onError === "function") {
          tagged.onError(error);
        }
      },
    });
  }

  async function request(path, requestOptions = {}) {
    const method = typeof requestOptions.method === "string" ? requestOptions.method.toUpperCase() : "GET";
    const headers = new Headers(requestOptions.headers || {});
    const timeoutMs = Number.isFinite(requestOptions.timeoutMs) && requestOptions.timeoutMs > 0
      ? requestOptions.timeoutMs
      : requestTimeoutMs;
    if (sessionToken.length > 0) {
      headers.set("authorization", `Bearer ${sessionToken}`);
    }
    if (requestOptions.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort(createTimeoutError(method, path, timeoutMs));
    }, timeoutMs);

    try {
      response = await fetch(path, { ...requestOptions, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        throw controller.signal.reason instanceof Error
          ? controller.signal.reason
          : createTimeoutError(method, path, timeoutMs);
      }
      const message = error instanceof Error ? error.message : String(error);
      const requestError = new Error(`${method} ${path} failed before a response was received: ${message}`);
      requestError.code = "network_error";
      requestError.cause = error;
      throw requestError;
    } finally {
      clearTimeout(timeoutId);
    }

    const payload = await readJsonPayload(response);
    if (!response.ok || !payload?.ok) {
      throw buildRequestError(method, path, response, payload);
    }

    return payload.data;
  }

  const queue = createMutationQueue(model, rerender);

  return {
    retryLastFailedMutation() {
      if (!lastFailedMutation) {
        return false;
      }
      enqueueMutation(lastFailedMutation);
      return true;
    },

    patchEpic(epicId, updates, optimistic, options) {
      // Per-call override wins; otherwise read the live store at fire-time so
      // queued back-to-back edits on the same entity carry the post-success
      // version rather than a stale enqueue-time snapshot.
      const explicitVersion = options?.ifMatchVersion;
      const resolveIfMatch = explicitVersion !== undefined
        ? () => explicitVersion
        : () => getCurrentVersion(model.store, "epic", epicId);
      enqueueMutation({
        optimistic,
        successMessage: "Epic saved.",
        entityKind: "epic",
        entityId: epicId,
        resolveIfMatch,
        request: ({ ifMatchVersion } = {}) => {
          const ifMatch = normalizeIfMatchVersion(ifMatchVersion);
          return request(`/api/epics/${encodeURIComponent(epicId)}`, {
            method: "PATCH",
            headers: ifMatch !== null ? { "if-match": ifMatch } : undefined,
            body: JSON.stringify(updates),
          });
        },
      });
    },

    patchTask(taskId, updates, optimistic, options) {
      const explicitVersion = options?.ifMatchVersion;
      const resolveIfMatch = explicitVersion !== undefined
        ? () => explicitVersion
        : () => getCurrentVersion(model.store, "task", taskId);
      enqueueMutation({
        optimistic,
        successMessage: "Task saved.",
        entityKind: "task",
        entityId: taskId,
        resolveIfMatch,
        request: ({ ifMatchVersion } = {}) => {
          const ifMatch = normalizeIfMatchVersion(ifMatchVersion);
          return request(`/api/tasks/${encodeURIComponent(taskId)}`, {
            method: "PATCH",
            headers: ifMatch !== null ? { "if-match": ifMatch } : undefined,
            body: JSON.stringify(updates),
          });
        },
      });
    },

    patchSubtask(subtaskId, updates, optimistic, options) {
      const explicitVersion = options?.ifMatchVersion;
      const resolveIfMatch = explicitVersion !== undefined
        ? () => explicitVersion
        : () => getCurrentVersion(model.store, "subtask", subtaskId);
      enqueueMutation({
        optimistic,
        successMessage: "Subtask saved.",
        entityKind: "subtask",
        entityId: subtaskId,
        resolveIfMatch,
        request: ({ ifMatchVersion } = {}) => {
          const ifMatch = normalizeIfMatchVersion(ifMatchVersion);
          return request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
            method: "PATCH",
            headers: ifMatch !== null ? { "if-match": ifMatch } : undefined,
            body: JSON.stringify(updates),
          });
        },
      });
    },

    cascadeEpicStatus(epicId, status, optimistic, options) {
      const explicitVersion = options?.ifMatchVersion;
      const resolveIfMatch = explicitVersion !== undefined
        ? () => explicitVersion
        : () => getCurrentVersion(model.store, "epic", epicId);
      enqueueMutation({
        optimistic,
        successMessage: "Epic cascade status updated.",
        entityKind: "epic",
        entityId: epicId,
        resolveIfMatch,
        request: ({ ifMatchVersion } = {}) => {
          const ifMatch = normalizeIfMatchVersion(ifMatchVersion);
          return request(`/api/epics/${encodeURIComponent(epicId)}/cascade`, {
            method: "PATCH",
            headers: ifMatch !== null ? { "if-match": ifMatch } : undefined,
            body: JSON.stringify({ status }),
          });
        },
      });
    },

    createSubtask(input, optimistic) {
      const clientRequestId = createClientRequestId();
      const optimisticId = createOptimisticId("subtask", clientRequestId);
      enqueueMutation({
        optimistic: typeof optimistic === "function"
          ? (snapshot) => optimistic(snapshot, optimisticId)
          : optimistic,
        successMessage: "Subtask added.",
        request: async () => {
          const data = await request("/api/subtasks", {
            method: "POST",
            headers: {
              "x-trekoon-idempotency-key": clientRequestId,
            },
            body: JSON.stringify({ ...input, clientRequestId }),
          });
          return data?.snapshotDelta
            ? {
              ...data,
              snapshotDelta: augmentSnapshotDeltaWithOptimisticDelete(data.snapshotDelta, "subtasks", optimisticId),
            }
            : data;
        },
      });
    },

    deleteSubtask(subtaskId, optimistic) {
      const clientRequestId = createClientRequestId();
      enqueueMutation({
        optimistic,
        successMessage: "Subtask removed.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "DELETE",
          headers: {
            "x-trekoon-idempotency-key": clientRequestId,
          },
        }),
      });
    },

    addDependency(sourceId, dependsOnId, optimistic) {
      const clientRequestId = createClientRequestId();
      const optimisticId = createOptimisticId("dependency", clientRequestId);
      enqueueMutation({
        optimistic: typeof optimistic === "function"
          ? (snapshot) => optimistic(snapshot, optimisticId)
          : optimistic,
        successMessage: "Dependency added.",
        request: async () => {
          const data = await request("/api/dependencies", {
            method: "POST",
            headers: {
              "x-trekoon-idempotency-key": clientRequestId,
            },
            body: JSON.stringify({ sourceId, dependsOnId, clientRequestId }),
          });
          return data?.snapshotDelta
            ? {
              ...data,
              snapshotDelta: augmentSnapshotDeltaWithOptimisticDelete(data.snapshotDelta, "dependencies", optimisticId),
            }
            : data;
        },
      });
    },

    removeDependency(sourceId, dependsOnId, optimistic) {
      const clientRequestId = createClientRequestId();
      enqueueMutation({
        optimistic,
        successMessage: "Dependency removed.",
        request: () => request(`/api/dependencies?sourceId=${encodeURIComponent(sourceId)}&dependsOnId=${encodeURIComponent(dependsOnId)}`, {
          method: "DELETE",
          headers: {
            "x-trekoon-idempotency-key": clientRequestId,
          },
        }),
      });
    },
  };
}

/**
 * Subscribe the board client to /api/snapshot/stream.
 *
 * Receives `snapshotDelta` events emitted by the per-server-instance event bus
 * (own server mutations + WAL-watcher-derived deltas from external CLI writes)
 * and applies them via `model.applySnapshotDelta`. Idempotent merge means
 * re-applying a delta we already saw via the mutation response is harmless.
 *
 * Returns a `dispose()` function that closes the EventSource and stops
 * processing further events.
 *
 * @param {object} model - Store with `applySnapshotDelta` method
 * @param {object} options
 * @param {string} options.sessionToken - Auth token for API parity; EventSource uses the same-origin HttpOnly cookie.
 * @param {function} options.rerender - Trigger UI rerender after applying deltas
 * @param {typeof EventSource} [options.EventSourceCtor] - Constructor override for tests
 * @param {string} [options.path] - Override stream path; default /api/snapshot/stream
 * @returns {{ dispose: () => void, eventSource: EventSource | null }}
 */
export function subscribeSnapshotStream(model, options) {
  const {
    rerender,
    EventSourceCtor = typeof EventSource !== "undefined" ? EventSource : null,
    path = "/api/snapshot/stream",
  } = options ?? {};

  if (!EventSourceCtor) {
    return { dispose: () => {}, eventSource: null };
  }

  let disposed = false;
  let consecutiveErrors = 0;
  const eventSource = new EventSourceCtor(path);

  const clearLiveUpdateNotice = () => {
    if (model.store?.notice?.code === "live_updates_disconnected") {
      model.store.notice = null;
    }
  };

  const markLiveUpdateSuccess = () => {
    consecutiveErrors = 0;
    clearLiveUpdateNotice();
  };

  const handleSnapshotDelta = (event) => {
    if (disposed) return;
    const raw = typeof event?.data === "string" ? event.data : "";
    if (raw.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Surface malformed payloads so operators can spot serialization bugs.
      // Avoid logging the raw text (may include sensitive content) — just length + error.
      console.warn(`subscribeSnapshotStream: malformed snapshotDelta JSON (${raw.length} bytes): ${message}`);
      return;
    }
    const delta = payload?.snapshotDelta;
    if (!delta || typeof delta !== "object") return;
    model.applySnapshotDelta(delta);
    markLiveUpdateSuccess();
    if (typeof rerender === "function") rerender();
  };

  const handleSnapshot = (event) => {
    if (disposed) return;
    const raw = typeof event?.data === "string" ? event.data : "";
    if (raw.length === 0) return;
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`subscribeSnapshotStream: malformed snapshot JSON (${raw.length} bytes): ${message}`);
      return;
    }
    const snapshot = payload?.snapshot;
    if (!snapshot || typeof snapshot !== "object") return;
    if (typeof model.replaceSnapshot === "function") {
      model.replaceSnapshot(snapshot);
      markLiveUpdateSuccess();
      if (typeof rerender === "function") rerender();
    }
  };

  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      eventSource.close();
    } catch {
      // best-effort
    }
  }

  const handleError = () => {
    if (disposed) return;
    consecutiveErrors += 1;
    if (model.store && typeof model.store === "object") {
      const existing = model.store.notice;
      const disabled = consecutiveErrors >= 5;
      const nextCode = disabled ? "live_updates_disabled" : "live_updates_disconnected";
      if (!existing || existing.code !== nextCode) {
        model.store.notice = {
          type: "warning",
          code: nextCode,
          title: disabled ? "Live updates disabled" : "Live updates disconnected",
          message: disabled
            ? "Refresh the board to resume live updates from other sessions."
            : "Reconnecting to the server. Changes from other sessions may be delayed.",
        };
        if (typeof rerender === "function") rerender();
      }
      if (disabled) {
        dispose();
      }
    }
  };

  eventSource.addEventListener("snapshotDelta", handleSnapshotDelta);
  eventSource.addEventListener("snapshot", handleSnapshot);
  // EventSource calls .onerror on disconnect (and will continue auto-reconnecting).
  // Use the onerror property rather than addEventListener("error") so tests can
  // trigger it via `instance.onerror?.()` without a full event object.
  eventSource.onerror = handleError;

  return {
    eventSource,
    dispose,
  };
}
