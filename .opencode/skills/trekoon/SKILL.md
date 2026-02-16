---
name: trekoon
description: Use Trekoon to create issues/tasks, plan backlog and sprints, create epics, update status, track progress, and manage dependencies/sync across repository workflows.
---

# Trekoon Skill

Trekoon is a local-first issue tracker for epics, tasks, and subtasks.

Use long flags (`--status`, `--description`, etc.) and ALWAYS prefer `--toon` for machine-readable output.

## 1) Load existing work first

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

## 2) Create work (epic/task/subtask)

```bash
trekoon epic create --title "..." --description "..." --status todo --toon
trekoon task create --epic <epic-id> --title "..." --description "..." --status todo --toon
trekoon subtask create --task <task-id> --title "..." --description "..." --status todo --toon
```

Notes:
- `description` is required for epic/task create and it must be well written.
- `status` defaults to `todo` if omitted.

## 3) Update work

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

## 4) Setup/install/init (if `trekoon` is unavailable)

1. Install Trekoon (or make sure it is on `PATH`).
2. In the target repository/worktree, initialize tracker state:

```bash
trekoon init
```
3. You can always run `trekoon quickstart` or `trekoon --help` to get more information.

If `.trekoon/trekoon.db` is missing, initialize before any create/update commands.

## 5) Safety

- Never edit `.trekoon/trekoon.db` directly.
- `trekoon wipe --yes` is prohibited unless the user explicitly confirms they want a destructive wipe.
