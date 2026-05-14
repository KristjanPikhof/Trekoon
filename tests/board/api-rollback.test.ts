import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { computeInverseDelta, createMutationQueue } from "../../src/board/assets/state/api.js";
// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { applySnapshotDelta } from "../../src/board/assets/state/utils.js";

interface TestSnapshot {
  generatedAt: number | null;
  epics: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  subtasks: Array<Record<string, unknown>>;
  dependencies: Array<Record<string, unknown>>;
}

function emptySnapshot(): TestSnapshot {
  return { generatedAt: null, epics: [], tasks: [], subtasks: [], dependencies: [] };
}

function makeTask(id: string, title: string): Record<string, unknown> {
  return { id, title, epicId: "epic-1", status: "todo", description: "" };
}

function makeSubtask(id: string, title: string, taskId = "task-1"): Record<string, unknown> {
  return { id, title, taskId, status: "todo", description: "" };
}

interface TestModel {
  store: { snapshot: TestSnapshot; notice: unknown; isMutating: boolean };
  replaceSnapshot(snapshot: TestSnapshot): void;
  applySnapshotDelta(delta: Record<string, unknown>): void;
}

function createTestModel(initial: TestSnapshot): TestModel {
  return {
    store: { snapshot: initial, notice: null, isMutating: false },
    replaceSnapshot(snapshot: TestSnapshot) {
      this.store.snapshot = snapshot;
    },
    applySnapshotDelta(delta: Record<string, unknown>) {
      this.store.snapshot = applySnapshotDelta(this.store.snapshot, delta);
    },
  };
}

describe("computeInverseDelta", () => {
  test("captures restored entities for in-place mutations", () => {
    const previous: TestSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-1", "Original")],
    };
    const optimistic: TestSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-1", "Optimistic")],
    };

    const inverse = computeInverseDelta(previous, optimistic);

    expect(inverse.tasks).toBeDefined();
    expect(inverse.tasks).toHaveLength(1);
    expect(inverse.tasks[0]).toMatchObject({ id: "task-1", title: "Original" });
  });

  test("emits deletedIds for entities that the optimistic patch added", () => {
    const previous: TestSnapshot = emptySnapshot();
    const optimistic: TestSnapshot = {
      ...emptySnapshot(),
      subtasks: [makeSubtask("optimistic:subtask:abc", "Pending")],
    };

    const inverse = computeInverseDelta(previous, optimistic);

    expect(inverse.deletedSubtaskIds).toEqual(["optimistic:subtask:abc"]);
    expect(inverse.subtasks).toBeUndefined();
  });

  test("restores entities that the optimistic patch deleted", () => {
    const previous: TestSnapshot = {
      ...emptySnapshot(),
      subtasks: [makeSubtask("subtask-1", "Existing")],
    };
    const optimistic: TestSnapshot = emptySnapshot();

    const inverse = computeInverseDelta(previous, optimistic);

    expect(inverse.subtasks).toHaveLength(1);
    expect(inverse.subtasks[0]).toMatchObject({ id: "subtask-1", title: "Existing" });
    expect(inverse.deletedSubtaskIds).toBeUndefined();
  });

  test("returns an empty inverse when nothing was touched", () => {
    const snapshot: TestSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-1", "Same")],
    };

    const inverse = computeInverseDelta(snapshot, snapshot);

    expect(inverse).toEqual({});
  });
});

describe("mutation queue rollback", () => {
  test("rollback preserves a concurrent server delta on an unrelated entity", async () => {
    const initial: TestSnapshot = {
      ...emptySnapshot(),
      tasks: [makeTask("task-1", "Original Task"), makeTask("task-2", "Other Task")],
    };
    const model = createTestModel(initial);

    let triggerError: () => void = () => {};
    const requestPromise = new Promise<never>((_, reject) => {
      triggerError = () => reject(new Error("Request failed"));
    });

    const queue = createMutationQueue(model, () => {});

    queue.enqueue({
      mutationId: "test-rollback-1",
      optimistic(snapshot: TestSnapshot) {
        const updatedTasks = snapshot.tasks.map((task) =>
          task.id === "task-1" ? { ...task, title: "Optimistic Title" } : task,
        );
        return { ...snapshot, tasks: updatedTasks };
      },
      request: () => requestPromise,
    });

    // Wait one microtask tick so the optimistic patch is applied.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(model.store.snapshot.tasks.find((task) => task.id === "task-1")).toMatchObject({
      title: "Optimistic Title",
    });

    // Simulate a concurrent server-pushed SSE delta for an unrelated entity.
    model.applySnapshotDelta({
      tasks: [{ ...makeTask("task-2", "Server Updated"), status: "in_progress" }],
    });

    expect(model.store.snapshot.tasks.find((task) => task.id === "task-2")).toMatchObject({
      title: "Server Updated",
      status: "in_progress",
    });

    // Trigger the failure.
    triggerError();
    await queue.flush();

    // Optimistic change is rolled back.
    expect(model.store.snapshot.tasks.find((task) => task.id === "task-1")).toMatchObject({
      title: "Original Task",
    });
    // Concurrent unrelated server delta is preserved.
    expect(model.store.snapshot.tasks.find((task) => task.id === "task-2")).toMatchObject({
      title: "Server Updated",
      status: "in_progress",
    });
  });

  test("rollback for an optimistic create removes only the optimistic record while preserving server-pushed records", async () => {
    const initial: TestSnapshot = {
      ...emptySnapshot(),
      subtasks: [makeSubtask("subtask-existing", "Existing Subtask")],
    };
    const model = createTestModel(initial);

    let triggerError: () => void = () => {};
    const requestPromise = new Promise<never>((_, reject) => {
      triggerError = () => reject(new Error("Request failed"));
    });

    const queue = createMutationQueue(model, () => {});

    queue.enqueue({
      mutationId: "test-rollback-create",
      optimistic(snapshot: TestSnapshot) {
        return {
          ...snapshot,
          subtasks: [...snapshot.subtasks, makeSubtask("optimistic:subtask:xyz", "Pending Subtask")],
        };
      },
      request: () => requestPromise,
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(model.store.snapshot.subtasks).toHaveLength(2);

    // Concurrent server-pushed delta adds an unrelated subtask.
    model.applySnapshotDelta({
      subtasks: [makeSubtask("subtask-server-new", "Server-pushed Subtask")],
    });
    expect(model.store.snapshot.subtasks).toHaveLength(3);

    triggerError();
    await queue.flush();

    const ids = model.store.snapshot.subtasks.map((subtask) => subtask.id).sort();
    expect(ids).toEqual(["subtask-existing", "subtask-server-new"]);
  });
});
