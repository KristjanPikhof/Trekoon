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
      const previousSnapshot = cloneSnapshot(model.store.snapshot);
      model.store.notice = null;

      // Apply optimistic update
      if (typeof mutation.optimistic === "function") {
        model.store.snapshot = mutation.optimistic(cloneSnapshot(model.store.snapshot));
        rerender();
      }

      try {
        const data = await mutation.request();

        if (data?.snapshot) {
          model.replaceSnapshot(data.snapshot);
        }

        if (typeof mutation.onSuccess === "function") {
          mutation.onSuccess(data);
        }

        model.store.notice = mutation.successMessage
          ? { type: "success", message: mutation.successMessage }
          : null;
      } catch (error) {
        // Revert to pre-optimistic snapshot
        model.replaceSnapshot(previousSnapshot);

        const message = error instanceof Error ? error.message : String(error);
        model.store.notice = { type: "error", message };

        if (typeof mutation.onError === "function") {
          mutation.onError(error);
        }

        // Clear remaining queue on error to prevent cascading failures
        queue.length = 0;
      }
    }

    processing = false;
    model.store.isMutating = false;
    rerender();
    resolveFlushes();
  }

  return {
    enqueue(mutation) {
      queue.push(mutation);
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
  const { sessionToken, rerender } = options;

  async function request(path, requestOptions = {}) {
    const method = typeof requestOptions.method === "string" ? requestOptions.method.toUpperCase() : "GET";
    const headers = new Headers(requestOptions.headers || {});
    if (sessionToken.length > 0) {
      headers.set("authorization", `Bearer ${sessionToken}`);
    }
    if (requestOptions.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    let response;
    try {
      response = await fetch(path, { ...requestOptions, headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const requestError = new Error(`${method} ${path} failed before a response was received: ${message}`);
      requestError.code = "network_error";
      requestError.cause = error;
      throw requestError;
    }

    const payload = await readJsonPayload(response);
    if (!response.ok || !payload?.ok) {
      throw buildRequestError(method, path, response, payload);
    }

    return payload.data;
  }

  const queue = createMutationQueue(model, rerender);

  return {
    patchEpic(epicId, updates, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Epic saved.",
        request: () => request(`/api/epics/${encodeURIComponent(epicId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },

    patchTask(taskId, updates, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Task saved.",
        request: () => request(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },

    patchSubtask(subtaskId, updates, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Subtask saved.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },

    cascadeEpicStatus(epicId, status, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Epic cascade status updated.",
        request: () => request(`/api/epics/${encodeURIComponent(epicId)}/cascade`, {
          method: "PATCH",
          body: JSON.stringify({ status }),
        }),
      });
    },

    createSubtask(input, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Subtask added.",
        request: () => request("/api/subtasks", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      });
    },

    deleteSubtask(subtaskId, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Subtask removed.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "DELETE",
        }),
      });
    },

    addDependency(sourceId, dependsOnId, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Dependency added.",
        request: () => request("/api/dependencies", {
          method: "POST",
          body: JSON.stringify({ sourceId, dependsOnId }),
        }),
      });
    },

    removeDependency(sourceId, dependsOnId, optimistic) {
      queue.enqueue({
        optimistic,
        successMessage: "Dependency removed.",
        request: () => request(`/api/dependencies?sourceId=${encodeURIComponent(sourceId)}&dependsOnId=${encodeURIComponent(dependsOnId)}`, {
          method: "DELETE",
        }),
      });
    },
  };
}
