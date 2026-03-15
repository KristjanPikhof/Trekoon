function cloneSnapshot(snapshot) {
  if (typeof structuredClone === "function") {
    return structuredClone(snapshot);
  }

  return JSON.parse(JSON.stringify(snapshot));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function updateTaskInSnapshot(snapshot, taskId, updates, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const task = nextSnapshot.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return snapshot;
  }

  if (updates.title !== undefined) task.title = updates.title;
  if (updates.description !== undefined) task.description = updates.description;
  if (updates.status !== undefined) task.status = updates.status;
  task.updatedAt = Date.now();
  return normalizeSnapshot(nextSnapshot);
}

export function updateSubtaskInSnapshot(snapshot, subtaskId, updates, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const subtask = nextSnapshot.subtasks.find((candidate) => candidate.id === subtaskId);
  if (!subtask) {
    return snapshot;
  }

  if (updates.title !== undefined) subtask.title = updates.title;
  if (updates.description !== undefined) subtask.description = updates.description;
  if (updates.status !== undefined) subtask.status = updates.status;
  subtask.updatedAt = Date.now();
  return normalizeSnapshot(nextSnapshot);
}

export function addDependencyInSnapshot(snapshot, sourceId, dependsOnId, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const duplicate = normalizeArray(nextSnapshot.dependencies).some(
    (dependency) => dependency.sourceId === sourceId && dependency.dependsOnId === dependsOnId,
  );
  if (!duplicate) {
    normalizeArray(nextSnapshot.dependencies).push({
      id: crypto.randomUUID(),
      sourceId,
      sourceKind: nextSnapshot.subtasks.some((subtask) => subtask.id === sourceId) ? "subtask" : "task",
      dependsOnId,
      dependsOnKind: nextSnapshot.subtasks.some((subtask) => subtask.id === dependsOnId) ? "subtask" : "task",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  return normalizeSnapshot(nextSnapshot);
}

export function removeDependencyInSnapshot(snapshot, sourceId, dependsOnId, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.dependencies = normalizeArray(nextSnapshot.dependencies).filter(
    (dependency) => !(dependency.sourceId === sourceId && dependency.dependsOnId === dependsOnId),
  );
  return normalizeSnapshot(nextSnapshot);
}

export function createSubtaskInSnapshot(snapshot, input, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  normalizeArray(nextSnapshot.subtasks).push({
    id: crypto.randomUUID(),
    taskId: input.taskId,
    title: input.title,
    description: input.description ?? "",
    status: input.status ?? "todo",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return normalizeSnapshot(nextSnapshot);
}

export function deleteSubtaskInSnapshot(snapshot, subtaskId, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  nextSnapshot.subtasks = normalizeArray(nextSnapshot.subtasks).filter((candidate) => candidate.id !== subtaskId);
  nextSnapshot.dependencies = normalizeArray(nextSnapshot.dependencies).filter(
    (dependency) => dependency.sourceId !== subtaskId && dependency.dependsOnId !== subtaskId,
  );
  return normalizeSnapshot(nextSnapshot);
}

export function createBoardActions(options) {
  const {
    model,
    api,
    rerender,
    normalizeSnapshot,
    normalizeStatus,
    applyTheme,
    searchFocusKeys,
  } = options;
  const { store, persist, getTaskById, getVisibleTasks } = model;

  return {
    toggleTheme() {
      store.theme = store.theme === "dark" ? "light" : "dark";
      applyTheme(store.theme);
      rerender();
    },
    updateSearch(value) {
      store.search = value;
      if (store.selectedTaskId && !getVisibleTasks().some((task) => task.id === store.selectedTaskId)) {
        store.selectedTaskId = null;
        store.selectedSubtaskId = null;
      }
      persist();
      rerender();
    },
    openEpic(epicId) {
      store.screen = "tasks";
      store.selectedEpicId = epicId || null;
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
      persist();
      rerender();
    },
    selectEpic(epicId) {
      store.screen = "tasks";
      store.selectedEpicId = epicId || null;
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
      persist();
      rerender();
    },
    showEpics() {
      store.screen = "epics";
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
      persist();
      rerender();
    },
    showBoard() {
      const fallbackEpicId = store.selectedEpicId || store.snapshot.epics[0]?.id || null;
      if (!fallbackEpicId) {
        return;
      }

      store.screen = "tasks";
      store.selectedEpicId = fallbackEpicId;
      persist();
      rerender();
    },
    setView(view) {
      store.view = view;
      persist();
      rerender();
    },
    selectTask(taskId) {
      if (!taskId) {
        return;
      }
      store.selectedTaskId = taskId;
      persist();
      rerender();
    },
    closeTask() {
      store.selectedTaskId = null;
      store.selectedSubtaskId = null;
      persist();
      rerender();
    },
    openSubtask(subtaskId) {
      store.selectedSubtaskId = subtaskId || null;
      rerender();
    },
    closeSubtask() {
      store.selectedSubtaskId = null;
      rerender();
    },
    submitTaskForm(taskId, formData) {
      const updates = {
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        status: normalizeStatus(String(formData.get("status") || "todo")),
      };
      api.patchTask(taskId, updates, (snapshot) => updateTaskInSnapshot(snapshot, taskId, updates, normalizeSnapshot));
    },
    submitSubtaskForm(subtaskId, formData) {
      const updates = {
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        status: normalizeStatus(String(formData.get("status") || "todo")),
      };
      store.selectedSubtaskId = subtaskId;
      api.patchSubtask(subtaskId, updates, (snapshot) => updateSubtaskInSnapshot(snapshot, subtaskId, updates, normalizeSnapshot));
    },
    submitCreateSubtask(taskId, formData) {
      const input = {
        taskId,
        title: String(formData.get("title") || "").trim(),
        description: String(formData.get("description") || "").trim(),
        status: normalizeStatus(String(formData.get("status") || "todo")),
      };

      if (!taskId || input.title.length === 0) {
        store.notice = { type: "error", message: "Subtasks need a title before they can be added." };
        rerender();
        return;
      }

      api.createSubtask(input, (snapshot) => createSubtaskInSnapshot(snapshot, input, normalizeSnapshot));
    },
    deleteSubtask(subtaskId) {
      if (!subtaskId) {
        return;
      }

      api.deleteSubtask(subtaskId, (snapshot) => deleteSubtaskInSnapshot(snapshot, subtaskId, normalizeSnapshot));
    },
    addDependency(sourceId, formData) {
      const dependsOnId = String(formData.get("dependsOnId") || "").trim();
      if (!dependsOnId) {
        store.notice = { type: "error", message: "Choose a dependency target first." };
        rerender();
        return;
      }

      api.addDependency(sourceId, dependsOnId, (snapshot) => addDependencyInSnapshot(snapshot, sourceId, dependsOnId, normalizeSnapshot));
    },
    removeDependency(sourceId, dependsOnId) {
      api.removeDependency(sourceId, dependsOnId, (snapshot) => removeDependencyInSnapshot(snapshot, sourceId, dependsOnId, normalizeSnapshot));
    },
    dropTaskStatus(taskId, nextStatus) {
      const task = getTaskById(taskId);
      if (!task || !nextStatus || task.status === nextStatus) {
        return;
      }
      store.selectedTaskId = taskId;
      persist();
      api.patchTask(taskId, { status: nextStatus }, (snapshot) => updateTaskInSnapshot(snapshot, taskId, { status: nextStatus }, normalizeSnapshot));
    },
    handleKeydown(event) {
      const activeElement = document.activeElement;
      const tagName = activeElement?.tagName?.toLowerCase();
      const isTypingTarget = tagName === "input" || tagName === "textarea" || tagName === "select";
      const visibleTasks = getVisibleTasks();
      const currentIndex = visibleTasks.findIndex((task) => task.id === store.selectedTaskId);

      if (searchFocusKeys.has(event.key.toLowerCase()) && activeElement?.id !== "board-search-input" && !isTypingTarget) {
        event.preventDefault();
        document.querySelector("#board-search-input")?.focus({ preventScroll: true });
        return;
      }

      if (event.key === "Escape") {
        if (activeElement?.id === "board-search-input") {
          activeElement.blur();
        } else if (store.selectedSubtaskId) {
          this.closeSubtask();
        } else if (store.selectedTaskId) {
          this.closeTask();
        } else if (store.screen === "tasks") {
          this.showEpics();
        } else if (store.notice) {
          store.notice = null;
          rerender();
        }
        return;
      }

      if (store.screen !== "tasks" || isTypingTarget || visibleTasks.length === 0) {
        return;
      }

      if (event.key.toLowerCase() === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        const nextTask = visibleTasks[Math.min(currentIndex + 1, visibleTasks.length - 1)] ?? visibleTasks[0];
        this.selectTask(nextTask.id);
        return;
      }

      if (event.key.toLowerCase() === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        const previousTask = visibleTasks[Math.max(currentIndex - 1, 0)] ?? visibleTasks[0];
        this.selectTask(previousTask.id);
        return;
      }

      if (event.key === "Enter" && currentIndex >= 0) {
        event.preventDefault();
        document.querySelector(".board-drawer, .board-task-modal")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        return;
      }

      if (event.key === "Enter" && currentIndex === -1 && visibleTasks[0]) {
        event.preventDefault();
        this.selectTask(visibleTasks[0].id);
      }
    },
  };
}
