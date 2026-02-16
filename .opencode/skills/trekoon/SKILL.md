---
name: trekoon
description: Use Trekoon as a local-first issue tracker CLI for planning and execution in any repository/worktree. This skill defines exact agent workflows, command usage, and decision rules.
---

# Trekoon Skill

Trekoon is a local-first issue tracker for epics, tasks, and subtasks.

Use long flags (`--status`, `--description`, etc.) and ALWAYS prefer `--toon` for machine-readable output.

## 1) Load existing work first

Before creating or changing anything, inspect current context:

```bash
trekoon epic show <id> --all --toon
trekoon task show <id> --all --toon
```

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
