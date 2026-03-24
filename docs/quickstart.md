# Quickstart

Use this guide for the shortest path from an empty repo to an active Trekoon
workflow.

## Understand the storage model first

Trekoon is local-first, but inside git repos and worktrees it is **repo-shared**.
Every worktree for the same repository resolves to one shared `.trekoon`
directory and one shared `.trekoon/trekoon.db` database.

- `worktreeRoot` identifies the current checkout.
- `sharedStorageRoot` identifies the repository root that owns `.trekoon`.
- `databaseFile` points at the shared SQLite database.
- `.trekoon` stays gitignored because the DB is operational state, not source
  code.

Outside git repos, Trekoon falls back to the current working directory.

## Initialize

```bash
trekoon init
trekoon --version
```

If an agent is driving the workflow, use the machine-readable form:

```bash
trekoon --toon init
trekoon --toon sync status
```

Bootstrap rules:

- Run `trekoon --toon init` once per repository to create or re-bootstrap the
  shared storage root and install the bundled board runtime under
  `.trekoon/board`.
- Run `trekoon --toon sync status` before agent work to inspect diagnostics.
- If diagnostics report `recoveryRequired`, a tracked or ignored mismatch, or an
  ambiguous recovery path, stop and repair setup before continuing.

## Open the local board

After `trekoon init`, you can browse and update the same repo-shared Trekoon
state in the browser:

```bash
trekoon board open
trekoon board update
```

For day-to-day use, treat `trekoon board open` as the one-command entry point.
It both verifies the runtime files and launches the board. Reach for
`trekoon board update` only when you need to refresh the copied runtime without
opening the browser.

What these commands do:

- `trekoon board open` ensures bundled board assets are installed, starts a
  loopback-only server on `127.0.0.1`, opens the browser, and prints a fallback
  URL you can paste manually if launch fails
- `trekoon board update` refreshes the runtime assets in `.trekoon/board`
  without opening a browser or starting the server

Why the board uses a local server instead of a bare HTML file:

- the UI needs live reads and writes against Trekoon data, not a static export
- the server binds only to `127.0.0.1`
- each `board open` call generates a per-session token used by the browser/API
- bundled assets are copied from the CLI package into `.trekoon/board`, so the
  board works without a separate frontend install or local build step

Current runtime expectations for operators:

- the served HTML, styles, and board app files come from the local
  `.trekoon/board` runtime directory
- all assets are self-hosted: the board ships its own CSS, fonts (Inter,
  Material Symbols), and vanilla JS with no framework or CDN dependencies
- the board works fully offline once the runtime assets are copied into
  `.trekoon/board`

Current layout behavior:

- the topbar is a compact navbar with workspace identity, Epics and Board
  navigation, debounced search, theme toggle, and workspace info
- the board toggles between an epics overview and a task workspace view; task
  detail opens as a modal overlay
- responsive breakpoints adjust kanban column counts and component spacing so
  the board remains navigable on narrower widths
- the page scrolls naturally as one document; modal overlays lock body scroll
  while open
- task cards show truncated descriptions; clicking a card opens the task detail
  modal with the full description and edit controls
- search filters client-side across titles, descriptions, statuses, and subtask
  content with a 180ms debounce

Verification checklist for operators:

1. Open the board with `trekoon board open` and confirm the first view is the
   epic overview with all epics listed and scrollable.
2. Click an epic card and confirm you enter the board workspace with the topbar
   showing the active epic context.
3. Type in search and verify results filter as you type; confirm focus stays in
   the search input while typing.
4. Click a task card and confirm the task detail modal opens with the full
   description, edit form, and subtask list.
5. On desktop width, confirm the kanban board shows multiple columns.
6. Resize to a narrow viewport and confirm columns reflow cleanly without
   horizontal overflow.
7. Close modals and confirm you return to the previous board context.

## Create an epic, task, and subtask

```bash
trekoon epic create --title "Agent backlog stabilization" --description "Track stabilization work" --status todo
trekoon task create --title "Implement sync status" --description "Add status reporting" --epic <epic-id> --status todo
trekoon subtask create --task <task-id> --title "Add cursor model" --status todo
```

Useful follow-up reads:

```bash
trekoon task list
trekoon task list --status done
trekoon task list --limit 25
trekoon task list --all --view compact
```

## Prefer one-shot planning when the graph is already known

If you already know the epic tree, create the epic, tasks, subtasks, and
dependencies in one call:

```bash
trekoon epic create \
  --title "Batch command rollout" \
  --description "Ship one-shot planning workflows" \
  --task "task-a|First task|First description|todo" \
  --task "task-b|Second task|Second description|todo" \
  --subtask "@task-a|sub-a|First subtask|Subtask description|todo" \
  --dep "@task-b|@task-a" \
  --dep "@sub-a|@task-a"
```

Use this when:

- the epic does not exist yet
- later records need to reference earlier records with `@temp-key`
- you want one atomic create step and one machine response with mappings and
  counts

## Add dependencies

```bash
trekoon dep add <task-id> <depends-on-id>
trekoon dep list <task-id>
```

## Use batch commands for larger updates

When one call needs to create or link multiple records, prefer the transactional
batch commands:

| Need | Command |
| --- | --- |
| Create multiple tasks under one epic | `trekoon task create-many --epic <epic-id> --task ...` |
| Create multiple subtasks under one task | `trekoon subtask create-many <task-id> --subtask ...` |
| Add multiple dependency edges | `trekoon dep add-many --dep ...` |
| Expand an existing epic with linked records | `trekoon epic expand <epic-id> ...` |

These commands validate the whole batch before applying changes, so a bad input
fails the whole operation instead of leaving partial state behind.

## Close or reopen a whole tree in one update

When you need to manually finish or reopen an entire epic or task tree, use the
positional-ID cascade form of `update --all`:

```bash
trekoon epic update <epic-id> --all --status done
trekoon epic update <epic-id> --all --status todo
trekoon task update <task-id> --all --status done
trekoon task update <task-id> --all --status todo
trekoon subtask update <subtask-id> --all --status done
```

Rules:

- `epic update <id> --all --status done|todo` updates the epic and all
  descendants atomically
- `task update <id> --all --status done|todo` updates the task and all
  descendant subtasks atomically
- `subtask update <id> --all --status done|todo` is accepted for consistency,
  but it only updates that one subtask
- Positional-ID cascade mode is status-only; do not combine it with `--append`,
  `--description`, `--title`, or `--ids`
- If any epic/task descendant is blocked by an unresolved external dependency,
  the whole cascade fails with no partial writes

## Check progress and get suggestions

After creating work, use `epic progress` to see status counts and the next ready
candidate:

```bash
trekoon epic progress <epic-id>
```

Use `suggest` for priority-ranked next-action recommendations:

```bash
trekoon suggest
trekoon suggest --epic <epic-id>
```

## Status machine

Trekoon enforces valid status transitions. The canonical statuses are `todo`,
`in_progress`, `done`, and `blocked`. Direct jumps like `todo → done` are
rejected — use `task done` which auto-transitions through `in_progress`.

Valid transitions:

| From | Allowed targets |
| --- | --- |
| `todo` | `in_progress`, `blocked` |
| `in_progress` | `done`, `blocked` |
| `blocked` | `in_progress`, `todo` |
| `done` | `in_progress` |

## Install the AI skill

Install the Trekoon skill so AI agents can plan and execute against your tracker:

```bash
trekoon skills install                # repo-local (default)
trekoon skills install -g             # global (~/.agents/skills/trekoon)
trekoon skills install --link --editor claude  # repo-local + editor symlink
```

After upgrading Trekoon, refresh all installed skills:

```bash
trekoon update                        # alias for: trekoon skills update
```

For detailed installation, editor linking, and example prompts, read
[AI agents and the Trekoon skill](ai-agents.md).

## Pre-merge sync flow

Before opening or merging a PR, sync and inspect any conflicts before resolving
them:

```bash
trekoon --toon sync status
trekoon --toon sync pull --from main
trekoon --toon sync conflicts list
trekoon --toon sync conflicts show <id>
trekoon --toon sync resolve <id> --use theirs --dry-run
trekoon --toon sync resolve <id> --use ours|theirs
trekoon --toon sync status
```

Steps:

1. `sync pull --from main` — fetch upstream tracker events.
2. `sync conflicts list` — list all unresolved conflicts by ID.
3. `sync conflicts show <id>` — inspect the ours/theirs diff for a specific
   conflict before deciding how to resolve it.
4. `sync resolve <id> --use theirs --dry-run` — preview what the resolution
   would write without mutating the database (optional but recommended).
5. `sync resolve <id> --use ours|theirs` — apply the resolution.
6. Run `sync status` again to confirm no conflicts remain before merging.

Never call `sync resolve` without first running `sync conflicts show` to
understand what will be overwritten. In human mode (no `--toon`), `--use theirs`
prompts for confirmation with a 30-second timeout.

## What to read next

- [Command reference](commands.md)
- [AI agents and the Trekoon skill](ai-agents.md)
- [Machine contracts](machine-contracts.md)
