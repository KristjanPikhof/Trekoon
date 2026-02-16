---
name: trekoon
description: Use Trekoon as a local-first issue tracker CLI for planning and execution in any repository/worktree. This skill defines exact agent workflows, command usage, and decision rules.
---

# Trekoon Skill

Use Trekoon to plan and execute work as a hierarchy:

- **Epic** = feature/initiative goal
- **Task** = deliverable units under epic
- **Subtask** = concrete implementation steps under task

Example decomposition:

- Epic: `Implement login flow`
- Tasks: `Implement login form`, `Add auth checks`, `Create register page`
- Subtasks (under login form): `Create username field`, `Create email field`, `Create password field`

## When to Use This Skill

Activate when user needs to:

- create or restructure project plans
- inspect epic/task/subtask trees
- set or inspect execution dependencies
- sync Trekoon state across branch/worktree flows
- initialize/reset local tracker state

## Agent Rules (Must Follow)

1. Always run in the user’s target repo/worktree directory.
2. Initialize first if `.trekoon/trekoon.db` is missing.
3. Use `--toon` whenever parsing IDs/fields programmatically.
4. Never edit `.trekoon/trekoon.db` directly.
5. Never run `trekoon wipe --yes` unless user explicitly asks.
6. Prefer explicit fields (`--title`, `--description`, etc.).
7. Use long flags with `--` (short `-t` style is not reliably parsed).

## Fast Decision Guide (What to Create)

- If it takes multiple sessions / multiple deliverables → **Epic**
- If it is a shippable unit inside epic → **Task**
- If it is an implementation step for one task → **Subtask**
- If one task/subtask must happen first → **Dependency**

## Output Contract (`--toon`)

Trekoon outputs machine-readable JSON envelope:

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

## Command Reference (Current Behavior)

### Global

- `trekoon --help`
- `trekoon --version`
- `trekoon <command> ... --toon`

### Lifecycle

- `trekoon init`
- `trekoon quickstart`
- `trekoon wipe --yes`

### Epic

- `trekoon epic create --title <title> --description <description> [--status <status>]`
- `trekoon epic list`
- `trekoon epic show <epic-id> [--all]`
- `trekoon epic update <epic-id> [--title <title>] [--description <description>] [--status <status>]`
- `trekoon epic delete <epic-id>`

Notes:

- IDs are UUIDs.
- `description` required on create.
- `status` defaults to `todo`.
- `epic show --all --toon` returns full tree with descriptions.

### Task

- `trekoon task create --epic <epic-id> --title <title> --description <description> [--status <status>]`
- `trekoon task list [--epic <epic-id>]`
- `trekoon task show <task-id> [--all]`
- `trekoon task update <task-id> [--title <title>] [--description <description>] [--status <status>]`
- `trekoon task delete <task-id>`

Notes:

- `task show --all --toon` returns task + subtasks with descriptions.
- Human `task show` is intentionally compact.

### Subtask

- `trekoon subtask create --task <task-id> --title <title> [--description <description>] [--status <status>]`
- `trekoon subtask list [--task <task-id>]`
- `trekoon subtask update <subtask-id> [--title <title>] [--description <description>] [--status <status>]`
- `trekoon subtask delete <subtask-id>`

### Dependency

- `trekoon dep add <source-id> <depends-on-id>`
- `trekoon dep remove <source-id> <depends-on-id>`
- `trekoon dep list <source-id>`

Notes:

- Positional IDs only.
- Referential checks and cycle detection enforced.

### Sync

- `trekoon sync status [--from <branch>]`
- `trekoon sync pull --from <branch>`
- `trekoon sync resolve <conflict-id> --use ours|theirs`

Notes:

- `status` defaults to `main` when `--from` omitted.
- `pull` requires `--from`.
- `resolve` requires conflict id and `--use` value.

## Agent Playbook

### A) New complex feature planning

1. Ensure tracker exists:
   - `trekoon init`
2. Create epic.
3. Create tasks under epic.
4. Create subtasks under each task for concrete implementation.
5. Add dependencies for execution order.
6. Validate full plan tree with `--all --toon`.

Template:

```bash
trekoon epic create --title "Implement login flow" --description "End-to-end auth UX + checks" --toon
trekoon task create --epic <epic-id> --title "Implement login form" --description "UI + client validation" --toon
trekoon task create --epic <epic-id> --title "Add auth checks" --description "Route/session guards" --toon
trekoon task create --epic <epic-id> --title "Create register page" --description "Registration UX" --toon
trekoon subtask create --task <task-id-login-form> --title "Create username field" --description "Input + validation" --toon
trekoon subtask create --task <task-id-login-form> --title "Create email field" --description "Input + validation" --toon
trekoon subtask create --task <task-id-login-form> --title "Create password field" --description "Input + constraints" --toon
trekoon dep add <task-id-auth-checks> <task-id-login-form> --toon
trekoon epic show <epic-id> --all --toon
```

### B) Daily execution loop

1. `trekoon sync status --from main --toon`
2. `trekoon sync pull --from main --toon`
3. Do planning/status updates.
4. `trekoon sync status --from main --toon`
5. Resolve conflicts if present.

## Recommended Inspection Commands for AI

- Full epic context in one call:
  - `trekoon epic show <epic-id> --all --toon`
- Full task context with subtasks:
  - `trekoon task show <task-id> --all --toon`
- Dependency inspection:
  - `trekoon dep list <task-or-subtask-id> --toon`

## Safety / Anti-Patterns

- Do not assume branch switch auto-merges tracker state.
- Do not perform destructive wipe without explicit approval.
- Do not parse human output when `--toon` is available.
- Do not rely on undocumented subcommands.
