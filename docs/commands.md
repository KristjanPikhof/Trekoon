# Command reference

Use this page when you already know what Trekoon does and just need the command
surface, defaults, and flag rules.

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
- `trekoon sync <status|pull|resolve|conflicts>`
- `trekoon skills install [--link --editor opencode|claude|pi] [--to <path>] [--allow-outside-repo]`
- `trekoon skills update`
- `trekoon wipe --yes`

## Global output modes

- `--json` for structured JSON output
- `--toon` for true TOON-encoded output
- `--compact` strips contract metadata from TOON/JSON envelopes
- `--compat <mode>` for explicit machine compatibility behavior
- `--help` for root and command help
- `--version` for CLI version

Global options can be used before or after the command:

```bash
trekoon --toon quickstart
trekoon quickstart --toon
trekoon --json quickstart
trekoon quickstart --json
```

Trekoon uses long-form options for command and subcommand flags. Root help and
version aliases `-h` and `-v` are also supported.

## Board lifecycle commands

Board terminology in docs matches `trekoon help board`:

- `trekoon board open`
  - ensures board assets are installed in the repo-shared runtime directory
  - starts a local board server on `127.0.0.1`
  - launches the browser and returns the board URL, fallback URL, and launch
    metadata in machine output
- `trekoon board update`
  - refreshes board runtime assets only
  - does not start the server or open a browser

Operator guidance:

- use `trekoon board open` as the normal one-command startup path
- use `trekoon board update` when you specifically need to refresh copied assets
  before the next launch

Board commands do not accept command-specific options yet. For tests and local
development only, `TREKOON_BOARD_ASSET_ROOT` can override the bundled asset
source used by `init`, `board open`, and `board update`.

Runtime layout and security model:

- `trekoon init` installs or refreshes the board runtime under `.trekoon/board`
- `board open` serves those bundled files over a loopback-only server instead of
  opening a raw file directly
- the server binds to `127.0.0.1` on a random port
- every session gets a per-session token; browser/API requests must present that
  token
- static responses use `cache-control: no-store`, and CLI output always includes
  a manual fallback URL

Current shell/runtime notes:

- the runtime copied into `.trekoon/board` includes the HTML shell, local app
  modules, and shared styles
- all assets are self-hosted: the board ships its own CSS, fonts (Inter,
  Material Symbols), and vanilla JS with no framework or CDN dependencies
- the board works fully offline once the runtime assets are copied into
  `.trekoon/board`

Board UI architecture:

- the board is a single-page application served from `.trekoon/board` using a
  zero-dependency vanilla JS component runtime with locally bundled CSS and fonts
- the backend is a Bun HTTP server exposing a REST API at `/api/*` with
  token-based authentication; every mutation response includes an updated
  snapshot so the client always has fresh state
- the frontend uses optimistic updates: the UI changes immediately on user
  action, then rolls back if the server rejects the mutation

Board layout behavior:

- the topbar is a compact flex-row navbar with workspace identity, Epics and
  Board navigation pills, a debounced search input, theme toggle, and a
  workspace info popover
- the board toggles between an epics overview and a task workspace view; task
  detail opens as a modal overlay
- responsive breakpoints adjust kanban column counts and component spacing
- task cards show truncated descriptions; clicking anywhere on a card opens the
  task detail modal

Scroll and overlay behavior:

- the page scrolls naturally as a single document; there are no internal scroll
  containers trapping wheel events in the main content area
- when a modal overlay opens (task detail, subtask editor), body scroll is
  locked and the modal surface becomes the scroll container
- close overlays from the top down: subtask modal → task detail → broader board
  context; each close unlocks body scroll and returns to the previous context

Board API endpoints (all require token authentication):

- `GET /api/snapshot` — full board state (epics, tasks, subtasks, dependencies,
  counts)
- `PATCH /api/epics/{id}` — update epic title, description, or status
- `PATCH /api/tasks/{id}` — update task title, description, status, or owner
- `PATCH /api/subtasks/{id}` — update subtask title, description, status, or owner
- `POST /api/subtasks` — create subtask (requires taskId, title)
- `DELETE /api/subtasks/{id}` — delete subtask
- `POST /api/dependencies` — add dependency edge (sourceId, dependsOnId)
- `DELETE /api/dependencies?sourceId=...&dependsOnId=...` — remove dependency

Token is sent as `Authorization: Bearer {token}` header or `x-trekoon-token`
header or `?token={token}` query parameter. Invalid tokens return `401`.

Examples:

```bash
trekoon init
trekoon board open
trekoon --json board open
trekoon board update
```

## Human views

- List and show commands default to table output in human mode.
- Use `--view compact` to restore compact pipe output.
- `epic list`, `task list`, and `subtask list` support `--view table|compact`.
- `epic show` and `task show` support `--view table|compact|tree|detail`.

## List defaults and filters

These defaults apply to `epic list`, `task list`, and `subtask list`:

- Default scope: open work only (`in_progress`, `todo`)
- Default limit: `10`
- Status filter: `--status in_progress,todo`
- Custom limit: `--limit <n>`
- Cursor pagination: `--cursor <n>`
- All rows and statuses: `--all`
- `--all` is mutually exclusive with `--status`, `--limit`, and `--cursor`

## Update modes

`epic update`, `task update`, and `subtask update` now have two meanings for
`--all`, depending on whether you also pass a positional ID.

### Repo-wide bulk mode

Use `update --all` or `update --ids <csv>` when you want to target multiple
top-level rows directly.

This mode preserves the existing per-row update behavior. It is **not** the same
as descendant cascade mode and is not one atomic multi-row transaction.

- Target all rows: `--all`
- Target specific rows: `--ids <id1,id2,...>`
- Bulk mode supports only `--append <text>`, `--status <status>`, or both
- In bulk mode, do not pass a positional ID
- `--all` and `--ids` are mutually exclusive
- `--append` and `--description` are mutually exclusive

Examples:

```bash
trekoon task update --all --status in_progress
trekoon task update --ids <task-1>,<task-2> --append "\nFollow-up note"
trekoon subtask update --all --status done
trekoon subtask update --ids <subtask-1>,<subtask-2> --append "\nFollow-up note"
trekoon epic update --ids <epic-1>,<epic-2> --status done
```

### Descendant cascade mode

Use positional-ID `update <id> --all --status done|todo` when you want to close
or reopen a whole tree from one root.

- `trekoon epic update <epic-id> --all --status done|todo`
  - updates the epic and all descendant tasks/subtasks in one atomic operation
- `trekoon task update <task-id> --all --status done|todo`
  - updates the task and all descendant subtasks in one atomic operation
- `trekoon subtask update <subtask-id> --all --status done|todo`
  - accepts the same syntax for consistency, but behaves like a normal
    single-subtask status update because there are no descendants
- Positional-ID cascade mode supports only `--status done|todo`
- Do not combine positional ID + `--all` with `--ids`, `--append`,
  `--description`, or `--title`
- For epic/task cascades, unresolved external dependencies abort the whole
  update with `dependency_blocked`; no partial writes are committed
- Successful machine output includes `data.cascade` with the root, target
  status, atomic flag, changed IDs, unchanged IDs, and per-kind counts

Examples:

```bash
trekoon epic update <epic-id> --all --status done
trekoon epic update <epic-id> --all --status todo
trekoon task update <task-id> --all --status done
trekoon task update <task-id> --all --status todo
trekoon subtask update <subtask-id> --all --status done
```

## Status machine

Trekoon enforces a status machine for all entities. The canonical statuses are
`todo`, `in_progress`, `done`, and `blocked`. The hyphenated `in-progress`
variant is no longer accepted.

**Upgrading from 0.3.0:** Existing entities with `in-progress` or other custom
statuses are handled gracefully — transitions from non-canonical statuses to any
valid status are allowed, so you can update them to `in_progress` without error.

Valid transitions:

| From | Allowed targets |
| --- | --- |
| `todo` | `in_progress`, `blocked` |
| `in_progress` | `done`, `blocked` |
| `blocked` | `in_progress`, `todo` |
| `done` | `in_progress` |

Invalid transitions return a `status_transition_invalid` error with the current
status, target status, and allowed transitions.

## Owner field

Tasks and subtasks have an optional `owner` field. Set or clear it with the
`--owner` flag on update commands:

```bash
trekoon task update <task-id> --owner "agent-1"
trekoon subtask update <subtask-id> --owner "agent-2"
```

The board API also accepts `owner` on `PATCH /api/tasks/{id}` and
`PATCH /api/subtasks/{id}`.

## Task done behavior

`trekoon task done <task-id>` marks a task complete and returns the next ready
candidate. Additional behavior:

- Auto-transitions through `in_progress` when the current status is `todo` or
  `blocked`, emitting two sync events for the intermediate step.
- Reports newly unblocked downstream tasks in the response (`data.unblocked`).
- Warns when subtasks remain incomplete (`data.warning`,
  `data.openSubtaskCount`, `data.openSubtaskIds`).

## Epic progress

```bash
trekoon epic progress <epic-id>
```

Returns status counts (`total`, `doneCount`, `inProgressCount`, `blockedCount`,
`todoCount`), `readyCount`, and `nextCandidate` for the given epic.

## Session scoping

```bash
trekoon session --epic <epic-id>
```

Scopes session readiness to a specific epic instead of the full tracker.

## Suggest command

```bash
trekoon suggest [--epic <epic-id>]
```

Returns up to 3 priority-ranked next-action suggestions based on recovery state,
sync status, task readiness, and epic progress. Categories: `recovery`, `sync`,
`execution`, `planning`. Each suggestion includes an `action`, `command`, and
`reason`.

## Related docs

- [Quickstart](quickstart.md)
- [AI agents and the Trekoon skill](ai-agents.md)
- [Machine contracts](machine-contracts.md)
