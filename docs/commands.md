# Command reference

Use this page when you already know what Trekoon does and just need the command
surface, defaults, and flag rules.

## Command surface

- `trekoon init`
- `trekoon board <open|update>`
- `trekoon help [command]`
- `trekoon quickstart`
- `trekoon epic <create|expand|list|show|search|replace|update|delete>`
- `trekoon session`
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

- Default scope: open work only (`in_progress`, `in-progress`, `todo`)
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

## Related docs

- [Quickstart](quickstart.md)
- [AI agents and the Trekoon skill](ai-agents.md)
- [Machine contracts](machine-contracts.md)
