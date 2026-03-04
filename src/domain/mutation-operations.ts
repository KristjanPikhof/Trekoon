export const ENTITY_OPERATIONS = {
  epic: {
    created: "epic.created",
    updated: "epic.updated",
    deleted: "epic.deleted",
  },
  task: {
    created: "task.created",
    updated: "task.updated",
    deleted: "task.deleted",
  },
  subtask: {
    created: "subtask.created",
    updated: "subtask.updated",
    deleted: "subtask.deleted",
  },
  dependency: {
    added: "dependency.added",
    removed: "dependency.removed",
  },
} as const;

export type MutationOperation =
  | (typeof ENTITY_OPERATIONS)["epic"][keyof (typeof ENTITY_OPERATIONS)["epic"]]
  | (typeof ENTITY_OPERATIONS)["task"][keyof (typeof ENTITY_OPERATIONS)["task"]]
  | (typeof ENTITY_OPERATIONS)["subtask"][keyof (typeof ENTITY_OPERATIONS)["subtask"]]
  | (typeof ENTITY_OPERATIONS)["dependency"][keyof (typeof ENTITY_OPERATIONS)["dependency"]];
