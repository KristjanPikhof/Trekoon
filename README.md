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
3. Keep one repo-scoped state store that every worktree can coordinate through safely.
4. Stay minimal in code size while preserving robustness and clear boundaries.

## Command surface

- `trekoon init`
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

Trekoon is local-first, but in git repos and worktrees it is **repo-shared**:
every worktree for the same repository resolves to one shared `.trekoon`
directory and one shared `.trekoon/trekoon.db`.

- `worktreeRoot` identifies the current checkout.
- `sharedStorageRoot` identifies the repository root that owns `.trekoon`.
- `databaseFile` points at the shared SQLite database.
- `.trekoon` stays gitignored on purpose because the DB is operational state,
  not source code.
- Committing `.trekoon/trekoon.db` is the wrong fix for drift because it bakes
  machine-local state and stale snapshots into Git.

Outside git repos, Trekoon falls back to the invocation cwd.

When machine output is enabled (`--json`/`--toon`) and a command resolves
storage from a non-canonical cwd, Trekoon emits
`meta.storageRootDiagnostics` so automation can verify the storage contract.

### 1) Initialize

```bash
trekoon init
trekoon --version
```

Bootstrap expectations:

- Run `trekoon --toon init` once per repository to create or re-bootstrap the
  shared storage root.
- Run `trekoon --toon sync status` before agent work to inspect diagnostics.
- If diagnostics report `recoveryRequired`, a tracked/ignored mismatch, or an
  ambiguous recovery path, stop and repair setup before continuing.
- Do **not** continue with task selection after broken bootstrap warnings.

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

### 2a) Preferred one-shot epic creation

When you already know the epic tree, create the epic, tasks, subtasks, and
dependencies in one invocation.

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
- later records need to reference earlier created records via `@temp-key`
- you want one atomic create step and one machine response with mappings/counts

Compact machine output adds:

```text
command: epic.create
data:
  epic: created epic row
  tasks[]: created tasks in input order
  subtasks[]: created subtasks in input order
  dependencies[]: created dependencies in input order
  result:
    mappings[]: { kind: task|subtask, tempKey, id }
    counts: { tasks, subtasks, dependencies }
```

### 3) Add dependencies

```bash
trekoon dep add <task-id> <depends-on-id>
trekoon dep list <task-id>
```

### 3a) Batch planning commands

Use compact batch commands when one invocation needs to create or link multiple
items atomically. Use the single-item commands when you already have persisted
UUIDs and only need one mutation.

#### `task create-many`

Create multiple tasks under one epic in declared order.

```bash
trekoon task create-many \
  --epic <epic-id> \
  --task "seed-api|Design API|Define batch grammar|todo" \
  --task "seed-cli|Wire CLI|Hook parser and output|in_progress"
```

Compact spec:

- `--task <temp-key>|<title>|<description>|<status>`
- escape `\|`, `\\`, `\n`, `\r`, `\t`
- repeated `--task` flags are preserved in the exact order provided
- temp keys are local mapping labels, not persisted IDs

Rollback semantics:

- Trekoon validates the full batch before inserts
- duplicate temp keys, empty required fields, or invalid input fail the whole
  command
- no partial task rows are kept on failure

Compact machine output:

```text
command: task.create-many
data:
  epicId: <epic-id>
  tasks[]: created task rows in input order
  result:
    mappings[]: { kind: task, tempKey, id }
```

#### `subtask create-many`

Create multiple subtasks under one existing task.

```bash
trekoon subtask create-many <task-id> \
  --subtask "seed-tests|Write tests|Cover happy path|todo" \
  --subtask "seed-docs|Document flow|Add operator notes|todo"
```

Equivalent explicit parent form:

```bash
trekoon subtask create-many \
  --task <task-id> \
  --subtask "seed-tests|Write tests|Cover happy path|todo"
```

Rules:

- positional `<task-id>` or `--task <task-id>` may be used
- if both are provided, they must be identical or the command fails
- repeated `--subtask` flags are applied in declared order

Rollback semantics:

- full batch prevalidation happens before inserts
- duplicate temp keys, conflicting task ids, or invalid specs abort the whole
  command
- no partial subtasks are kept on failure

Compact machine output:

```text
command: subtask.create-many
data:
  taskId: <task-id>
  subtasks[]: created subtask rows in input order
  result:
    mappings[]: { kind: subtask, tempKey, id }
```

#### `dep add-many`

Create multiple dependency edges in one ordered, transactional operation.

```bash
trekoon dep add-many \
  --dep "<task-b>|<task-a>" \
  --dep "<subtask-c>|<task-b>"
```

Compact spec:

- `--dep <source-ref>|<depends-on-ref>`
- repeated `--dep` flags are applied in declared order
- standalone `dep add-many` resolves persisted IDs only
- `@temp-key` refs are **not** resolved from earlier commands; they are reserved
  for same-invocation workflows such as `epic expand`

Rollback semantics:

- validation covers the full dependency set before insert
- missing ids, unresolved `@temp-key` refs, duplicates, or cycles fail the whole
  batch
- no partial dependency edges are inserted on failure

Compact machine output:

```text
command: dep.add-many
data:
  dependencies[]: created dependency rows in input order
  result:
    mappings[]: []
```

#### `epic expand`

Expand one existing epic by creating tasks, subtasks, and dependencies in one
transaction. Use this when the epic already exists and you want to add a linked
batch later.

```bash
trekoon epic expand <epic-id> \
  --task "task-api|Design API|Define compact grammar|todo" \
  --task "task-cli|Wire CLI|Hook parser and output|todo" \
  --subtask "@task-api|sub-tests|Write tests|Cover parser cases|todo" \
  --dep "@task-cli|@task-api" \
  --dep "@sub-tests|@task-api"
```

Compact specs:

- `--task <temp-key>|<title>|<description>|<status>`
- `--subtask <parent-ref>|<temp-key>|<title>|<description>|<status>`
- `--dep <source-ref>|<depends-on-ref>`
- `@temp-key` refs may target tasks/subtasks declared earlier in the same
  `epic expand` invocation

Background phases:

1. validate all compact specs and duplicate temp keys
2. create tasks transactionally
3. resolve subtask parent temp keys and create subtasks
4. resolve dependency refs and link dependencies
5. append task, subtask, then dependency events
6. roll back the full expansion if any phase fails

Compact machine output:

```text
command: epic.expand
data:
  epicId: <epic-id>
  tasks[]: created tasks in input order
  subtasks[]: created subtasks in input order
  dependencies[]: created dependencies in input order
  result:
    mappings[]: { kind: task|subtask, tempKey, id }
    counts: { tasks, subtasks, dependencies }
```

When to choose which command:

- use `task create-many` for sibling tasks under one known epic
- use `subtask create-many` for sibling subtasks under one known task
- use `dep add-many` only when every endpoint already has a persisted ID
- use `epic create` with batch specs when the epic does not exist yet and the
  whole graph is known up front
- use `epic expand` when the epic already exists and one batch must add linked
  tasks/subtasks/dependencies with `@temp-key` references

### 4) AI execution loop for agents

The primary loop is: **session → work → task done → repeat**.

Orient with a single call that returns diagnostics, sync status, next ready
task with subtasks, blocker list, and readiness counts:

```bash
trekoon --toon session
```

Claim work, then finish or report a block:

```bash
trekoon --toon task update <task-id> --status in_progress
trekoon --toon task done <task-id>
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

`task done` marks the task done and returns the next ready task with
dependencies inline, replacing the old multi-step transition.

Fail-fast rules:

- Treat `meta.storageRootDiagnostics` as the source of truth for worktree
  storage.
- In linked worktrees, `sharedStorageRoot` may differ from `worktreeRoot`; that
  is expected.
- If `recoveryRequired` is `true`, stop and follow the reported bootstrap or
  recovery action.
- Do not fall back to a separate per-worktree DB or continue after missing
  shared storage.

<details>
<summary>Legacy manual bootstrap (use <code>session</code> instead)</summary>

```bash
trekoon --toon init
trekoon --toon sync status
trekoon --toon task ready --limit 5
trekoon --toon task next
trekoon --toon dep reverse <task-or-subtask-id>
trekoon --toon task update <task-id> --status in_progress
trekoon --toon task update <task-id> --append "Completed implementation and checks" --status done
```

</details>

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

Compact TOON expectations for agents:

```text
ok: true
command: epic.search
data:
  scope: epic
  query: { search, fields[], mode: preview }
  matches[]: { kind, id, fields[]: { field, count, snippet } }
  summary: { matchedEntities, matchedFields, totalMatches }
metadata:
  contractVersion: 1.0.0
  requestId: req-<id>
```

```text
ok: true
command: epic.replace
data:
  scope: epic
  query: { search, replace, fields[], mode: preview|apply }
  matches[]: { kind, id, fields[]: { field, count, snippet } }
  summary: { matchedEntities, matchedFields, totalMatches, mode }
metadata:
  contractVersion: 1.0.0
  requestId: req-<id>
```

Background behavior:

- `epic search` and preview `epic replace` traverse the epic first, then
  descendant tasks, then descendant subtasks.
- Within each record, Trekoon checks `title` before `description` so output stays
  deterministic and low-token.
- Preview reports the candidate set without mutating records.
- `--apply` reuses the same scoped traversal, updates only rows with real text
  changes, and returns the matched rows with `query.mode` and `summary.mode`
  set to `"apply"`.

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

Worktree diagnostics and recovery:

- Inspect `storageMode`, `repoCommonDir`, `worktreeRoot`, `sharedStorageRoot`,
  and `databaseFile` in machine output when debugging worktree behavior.
- If a worktree resolves shared storage outside its checkout, that is expected
  for linked worktrees and should not be “fixed” by committing `.trekoon`.
- If Git contains a tracked `.trekoon/trekoon.db`, remove it from Git history or
  the index as appropriate, keep `.trekoon` ignored, and re-run
  `trekoon --toon init`.
- Use `trekoon wipe --yes` only for explicit destructive recovery; it deletes
  the shared storage root for the entire repository, not just the current
  worktree.

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
- Editor symlinks are written with relative targets so repo-local links survive
  moving the repository.
- Use `--allow-outside-repo` only for intentional external links.
- When override is used, install prints a warning and includes confirmation
  fields in machine output.
- Re-running install is idempotent: it refreshes `SKILL.md` and reuses/replaces
  the same symlink target.
- `trekoon skills update` is idempotent: it refreshes canonical
  `.agents/skills/trekoon/SKILL.md` and creates or refreshes default editor
  links when their config directories exist.
- Update skips editors with no config dir and leaves conflicts untouched while
  reporting actionable path context.
- If the link destination exists as a non-link path, install fails with an
  actionable conflict error.

How `--to` works (step-by-step):

1. Trekoon always installs/copies to:
   - `<cwd>/.agents/skills/trekoon/SKILL.md`
2. If `--link` is present, Trekoon creates a `trekoon` symlink directory entry.
3. `--to <path>` sets the symlink root directory.
4. Final link path is:
   - `<resolved-to-path>/trekoon -> <relative path to <cwd>/.agents/skills/trekoon>`

Example:

```bash
trekoon skills install --link --editor opencode --to ./.custom-editor/skills
```

This produces:

- `<cwd>/.agents/skills/trekoon/SKILL.md` (copied file)
- `<cwd>/.custom-editor/skills/trekoon` (symlink)
- symlink target: relative path to `<cwd>/.agents/skills/trekoon`

Trekoon does not mutate global editor config directories.

### 10) Pre-merge checklist

- [ ] `trekoon sync status` shows no unresolved conflicts
- [ ] done tasks/subtasks are marked completed
- [ ] dependency graph has no stale blockers
- [ ] final AI check: `trekoon --toon epic show <epic-id>`
- [ ] no one tried to commit `.trekoon/trekoon.db` as a worktree fix

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
