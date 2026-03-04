# Trekoon

AI-first issue tracking for humans and agents.

Trekoon is a Bun-powered CLI focused on execution workflows where AI agents and humans share the same task graph.

## Installation

Recommended (global install with Bun):

```bash
bun add -g trekoon
```

Then verify:

```bash
trekoon --help
trekoon quickstart
```

Alternative (npm global install):

```bash
npm i -g trekoon
```

## What Trekoon is

- Local-first CLI issue tracker
- Structured hierarchy: **epic → task → subtask**
- UUID-based references for durable linking across branches/worktrees
- Dependency-aware planning and execution
- Output modes:
  - **Human mode** for terminal users
  - **JSON mode** for stable machine parsing
  - **TOON mode** for true TOON-encoded payloads

## What Trekoon aims to accomplish

1. Make issue tracking fast enough for daily terminal use.
2. Make issue data deterministic and machine-readable for AI automation.
3. Keep branch/worktree-aware state so parallel execution can be coordinated safely.
4. Stay minimal in code size while preserving robustness and clear boundaries.

## Command surface

- `trekoon init`
- `trekoon quickstart`
- `trekoon epic <create|list|show|update|delete>`
- `trekoon task <create|list|show|update|delete>`
- `trekoon subtask <create|list|update|delete>`
- `trekoon dep <add|remove|list>`
- `trekoon sync <status|pull|resolve>`
- `trekoon skills install [--link --editor opencode|claude|pi] [--to <path>]`
- `trekoon skills update`
- `trekoon wipe --yes`

Global output modes:

- `--json` for structured JSON output
- `--toon` for true TOON-encoded output (not JSON text)
- `--help` for root and command help
- `--version` for CLI version

Global options can be used before or after the command:

```bash
trekoon --toon quickstart
trekoon quickstart --toon
trekoon --json quickstart
trekoon quickstart --json
```

Trekoon currently accepts long option form (`--option`).

Human view options:

- List and show commands default to table output in human mode.
- Use `--view compact` to restore compact pipe output.
- `epic list`, `task list`, and `subtask list` support `--view table|compact`.
- `epic show` and `task show` support `--view table|compact|tree|detail`.

List defaults and filters (`epic list`, `task list`, `subtask list`):

- Default scope: open work only (`in_progress`, `in-progress`, `todo`)
- Default limit: `10`
- Status filter: `--status in_progress,todo` (CSV)
- Custom limit: `--limit <n>`
- All rows and statuses: `--all`
- `--all` is mutually exclusive with `--status` and `--limit`

Bulk updates (`epic update`, `task update`, `subtask update`):

- Target all rows: `--all`
- Target specific rows: `--ids <id1,id2,...>`
- Bulk updates support only `--append <text>` and/or `--status <status>`
- In bulk mode, do not pass a positional id
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
trekoon epic create --title "Agent backlog stabilization" --description "Track stabilization work" --status todo
trekoon task create --title "Implement sync status" --description "Add status reporting" --epic <epic-id> --status todo
trekoon subtask create --task <task-id> --title "Add cursor model" --status todo
trekoon task list
trekoon task list --status done
trekoon task list --limit 25
trekoon task list --all --view compact
```

### 3) Add dependencies

```bash
trekoon dep add <task-id> <depends-on-id>
trekoon dep list <task-id>
```

### 4) Use JSON or TOON output for agents

```bash
trekoon --json epic show <epic-id>
trekoon --json task show <task-id>
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

`sync pull` machine output includes diagnostics counters and hints so agents can
react deterministically:

- `diagnostics.malformedPayloadEvents`
- `diagnostics.applyRejectedEvents`
- `diagnostics.quarantinedEvents`
- `diagnostics.conflictEvents`
- `diagnostics.errorHints`

### 6) Install project-local Trekoon skill for agents

`trekoon skills install` always writes the bundled skill file into the current
repository at:

- `.agents/skills/trekoon/SKILL.md`

You can also create a project-local editor link:

```bash
trekoon skills install
trekoon skills install --link --editor opencode
trekoon skills install --link --editor claude
trekoon skills install --link --editor pi
trekoon skills install --link --editor opencode --to ./.custom-editor/skills
trekoon skills update
```

Path behavior:

- Default opencode link path: `.opencode/skills/trekoon`
- Default claude link path: `.claude/skills/trekoon`
- Default pi link path: `.pi/skills/trekoon`
- `--to <path>` overrides the editor root for link creation only.
- `--to` does **not** move or copy `SKILL.md` to that path.
- By default, link targets must resolve inside the repository root.
- Use `--allow-outside-repo` only for intentional external links.
- When override is used, install prints a warning and includes confirmation
  fields in machine output.
- Re-running install is idempotent: it refreshes `SKILL.md` and reuses/replaces
  the same symlink target.
- `trekoon skills update` is idempotent: it refreshes canonical
  `.agents/skills/trekoon/SKILL.md` and reports default link states for
  opencode/claude/pi as `missing`, `valid`, or `conflict`.
- Update does not mutate default links; conflicts are reported with actionable
  path context.
- If the link destination exists as a non-link path, install fails with an
  actionable conflict error.

How `--to` works (step-by-step):

1. Trekoon always installs/copies to:
   - `<repo>/.agents/skills/trekoon/SKILL.md`
2. If `--link` is present, Trekoon creates a `trekoon` symlink directory entry.
3. `--to <path>` sets the symlink root directory.
4. Final link path is:
   - `<resolved-to-path>/trekoon -> <repo>/.agents/skills/trekoon`

Example:

```bash
trekoon skills install --link --editor opencode --to ./.custom-editor/skills
```

This produces:

- `<repo>/.agents/skills/trekoon/SKILL.md` (copied file)
- `<repo>/.custom-editor/skills/trekoon` (symlink)
- symlink target: `<repo>/.agents/skills/trekoon`

Trekoon does not mutate global editor config directories.

### 7) Pre-merge checklist

- [ ] `trekoon sync status` shows no unresolved conflicts
- [ ] done tasks/subtasks are marked completed
- [ ] dependency graph has no stale blockers
- [ ] final AI check: `trekoon --toon epic show <epic-id>`

## Implementation principles

- Minimal, composable modules
- Strict validation at command boundaries
- Stable automation envelope for JSON/TOON modes
- No unnecessary feature sprawl
