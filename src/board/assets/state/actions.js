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

export function cascadeEpicStatusInSnapshot(snapshot, epicId, status, normalizeSnapshot) {
  const nextSnapshot = cloneSnapshot(snapshot);
  const epic = nextSnapshot.epics.find((candidate) => candidate.id === epicId);
  if (!epic) {
    return snapshot;
  }

  const updatedAt = Date.now();
  epic.status = status;
  epic.updatedAt = updatedAt;

  const taskIds = new Set();
  for (const task of nextSnapshot.tasks) {
    if (task.epicId !== epicId) {
      continue;
    }

    task.status = status;
    task.updatedAt = updatedAt;
    taskIds.add(task.id);
  }

  for (const subtask of nextSnapshot.subtasks) {
    if (!taskIds.has(subtask.taskId)) {
      continue;
    }

    subtask.status = status;
    subtask.updatedAt = updatedAt;
  }

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
    closeTopmostDisclosure,
    dismissSearch,
    hasOpenOverlay,
    closeActiveOverlay,
    focusSearch,
    focusTaskDetail,
    searchFocusKeys,
  } = options;
  const { store, persist, getBoardState, getTaskById, syncState } = model;

  const transition = (patch = {}, options = {}) => {
    const { persistState = true, rerenderBoard = true } = options;
    const boardState = syncState(patch);
    if (persistState) {
      persist();
    }
    if (rerenderBoard) {
      rerender();
    }
    return boardState;
  };

  let searchTimer = null;
  let pendingSearchValue = null;

  const cancelPendingSearch = () => {
    pendingSearchValue = null;
    if (searchTimer !== null) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  };

  const focusSearchInput = () => {
    const input = document.querySelector("#board-search-input");
    if (input instanceof HTMLInputElement) {
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    }
  };

  const shouldRefocusSearchInput = () => document.activeElement?.id === "board-search-input";

  const commitSearch = (nextSearch, options = {}) => {
    const { focusInput = false } = options;
    cancelPendingSearch();
    syncState({ search: nextSearch });
    persist();
    rerender({ preserveFocus: false });
    if (focusInput) {
      focusSearchInput();
    }
  };

  return {
    toggleTheme() {
      store.theme = store.theme === "dark" ? "light" : "dark";
      applyTheme(store.theme);
      rerender();
    },
    toggleNotesPanel() {
      store.notesPanelOpen = !store.notesPanelOpen;
      persist();
      rerender();
    },
    updateSearch(value) {
      const nextSearch = typeof value === "string" ? value : "";
      cancelPendingSearch();
      pendingSearchValue = nextSearch;
      const shouldRestoreFocus = shouldRefocusSearchInput();
      searchTimer = setTimeout(() => {
        if (pendingSearchValue !== nextSearch) {
          return;
        }
        commitSearch(nextSearch, { focusInput: shouldRestoreFocus });
      }, 180);
    },
    clearSearch() {
      commitSearch("");
    },
    openEpic(epicId) {
      transition({
        screen: "tasks",
        selectedEpicId: epicId || null,
        selectedTaskId: null,
        selectedSubtaskId: null,
      });
    },
    selectEpic(epicId) {
      transition({
        screen: "tasks",
        selectedEpicId: epicId || null,
        selectedTaskId: null,
        selectedSubtaskId: null,
      });
    },
    showEpics() {
      transition({
        screen: "epics",
        selectedTaskId: null,
        selectedSubtaskId: null,
      });
    },
    showBoard() {
      const fallbackEpicId = getBoardState().selectedEpicId || store.snapshot.epics[0]?.id || null;
      if (!fallbackEpicId) {
        return;
      }

      transition({
        screen: "tasks",
        selectedEpicId: fallbackEpicId,
        selectedTaskId: null,
        selectedSubtaskId: null,
      });
    },
    setView(view) {
      transition({ view });
    },
    selectTask(taskId) {
      const task = getTaskById(taskId);
      if (!task) {
        return;
      }
      transition({
        screen: "tasks",
        selectedEpicId: task.epicId,
        selectedTaskId: taskId,
      });
    },
    closeTask() {
      transition({ selectedTaskId: null, selectedSubtaskId: null });
    },
    openSubtask(subtaskId) {
      transition({ selectedSubtaskId: subtaskId || null }, { persistState: false });
    },
    closeSubtask() {
      transition({ selectedSubtaskId: null }, { persistState: false });
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
      syncState({ selectedSubtaskId: subtaskId });
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
      transition({ selectedTaskId: taskId }, { rerenderBoard: false });
      api.patchTask(taskId, { status: nextStatus }, (snapshot) => updateTaskInSnapshot(snapshot, taskId, { status: nextStatus }, normalizeSnapshot));
    },
    changeEpicStatus(epicId, newStatus) {
      const normalizedStatus = normalizeStatus(newStatus);
      api.patchEpic(epicId, { status: normalizedStatus }, (snapshot) => {
        const epic = snapshot.epics.find(e => e.id === epicId);
        if (epic) epic.status = normalizedStatus;
        return snapshot;
      });
    },
    bulkSetStatus(epicId, newStatus) {
      const normalizedStatus = normalizeStatus(newStatus);
      api.cascadeEpicStatus(epicId, normalizedStatus, (snapshot) =>
        cascadeEpicStatusInSnapshot(snapshot, epicId, normalizedStatus, normalizeSnapshot),
      );
    },
    handleKeydown(event) {
      const boardState = getBoardState();
      const activeElement = document.activeElement;
      const tagName = activeElement?.tagName?.toLowerCase();
      const isTypingTarget = tagName === "input" || tagName === "textarea" || tagName === "select";
      const visibleTasks = boardState.visibleTasks;
      const currentIndex = visibleTasks.findIndex((task) => task.id === boardState.selectedTaskId);

      if (hasOpenOverlay?.()) {
        if (event.key === "Escape") {
          event.preventDefault();
          closeActiveOverlay?.();
        }
        return;
      }

      if (searchFocusKeys.has(event.key.toLowerCase()) && activeElement?.id !== "board-search-input" && !isTypingTarget) {
        event.preventDefault();
        focusSearch?.(activeElement);
        return;
      }

      if (event.key === "Escape") {
        if (activeElement?.id === "board-search-input" && pendingSearchValue !== null) {
          event.preventDefault();
          activeElement.value = "";
          this.clearSearch();
          activeElement.blur();
          return;
        }

        if (closeTopmostDisclosure?.(boardState, activeElement)) {
          event.preventDefault();
          return;
        }

        if (dismissSearch?.(boardState, activeElement)) {
          event.preventDefault();
          return;
        }

        if (boardState.selectedSubtaskId) {
          event.preventDefault();
          this.closeSubtask();
        } else if (boardState.selectedTaskId) {
          event.preventDefault();
          this.closeTask();
        } else if (boardState.screen === "tasks") {
          event.preventDefault();
          this.showEpics();
        } else if (store.notice) {
          event.preventDefault();
          store.notice = null;
          rerender();
        }
        return;
      }

      if (boardState.screen !== "tasks" || isTypingTarget || visibleTasks.length === 0) {
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
        focusTaskDetail?.();
        return;
      }

      if (event.key === "Enter" && currentIndex === -1 && visibleTasks[0]) {
        event.preventDefault();
        this.selectTask(visibleTasks[0].id);
      }
    },
  };
}
