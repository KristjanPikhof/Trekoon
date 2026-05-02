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
    for (const [id, afterRecord] of after) {
      const beforeRecord = before.get(id);
      if (beforeRecord && beforeRecord !== afterRecord && JSON.stringify(beforeRecord) !== JSON.stringify(afterRecord)) {
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
  /** @type {Array<{ optimistic?: function, request: function, onSuccess?: function, onError?: function, successMessage?: string }>} */
  const queue = [];
  let processing = false;
  let nextMutationId = 1;
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
      if (model.store.notice?.retryMutationId !== mutation.id) {
        model.store.notice = null;
      }

      // Capture per-mutation inverse delta if the optimistic patch ran.
      // Using an inverse delta (rather than wholesale replaceSnapshot) means
      // concurrent server-pushed deltas applied to unrelated entities while
      // the request was in flight survive a rollback.
      let inverseDelta = null;

      try {
        if (typeof mutation.optimistic === "function") {
          const previousSnapshot = cloneSnapshot(model.store.snapshot);
          const optimisticSnapshot = mutation.optimistic(cloneSnapshot(model.store.snapshot));
          inverseDelta = computeInverseDelta(previousSnapshot, optimisticSnapshot);
          model.store.snapshot = optimisticSnapshot;
          rerender();
        }

        const data = await mutation.request();

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
        // Revert only the entities this mutation touched. Any unrelated
        // entities updated by concurrent server deltas remain intact.
        if (inverseDelta) {
          model.applySnapshotDelta(inverseDelta);
        }

        const message = error instanceof Error ? error.message : String(error);
        model.store.notice = {
          type: "error",
          title: "Action failed",
          message,
          retryLabel: "Retry",
          retryMutationId: mutation.id,
        };

        if (typeof mutation.onError === "function") {
          mutation.onError(error);
        }
      }
    }

    processing = false;
    model.store.isMutating = false;
    rerender();
    resolveFlushes();
  }

  return {
    enqueue(mutation) {
      queue.push({ ...mutation, id: nextMutationId });
      nextMutationId += 1;
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

    patchEpic(epicId, updates, optimistic) {
      enqueueMutation({
        optimistic,
        successMessage: "Epic saved.",
        request: () => request(`/api/epics/${encodeURIComponent(epicId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },

    patchTask(taskId, updates, optimistic) {
      enqueueMutation({
        optimistic,
        successMessage: "Task saved.",
        request: () => request(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },

    patchSubtask(subtaskId, updates, optimistic) {
      enqueueMutation({
        optimistic,
        successMessage: "Subtask saved.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },

    cascadeEpicStatus(epicId, status, optimistic) {
      enqueueMutation({
        optimistic,
        successMessage: "Epic cascade status updated.",
        request: () => request(`/api/epics/${encodeURIComponent(epicId)}/cascade`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        }),
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
