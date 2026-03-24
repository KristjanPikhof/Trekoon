# Command reference

Flags, defaults, and behavior for every Trekoon command. If you're looking for
the quickest way to get started, read [Quickstart](quickstart.md) first.

## Command surface

- `trekoon init`
- `trekoon board <open|update>`
- `trekoon help [command]`
- `trekoon quickstart`
- `trekoon epic <create|expand|list|show|search|replace|update|delete|progress>`
- `trekoon session [--epic <epic-id>]`
- `trekoon suggest [--epic <epic-id>]`
- `trekoon task <create|create-many|list|show|ready|next|done|search|replace|update|delete>`
- `trekoon subtask <create|create-many|list|search|replace|update|delete>`
- `trekoon dep <add|add-many|remove|list|reverse>`
- `trekoon events prune [--dry-run] [--archive] [--retention-days <n>]`
- `trekoon migrate <status|rollback> [--to-version <n>]`
- `trekoon sync status [--from <branch>]`
- `trekoon sync pull --from <branch>`
- `trekoon sync resolve <conflict-id> --use ours|theirs [--dry-run]`
- `trekoon sync conflicts <list|show> [--mode pending|all]`
- `trekoon skills install [--link --editor opencode|claude|pi] [--to <path>] [--allow-outside-repo]`
- `trekoon skills install -g|--global [--editor opencode|claude|pi]`
- `trekoon skills update`
- `trekoon wipe --yes`

## Global options

- `--json` — structured JSON output
- `--toon` — TOON-encoded output (preferred for agent loops)
- `--compact` — strips contract metadata from TOON/JSON envelopes
- `--compat <mode>` — explicit machine compatibility behavior
- `--help` — root and command help
- `--version` — CLI version

Global options work before or after the command:

```bash
trekoon --toon quickstart
trekoon quickstart --toon
```

Trekoon uses long-form flags for commands and subcommands. Root help and version
also accept `-h` and `-v`.

## Board commands

`trekoon board open` installs board assets (if needed), starts a loopback-only
server on `127.0.0.1` with a random port, opens the browser, and returns the
board URL plus a manual fallback URL.

`trekoon board update` refreshes board runtime assets without starting the
server or opening a browser. Use this when you need to update copied assets
before the next launch.

Security model:

- Every `board open` session gets a unique token
- Requests must include it as `Authorization: Bearer {token}`,
  `x-trekoon-token` header, or `?token={token}` query parameter
- Invalid tokens return `401`
- Static responses use `cache-control: no-store`

The board is a self-hosted single-page app (vanilla JS, bundled CSS and fonts,
no framework or CDN dependencies) served from `.trekoon/board`. Works fully
offline once initialized.

Board API endpoints (all require token authentication):

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/api/snapshot` | Full board state (epics, tasks, subtasks, deps, counts) |
| `PATCH` | `/api/epics/{id}` | Update epic title, description, or status |
| `PATCH` | `/api/tasks/{id}` | Update task title, description, status, or owner |
| `PATCH` | `/api/subtasks/{id}` | Update subtask title, description, status, or owner |
| `POST` | `/api/subtasks` | Create subtask (requires taskId, title) |
| `DELETE` | `/api/subtasks/{id}` | Delete subtask |
| `POST` | `/api/dependencies` | Add dependency edge (sourceId, dependsOnId) |
| `DELETE` | `/api/dependencies?sourceId=...&dependsOnId=...` | Remove dependency |

Board commands don't accept command-specific options yet. For tests and local
development, `TREKOON_BOARD_ASSET_ROOT` overrides the bundled asset source.

```bash
trekoon init
trekoon board open
trekoon --json board open
trekoon board update
```

## Human views

List and show commands default to table output in human mode. Use
`--view compact` for pipe-friendly output.

- `epic list`, `task list`, `subtask list` support `--view table|compact`
- `epic show`, `task show` support `--view table|compact|tree|detail`

## List defaults and filters

These apply to `epic list`, `task list`, and `subtask list`:

- Default scope: open work only (`in_progress`, `todo`)
- Default limit: `10`
- Status filter: `--status in_progress,todo`
- Custom limit: `--limit <n>`
- Cursor pagination: `--cursor <n>`
- All rows and statuses: `--all`
- `--all` is mutually exclusive with `--status`, `--limit`, and `--cursor`

## Update modes

`epic update`, `task update`, and `subtask update` support two modes depending
on whether you pass a positional ID.

### Bulk mode (no positional ID)

Target multiple rows directly with `--all` or `--ids`:

```bash
trekoon task update --all --status in_progress
trekoon task update --ids <task-1>,<task-2> --append "\nFollow-up note"
trekoon subtask update --all --status done
trekoon epic update --ids <epic-1>,<epic-2> --status done
```

Rules:

- `--all` and `--ids` are mutually exclusive
- Only `--append`, `--status`, or both are supported
- `--append` and `--description` are mutually exclusive
- Not one atomic transaction

### Cascade mode (with positional ID)

Close or reopen a whole tree from one root:

```bash
trekoon epic update <epic-id> --all --status done
trekoon epic update <epic-id> --all --status todo
trekoon task update <task-id> --all --status done
trekoon task update <task-id> --all --status todo
```

Rules:

- Updates the entity and all descendants atomically
- Only `--status done|todo` is supported
- Don't combine with `--ids`, `--append`, `--description`, or `--title`
- Unresolved external dependencies abort the whole update (`dependency_blocked`)
- Subtask cascade is accepted for consistency but just updates one subtask
- Success response includes `data.cascade` with changed/unchanged IDs and counts

## Status machine

Statuses: `todo`, `in_progress`, `done`, `blocked`. The hyphenated `in-progress`
is no longer accepted.

| From | Allowed targets |
| --- | --- |
| `todo` | `in_progress`, `blocked` |
| `in_progress` | `done`, `blocked` |
| `blocked` | `in_progress`, `todo` |
| `done` | `in_progress` |

Invalid transitions return `status_transition_invalid` with the current status,
target status, and allowed transitions.

**Upgrading from 0.3.0:** Entities with legacy statuses like `in-progress` can
transition to any valid status without error.

## Owner field

Tasks and subtasks have an optional `owner` field:

```bash
trekoon task update <task-id> --owner "agent-1"
trekoon subtask update <subtask-id> --owner "agent-2"
```

Also accepted on `PATCH /api/tasks/{id}` and `PATCH /api/subtasks/{id}`.

## Task done

`trekoon task done <task-id>` marks a task complete and returns the next ready
candidate.

- Auto-transitions through `in_progress` when current status is `todo` or
  `blocked`, emitting two sync events for the intermediate step
- Reports newly unblocked downstream tasks (`data.unblocked`)
- Warns about incomplete subtasks (`data.warning`, `data.openSubtaskCount`)

## Epic progress

```bash
trekoon epic progress <epic-id>
```

Returns status counts (`total`, `doneCount`, `inProgressCount`, `blockedCount`,
`todoCount`), `readyCount`, and `nextCandidate`.

## Session scoping

```bash
trekoon session --epic <epic-id>
```

Scopes session readiness to a specific epic instead of the full tracker.

## Suggest

```bash
trekoon suggest [--epic <epic-id>]
```

Returns up to 3 priority-ranked next-action suggestions based on recovery state,
sync status, task readiness, and epic progress. Categories: `recovery`, `sync`,
`execution`, `planning`. Each suggestion includes `action`, `command`, and
`reason`.

## Sync commands

### `sync status`

```bash
trekoon --toon sync status [--from <branch>]
```

Reports ahead/behind counts and pending conflicts against a source branch.
Defaults to `--from main`.

### `sync pull`

```bash
trekoon --toon sync pull --from <branch>
```

Pulls tracker events from the source branch into the current worktree. Creates
conflicts when the same field was modified on both sides. `--from` is required.

### `sync resolve`

```bash
trekoon --toon sync resolve <conflict-id> --use ours|theirs [--dry-run]
```

Resolves a pending conflict. `--use ours` keeps the current DB value.
`--use theirs` overwrites with the source-branch value.

- `--dry-run` previews the resolution without mutating the database
- In human mode, `--use theirs` shows a 30-second confirmation prompt (defaults
  to rejection). Toon mode skips the prompt.

### `sync conflicts`

```bash
trekoon --toon sync conflicts list [--mode pending|all]
trekoon --toon sync conflicts show <conflict-id>
```

`list` defaults to `--mode pending`. Use `--mode all` to include resolved
conflicts.

## Related docs

- [Quickstart](quickstart.md)
- [AI agents and the Trekoon skill](ai-agents.md)
- [Machine contracts](machine-contracts.md)
