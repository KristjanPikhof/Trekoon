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
- `trekoon help [command]`
- `trekoon quickstart`
- `trekoon epic <create|list|show|update|delete>`
- `trekoon task <create|list|show|ready|next|update|delete>`
- `trekoon subtask <create|list|update|delete>`
- `trekoon dep <add|remove|list|reverse>`
- `trekoon events prune [--dry-run] [--archive] [--retention-days <n>]`
- `trekoon migrate <status|rollback> [--to-version <n>]`
- `trekoon sync <status|pull|resolve|conflicts>`
- `trekoon skills install [--link --editor opencode|claude|pi] [--to <path>] [--allow-outside-repo]`
- `trekoon skills update`
- `trekoon wipe --yes`

Global output modes:

- `--json` for structured JSON output
- `--toon` for true TOON-encoded output (not JSON text)
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

Trekoon options use long form (`--option`) for command/subcommand flags.
Root help/version aliases `-h` and `-v` are also supported.

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
- Cursor pagination: `--cursor <n>` (offset-like start index for next page)
- All rows and statuses: `--all`
- `--all` is mutually exclusive with `--status`, `--limit`, and `--cursor`

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

Trekoon is local-first: in git repos/worktrees, Trekoon resolves state to one
canonical repository root (`git rev-parse --show-toplevel`) so nested
invocations share the same `.trekoon/trekoon.db`.

Outside git repos, Trekoon falls back to the invocation cwd.

When machine output is enabled (`--json`/`--toon`) and a command resolves
storage from a non-canonical cwd, Trekoon emits
`meta.storageRootDiagnostics` to make the divergence explicit for automation.

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

### 4) AI execution loop for agents

Run this loop each session to pick next work deterministically:

```bash
trekoon --toon sync status
trekoon --toon task ready --limit 5
trekoon --toon task next
trekoon --toon dep reverse <task-or-subtask-id>
trekoon --toon task update <task-id> --status in_progress
```

When done or blocked, append context and update final status:

```bash
trekoon --toon task update <task-id> --append "Completed implementation and checks" --status done
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

### 5) Use TOON output for agent workflows

```bash
trekoon --toon epic show <epic-id>
trekoon --toon task show <task-id>
```

Optional alternative for integrations that explicitly require JSON:

```bash
trekoon --json epic show <epic-id>
trekoon --json task show <task-id>
```

### 6) Scoped search for repeated text

Use scoped search before manual tree reads when you need to locate repeated
paths, labels, or migration targets.

```bash
trekoon --toon epic search <epic-id> "path/to/somewhere"
trekoon --toon task search <task-id> "path/to/somewhere"
trekoon --toon subtask search <subtask-id> "path/to/somewhere"
```

Scope rules:

- `epic search` scans the epic title/description plus every task and subtask
  title/description in that epic tree.
- `task search` scans the task title/description plus descendant subtask
  title/description.
- `subtask search` scans only that subtask's title/description.
- Add `--fields title`, `--fields description`, or
  `--fields title,description` when you need a narrower scan.

### 7) Preview first, then apply scoped replace

Use search first to confirm the scope, then run replace in preview mode, and
only use `--apply` after the preview matches the intended migration.

```bash
trekoon --toon epic search <epic-id> "path/to/somewhere"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply
```

Use this loop for low-risk agent workflows:

1. `search` when you need the smallest possible read before deciding whether a
   migration is needed.
2. preview `replace` to verify the exact candidate set and changed fields.
3. `replace --apply` only after the preview output matches the intended scope.

Epic-scoped replace applies across the epic title/description and every task and
subtask title/description in that epic tree.

### 8) Sync workflow for worktrees

- Run `trekoon sync status` at session start and before PR/merge.
- Run `trekoon sync pull --from main` before merge to align tracker state.
- If conflicts exist, resolve explicitly:

```bash
trekoon sync status
trekoon sync pull --from main
trekoon sync conflicts list
trekoon sync conflicts show <conflict-id>
trekoon sync resolve <conflict-id> --use ours
```

`sync pull` machine output includes diagnostics counters and hints so agents can
react deterministically:

- `diagnostics.malformedPayloadEvents`
- `diagnostics.applyRejectedEvents`
- `diagnostics.quarantinedEvents`
- `diagnostics.conflictEvents`
- `diagnostics.errorHints`

Compatibility mode for legacy sync command IDs:

```bash
trekoon --json --compat legacy-sync-command-ids sync status
trekoon --toon --compat legacy-sync-command-ids sync pull --from main
```

Behavior:

- Default remains strict canonical IDs (`sync.status`, `sync.pull`, ...).
- Compatibility mode rewrites sync command IDs to legacy forms
  (`sync_status`, `sync_pull`, ...).
- Compatibility mode is machine-only and valid only for `sync` commands.
- Machine output includes `metadata.compatibility` with:
  - deprecation warning code
  - migration guidance
  - canonical + compatibility command IDs
  - removal window (`removalAfter: 2026-09-30`)
- Migration path: remove `--compat legacy-sync-command-ids` and consume dotted
  command IDs directly.

### 9) Install project-local Trekoon skill for agents

`trekoon skills install` always writes the bundled skill file under the current
working directory at:

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
- By default, link targets must resolve inside the current working directory root.
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
   - `<cwd>/.agents/skills/trekoon/SKILL.md`
2. If `--link` is present, Trekoon creates a `trekoon` symlink directory entry.
3. `--to <path>` sets the symlink root directory.
4. Final link path is:
   - `<resolved-to-path>/trekoon -> <cwd>/.agents/skills/trekoon`

Example:

```bash
trekoon skills install --link --editor opencode --to ./.custom-editor/skills
```

This produces:

- `<cwd>/.agents/skills/trekoon/SKILL.md` (copied file)
- `<cwd>/.custom-editor/skills/trekoon` (symlink)
- symlink target: `<cwd>/.agents/skills/trekoon`

Trekoon does not mutate global editor config directories.

### 10) Pre-merge checklist

- [ ] `trekoon sync status` shows no unresolved conflicts
- [ ] done tasks/subtasks are marked completed
- [ ] dependency graph has no stale blockers
- [ ] final AI check: `trekoon --toon epic show <epic-id>`

## Machine-contract recipes (--toon)

Use `--toon` for production agent loops. The examples below show command +
expected envelope fields.

Base envelope fields (all machine responses):

```text
ok: true|false
command: <stable command id>
data: <payload>
metadata:
  contractVersion: "1.0.0"
  requestId: req-<stable-id>
```

Most subcommand identifiers are dot-namespaced (`task.list`, `sync.pull`,
`epic.show`). Root-level commands may use single-token IDs (`help`, `init`,
`quickstart`, `wipe`, `version`).

Additional metadata can appear when relevant:

- `metadata.compatibility` when `--compat` mode is active
- `meta.storageRootDiagnostics` when a machine-readable command resolves
  storage from a non-canonical cwd

### Ready queue (deterministic candidates)

```bash
trekoon --toon task ready --limit 3
```

Payload fields:

```text
ok: true
command: task.ready
data:
  candidates[]:
    task: { id, epicId, title, status, ... }
    readiness: { isReady, reason }
    blockerSummary: { blockedByCount, totalDependencies, blockedBy[] }
    ranking: { rank, blockerCount, statusPriority }
  blocked[]: (same shape, non-ready items)
  summary: {
    totalOpenTasks,
    readyCount,
    returnedCount,
    appliedLimit,
    blockedCount,
    unresolvedDependencyCount,
  }
```

### Reverse dependency walk (blocker impact)

```bash
trekoon --toon dep reverse <task-or-subtask-id>
```

Payload fields:

```text
ok: true
command: dep.reverse
data:
  targetId: <id>
  targetKind: task|subtask
  blockedNodes[]: { id, kind, distance, isDirect }
```

### Pagination contract for machine list calls

```bash
trekoon --toon task list --status todo --limit 2
trekoon --toon task list --status todo --limit 2 --cursor 2
```

Cursor semantics:

- `--cursor <n>` is offset-like pagination for list endpoints (`epic list`,
  `task list`, `subtask list`).
- Do not combine `--all` with `--cursor`.
- Machine consumers should page using `meta.pagination.hasMore` and
  `meta.pagination.nextCursor`.

Payload fields:

```text
ok: true
command: task.list
data:
  tasks[]: ...
metadata:
  contractVersion: "1.0.0"
  requestId: req-<stable-id>
meta:
  pagination: { hasMore, nextCursor }
```

## Implementation principles

- Minimal, composable modules
- Strict validation at command boundaries
- Stable automation envelope for JSON/TOON modes
- No unnecessary feature sprawl
