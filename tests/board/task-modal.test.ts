import { describe, expect, test } from "bun:test";

// @ts-expect-error Untyped browser asset module is exercised directly in tests.
import { createTaskModal } from "../../src/board/assets/components/TaskModal.js";

function createProps(overrides: Partial<{
  task: Record<string, unknown>;
  isMutating: boolean;
}> = {}) {
  return {
    task: {
      id: "task-1",
      epicId: "epic-1",
      title: "Ship board rewrite",
      description: "",
      status: "todo",
      updatedAt: 1710000000000,
      blockedBy: [],
      blocks: [],
      subtasks: [],
      ...overrides.task,
    },
    epics: [{ id: "epic-1", title: "Epic one" }],
    snapshot: {
      epics: [{ id: "epic-1", title: "Epic one" }],
      tasks: [],
      subtasks: [],
      dependencies: [],
    },
    isMutating: false,
    ...overrides,
  };
}

describe("task modal create-form preservation", () => {
  test("preserves add-subtask drafts across same-task rerenders", () => {
    const container = document.createElement("div");
    const taskModal = createTaskModal().mount(container);

    taskModal.update(createProps());

    const titleInput = container.querySelector('[data-create-subtask-form] input[name="title"]');
    const descriptionInput = container.querySelector('[data-create-subtask-form] textarea[name="description"]');
    if (!(titleInput instanceof HTMLInputElement) || !(descriptionInput instanceof HTMLTextAreaElement)) {
      throw new Error("Expected create-subtask form controls");
    }

    titleInput.value = "Write regression tests";
    descriptionInput.value = "Cover stale form state after rerender";

    taskModal.update(createProps({ isMutating: true }));

    expect((container.querySelector('[data-create-subtask-form] input[name="title"]') as HTMLInputElement | null)?.value).toBe("Write regression tests");
    expect((container.querySelector('[data-create-subtask-form] textarea[name="description"]') as HTMLTextAreaElement | null)?.value).toBe("Cover stale form state after rerender");
  });

  test("clears submitted create-subtask and dependency values after success", () => {
    const container = document.createElement("div");
    const taskModal = createTaskModal().mount(container);

    taskModal.update(createProps());

    const subtaskTitle = container.querySelector('[data-create-subtask-form] input[name="title"]');
    const subtaskDescription = container.querySelector('[data-create-subtask-form] textarea[name="description"]');
    const dependencySelect = container.querySelector('[data-dependency-form] select[name="dependsOnId"]');
    if (!(subtaskTitle instanceof HTMLInputElement)
      || !(subtaskDescription instanceof HTMLTextAreaElement)
      || !(dependencySelect instanceof HTMLSelectElement)) {
      throw new Error("Expected task modal create controls");
    }

    subtaskTitle.value = "Write regression tests";
    subtaskDescription.value = "Cover stale form state after rerender";
    dependencySelect.value = "dep-1";

    taskModal.update(createProps({
      task: {
        blockedBy: ["dep-1"],
        subtasks: [{ id: "subtask-1", title: "Write regression tests", description: "", status: "todo" }],
      },
      snapshot: {
        epics: [{ id: "epic-1", title: "Epic one" }],
        tasks: [],
        subtasks: [{ id: "subtask-1", title: "Write regression tests", description: "", status: "todo" }],
        dependencies: [{ sourceId: "task-1", dependsOnId: "dep-1" }],
      },
    }));

    expect((container.querySelector('[data-create-subtask-form] input[name="title"]') as HTMLInputElement | null)?.value).toBe("");
    expect((container.querySelector('[data-create-subtask-form] textarea[name="description"]') as HTMLTextAreaElement | null)?.value).toBe("");
    expect((container.querySelector('[data-dependency-form] select[name="dependsOnId"]') as HTMLSelectElement | null)?.value).toBe("");
  });
});
