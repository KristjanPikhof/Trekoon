---
name: trekoon
description: Use Trekoon to create issues/tasks, plan backlog and sprints, create epics, update status, track progress, and manage dependencies/sync across repository workflows.
---

# Trekoon Skill

Trekoon is a local-first issue tracker for epics, tasks, and subtasks.

Use long flags (`--status`, `--description`, etc.) and ALWAYS prefer `--toon` for machine-readable output.

## 1) Status Management

### Valid Statuses

| Status | Meaning |
|--------|---------|
| `todo` | Work not started (default for new items) |
| `in_progress` | Actively being worked on |
| `done` | Completed successfully |

Note: `in-progress` (hyphenated) is equivalent to `in_progress`.

### When to Change Status

| Transition | When to apply |
|------------|---------------|
| `todo → in_progress` | When you START working on a task/subtask/epic |
| `in_progress → done` | When you COMPLETE the work and it is ready |

### Status Change Commands

```bash
trekoon task update <task-id> --status in_progress --toon
trekoon task update <task-id> --status done --toon
trekoon subtask update <subtask-id> --status done --toon
trekoon epic update <epic-id> --status done --toon
```

## 2) Dependency Management

Dependencies define what must be completed before a task can start. A task/subtask can depend on other tasks/subtasks.

### Commands

```bash
trekoon dep add <source-id> <depends-on-id> --toon
trekoon dep list <source-id> --toon
trekoon dep remove <source-id> <depends-on-id> --toon
```

- `<source-id>`: The task/subtask that has the dependency
- `<depends-on-id>`: The task/subtask that must be completed first

### Checking Dependencies

Before starting any task, always check its dependencies:

```bash
trekoon dep list <task-id> --toon
```

The response includes `dependencies` array. Each entry shows:
- `sourceId`: the task you're checking
- `dependsOnId`: what must be done first
- `dependsOnKind`: "task" or "subtask"

### Dependency Rules

1. A task with dependencies should only be marked `in_progress` when ALL dependencies have status `done`
2. Dependencies can only exist between tasks and subtasks (not epics)
3. Cycles are automatically detected and rejected

## 3) Task Completion Flow

### Before Starting a Task

1. Check if task has unmet dependencies:
   ```bash
   trekoon dep list <task-id> --toon
   ```

2. If dependencies exist and are not `done`, complete those first

3. Only mark `in_progress` when all dependencies are `done`

### When Completing a Task

1. Mark the task as done:
   ```bash
   trekoon task update <task-id> --status done --toon
   ```

2. To find the next task that was blocked by this one:
   - List all tasks: `trekoon task list --all --toon`
   - Check which tasks have dependencies on the completed task
   - The task(s) with all dependencies now satisfied are ready to start

### Finding Next Work

```bash
trekoon task list --status todo --limit 20 --toon
```

Tasks are sorted with `in_progress` first, then `todo`. Look for tasks with no dependencies or all dependencies satisfied.

## 4) Load existing work first

Before creating or changing anything, inspect current context:

```bash
trekoon epic list --toon
trekoon task list --toon
trekoon epic show <id> --all --toon
trekoon task show <id> --all --toon
```

- `epic list` / `task list` defaults:
  - open work only (`in_progress`, `in-progress`, `todo`)
  - prioritized as `in_progress`/`in-progress` first, then `todo`
  - default limit `10`
- Filter list explicitly when needed:

```bash
trekoon task list --status in_progress,todo --limit 20 --toon
trekoon epic list --status done --toon
trekoon task list --all --toon
```

- `--all` cannot be combined with `--status` or `--limit`.
- `epic show <id> --all --toon`: full epic tree (tasks + subtasks)
- `task show <id> --all --toon`: task plus its subtasks

### View Options

| Command | `--view` options |
|---------|------------------|
| `list` | `table` (default), `compact` |
| `show` | `table` (default), `compact`, `tree`, `detail` |

## 5) Create work (epic/task/subtask)

```bash
trekoon epic create --title "..." --description "..." --status todo --toon
trekoon task create --epic <epic-id> --title "..." --description "..." --status todo --toon
trekoon subtask create --task <task-id> --title "..." --description "..." --status todo --toon
```

Notes:
- `description` is required for epic/task create and it must be well written.
- `status` defaults to `todo` if omitted.
- `description` is optional for subtask create.

## 6) Update work

### Single-item update

```bash
trekoon epic update <epic-id> --title "..." --description "..." --status in_progress --toon
trekoon task update <task-id> --title "..." --description "..." --status in_progress --toon
trekoon subtask update <subtask-id> --title "..." --description "..." --status in_progress --toon
```

### Bulk update (task/epic)

```bash
trekoon task update --all --append "..." --status in_progress --toon
trekoon task update --ids id1,id2 --append "..." --status in_progress --toon

trekoon epic update --all --append "..." --status in_progress --toon
trekoon epic update --ids id1,id2 --append "..." --status in_progress --toon
```

Rules:
- `--all` and `--ids` are mutually exclusive.
- In bulk mode, do not pass a positional ID.
- Bulk update supports `--append` and/or `--status`.

## 7) Setup/install/init (if `trekoon` is unavailable)

1. Install Trekoon (or make sure it is on `PATH`).
2. In the target repository/worktree, initialize tracker state:

```bash
trekoon init
```

3. You can always run `trekoon quickstart` or `trekoon --help` to get more information.

If `.trekoon/trekoon.db` is missing, initialize before any create/update commands.

## 8) Safety

- Never edit `.trekoon/trekoon.db` directly.
- `trekoon wipe --yes` is prohibited unless the user explicitly confirms they want a destructive wipe.
