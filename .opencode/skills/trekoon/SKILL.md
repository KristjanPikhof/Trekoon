---
name: trekoon
description: Use Trekoon as a local-first issue tracker CLI for planning and execution in any repository/worktree. This skill defines the exact command behavior agents should use in the current implementation.
---

# When to Use Trekoon

Trigger this skill when the user asks to:

- create/manage epics, tasks, subtasks, dependencies
- inspect issue tree state
- run local sync status/pull/resolve flows
- initialize or wipe Trekoon state in a project

## Ground Rules for Agents

1. Always run commands in the user's target project directory.
2. Initialize first if `.trekoon/trekoon.db` does not exist.
3. Prefer `--toon` for agent-to-agent/data parsing workflows.
4. Never edit `.trekoon/trekoon.db` directly; use CLI commands only.
5. Never run `wipe --yes` unless explicitly asked.
6. If sync against a branch fails with missing DB, explain that the branch must
   contain `.trekoon/trekoon.db`.

## Output Contract

With `--toon`, all commands return a stable envelope:

```json
{
  "ok": true,
  "command": "<command>",
  "data": {},
  "error": { "code": "...", "message": "..." },
  "meta": {}
}
```

`error` and `meta` are optional.

## Core Command Set (Exact Current Behavior)

### Global

- `trekoon --help`
- `trekoon --version`
- `trekoon <command> --toon`

### Init / Quickstart / Wipe

- `trekoon init`
  - Creates/bootstraps `.trekoon/trekoon.db` in current working directory.
- `trekoon quickstart`
  - Prints local DB/worktree model + pre-merge sync flow + TOON examples.
- `trekoon wipe --yes`
  - Removes `.trekoon/` local state. Without `--yes`, command fails.

### Epic

- `trekoon epic create --title <title> --description <description> [--status <status>]`
- `trekoon epic list`
- `trekoon epic show <epic-id>`
- `trekoon epic update <epic-id> [--title <title>] [--description <description>] [--status <status>]`
- `trekoon epic delete <epic-id>`

Notes:
- Epic IDs are UUIDs.
- `description` is required on create.
- `status` defaults to `todo` if omitted.
- `epic show` returns epic + nested tasks + nested subtasks.

### Task

- `trekoon task create --epic <epic-id> --title <title> --description <description> [--status <status>]`
- `trekoon task list [--epic <epic-id>]`
- `trekoon task show <task-id>`
- `trekoon task update <task-id> [--title <title>] [--description <description>] [--status <status>]`
- `trekoon task delete <task-id>`

Notes:
- Task IDs are UUIDs.
- `description` is required on create.
- `status` defaults to `todo` if omitted.

### Subtask

- `trekoon subtask create --task <task-id> --title <title> [--description <description>] [--status <status>]`
- `trekoon subtask list [--task <task-id>]`
- `trekoon subtask update <subtask-id> [--title <title>] [--description <description>] [--status <status>]`
- `trekoon subtask delete <subtask-id>`

Notes:
- Subtask IDs are UUIDs.
- `description` is optional on create.
- `status` defaults to `todo` if omitted.

### Dependencies

- `trekoon dep add <source-id> <depends-on-id>`
- `trekoon dep remove <source-id> <depends-on-id>`
- `trekoon dep list <source-id>`

Notes:
- Dependency command currently uses positional IDs (not `--source` flags).
- Referential validation is enforced.
- Cycle detection is enforced.

### Sync

- `trekoon sync status [--from <branch>]`
- `trekoon sync pull --from <branch>`
- `trekoon sync resolve <conflict-id> --use ours|theirs`

Notes:
- `status` defaults to `main` when `--from` is omitted.
- `pull` requires `--from <branch>`.
- `pull` reads `.trekoon/trekoon.db` from the target branch via git.

## Agent Playbook

1. Ensure Trekoon is initialized:
   - `trekoon init`
2. Create or update entities.
3. Use `--toon` when parsing IDs programmatically.
4. Before branch merge flows, run:
   - `trekoon sync status --from main`
   - `trekoon sync pull --from main`
   - `trekoon sync resolve <id> --use ours|theirs` (if needed)
   - `trekoon sync status --from main`

## Example Agent-Safe Sequence

```bash
trekoon init
trekoon epic create --title "Epic" --description "Scope" --status open --toon
trekoon task create --epic <epic-id> --title "Task" --description "Work" --status todo --toon
trekoon subtask create --task <task-id> --title "Subtask" --toon
trekoon dep add <task-id> <other-task-id> --toon
trekoon epic show <epic-id> --toon
trekoon sync status --from main --toon
```
