function cloneSnapshot(snapshot) {
  if (typeof structuredClone === "function") {
    return structuredClone(snapshot);
  }

  return JSON.parse(JSON.stringify(snapshot));
}

export function createApi(model, options) {
  const { sessionToken, rerender } = options;

  async function request(path, requestOptions = {}) {
    const headers = new Headers(requestOptions.headers || {});
    if (sessionToken.length > 0) {
      headers.set("authorization", `Bearer ${sessionToken}`);
    }
    if (requestOptions.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetch(path, { ...requestOptions, headers });
    const payload = await response.json();
    if (!payload?.ok) {
      const message = payload?.error?.message || "Board request failed";
      const error = new Error(message);
      error.code = payload?.error?.code;
      error.details = payload?.error?.details;
      throw error;
    }

    return payload.data;
  }

  async function runMutation({ optimistic, request: mutationRequest, successMessage }) {
    if (model.store.isMutating) {
      return;
    }

    const previousSnapshot = cloneSnapshot(model.store.snapshot);
    model.store.notice = null;
    model.store.isMutating = true;

    if (typeof optimistic === "function") {
      model.store.snapshot = optimistic(cloneSnapshot(model.store.snapshot));
      rerender();
    }

    try {
      const data = await mutationRequest();
      if (data?.snapshot) {
        model.replaceSnapshot(data.snapshot);
      }
      model.store.notice = successMessage ? { type: "success", message: successMessage } : null;
    } catch (error) {
      model.replaceSnapshot(previousSnapshot);
      model.store.notice = {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      model.store.isMutating = false;
      rerender();
    }
  }

  return {
    patchTask(taskId, updates, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Task saved.",
        request: () => request(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },
    patchSubtask(subtaskId, updates, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Subtask saved.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "PATCH",
          body: JSON.stringify(updates),
        }),
      });
    },
    createSubtask(input, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Subtask added.",
        request: () => request("/api/subtasks", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      });
    },
    deleteSubtask(subtaskId, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Subtask removed.",
        request: () => request(`/api/subtasks/${encodeURIComponent(subtaskId)}`, {
          method: "DELETE",
        }),
      });
    },
    addDependency(sourceId, dependsOnId, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Dependency added.",
        request: () => request("/api/dependencies", {
          method: "POST",
          body: JSON.stringify({ sourceId, dependsOnId }),
        }),
      });
    },
    removeDependency(sourceId, dependsOnId, optimistic) {
      return runMutation({
        optimistic,
        successMessage: "Dependency removed.",
        request: () => request(`/api/dependencies?sourceId=${encodeURIComponent(sourceId)}&dependsOnId=${encodeURIComponent(dependsOnId)}`, {
          method: "DELETE",
        }),
      });
    },
  };
}
