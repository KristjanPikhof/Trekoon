# Trekoon

AI-first issue tracking for humans and agents.

Trekoon is a Bun-powered CLI focused on execution workflows where AI agents and humans share the same task graph.

## What Trekoon is

- Local-first CLI issue tracker
- Structured hierarchy: **epic → task → subtask**
- UUID-based references for durable linking across branches/worktrees
- Dependency-aware planning and execution
- Dual output modes:
  - **Human mode** for terminal users
  - **TOON mode** for low-context agent parsing

## What Trekoon aims to accomplish

1. Make issue tracking fast enough for daily terminal use.
2. Make issue data deterministic and machine-readable for AI automation.
3. Keep branch/worktree-aware state so parallel execution can be coordinated safely.
4. Stay minimal in code size while preserving robustness and clear boundaries.

## Command surface

- `trekoon init`
- `trekoon quickstart`
- `trekoon help [command]`
- `trekoon epic <create|list|show|update|delete|complete>`
- `trekoon task <create|list|show|update|delete>`
- `trekoon subtask <create|list|update|delete>`
- `trekoon dep <add|remove|list>`
- `trekoon sync <status|pull|resolve>`
- `trekoon wipe --yes`

Global output mode:

- `--toon` for structured AI output
- `--help` for root and command help
- `--version` for CLI version

Global options can be used before or after the command:

```bash
trekoon --toon quickstart
trekoon quickstart --toon
```

## Quickstart

Trekoon is local-first: each worktree uses its own `.trekoon/trekoon.db`.
Git does not merge this DB file; Trekoon sync commands merge tracker state.

### 1) Initialize

```bash
trekoon init
trekoon --version
```

### 2) Create epic → task → subtask

```bash
trekoon epic create -t "Agent backlog stabilization"
trekoon task create -t "Implement sync status" -e <epic-id>
trekoon subtask create <task-id> -t "Add cursor model"
```

### 3) Add dependencies

```bash
trekoon dep add <task-id> <depends-on-id>
trekoon dep list <task-id>
```

### 4) Use TOON output for AI agents

```bash
trekoon --toon epic show <epic-id>
trekoon --toon task show <task-id>
```

### 5) Sync workflow for worktrees

- Run `trekoon sync status` at session start and before PR/merge.
- Run `trekoon sync pull --from main` before merge to align tracker state.
- If conflicts exist, resolve explicitly:

```bash
trekoon sync status
trekoon sync pull --from main
trekoon sync resolve <conflict-id> --use ours
```

### 6) Pre-merge checklist

- [ ] `trekoon sync status` shows no unresolved conflicts
- [ ] done tasks/subtasks are marked completed
- [ ] dependency graph has no stale blockers
- [ ] final AI check: `trekoon --toon epic show <epic-id>`

## Implementation principles

- Minimal, composable modules
- Strict validation at command boundaries
- Stable TOON envelope for automation
- No unnecessary feature sprawl
