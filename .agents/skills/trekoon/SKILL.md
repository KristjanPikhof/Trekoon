---
name: trekoon
description: Use Trekoon to create issues/tasks, plan backlog and sprints, create epics, update status, track progress, and manage dependencies/sync across repository workflows.
---

# Trekoon Skill

Trekoon is a local-first issue tracker for epics, tasks, and subtasks.

## CRITICAL: Always Use --toon Flag

**Every trekoon command MUST include `--toon` for machine-readable output.**

The `--toon` flag outputs structured YAML-like data that is easy to parse. Never run trekoon commands without it.

### TOON Output Format

All `--toon` output follows this structure:

```yaml
ok: true
command: task.list
data:
  tasks[0]:
    id: abc-123
    epicId: epic-456
    title: Implement feature X
    status: todo
    createdAt: 1700000000000
    updatedAt: 1700000000000
  tasks[1]:
    id: def-789
    epicId: epic-456
    title: Write tests
    status: in_progress
    createdAt: 1700000001000
    updatedAt: 1700000001000
metadata:
  contractVersion: 1.0.0
  requestId: req-abc12345
```

On error:

```yaml
ok: false
command: task.show
data: {}
metadata:
  contractVersion: 1.0.0
  requestId: req-def67890
error:
  code: not_found
  message: task not found: invalid-id
```

### Key Fields

| Field | Meaning |
|-------|---------|
| `ok` | `true` if command succeeded, `false` on error |
| `command` | The command that was executed (e.g., `task.list`, `epic.create`) |
| `data` | The response payload (tasks, epics, dependencies, etc.) |
| `metadata` | Contract metadata (`contractVersion`, `requestId`) |
| `meta` | Optional command-specific metadata (pagination/defaults/filters/diagnostics) |
| `error` | Present only on failure, contains `code` and `message` |

Use long flags (`--status`, `--description`, etc.) and ALWAYS append `--toon` to every command.

### Contract details to rely on

- Machine responses include `metadata.contractVersion` and `metadata.requestId`.
- Command IDs are stable and typically dot namespaced (`task.list`, `sync.status`).
- Some root commands use single-token IDs (`help`, `init`, `quickstart`, `wipe`, `version`).
- Unknown options fail fast with deterministic `unknown_option` errors and may include:
  - `data.option`
  - `data.allowedOptions`
  - `data.suggestions`

### Compatibility mode (legacy sync consumers)

Default behavior is strict canonical IDs (for example `sync.status`).

If a legacy consumer still expects underscore sync IDs, compatibility mode can be used:

```bash
trekoon --toon --compat legacy-sync-command-ids sync status
```

When enabled, output includes `metadata.compatibility` with migration/deprecation details.

## 1) Status Management

### Status values

Trekoon accepts any non-empty status string.

Recommended statuses for consistent workflows:

| Status | Meaning |
|--------|---------|
| `todo` | Work not started (default for new items) |
| `in_progress` | Actively being worked on |
| `done` | Completed successfully |

Note: `in-progress` (hyphenated) is treated the same as `in_progress` for default list ordering/filtering.

### When to Change Status

| Transition | When to apply |
|------------|---------------|
| `todo → in_progress` | When you START working on a task/subtask/epic |
| `in_progress → done` | When you COMPLETE the work and it is ready |

### Status Change Commands

```bash
trekoon task update <task-id> --status in_progress --toon
trekoon task update <task-id> --status done --toon
trekoon subtask update <subtask-id> --status done --toon
trekoon epic update <epic-id> --status done --toon
```

## 2) Dependency Management

Dependencies define what must be completed before a task can start. A task/subtask can depend on other tasks/subtasks.

### Commands

```bash
trekoon dep add <source-id> <depends-on-id> --toon
trekoon dep add-many --dep "<source-id>|<depends-on-id>" --toon
trekoon dep list <source-id> --toon
trekoon dep remove <source-id> <depends-on-id> --toon
trekoon dep reverse <task-or-subtask-id> --toon
```

- `<source-id>`: The task/subtask that has the dependency
- `<depends-on-id>`: The task/subtask that must be completed first

### Checking Dependencies

Before starting any task, always check its dependencies:

```bash
trekoon dep list <task-id> --toon
```

The response `data.dependencies` array contains entries with:
- `sourceId`: the task you're checking
- `dependsOnId`: what must be done first
- `dependsOnKind`: "task" or "subtask"

### Dependency Rules

1. A task with dependencies should only be marked `in_progress` when ALL dependencies have status `done`
2. Dependencies can only exist between tasks and subtasks (not epics)
3. Cycles are automatically detected and rejected
4. Standalone `dep add-many` resolves persisted IDs only; `@temp-key` refs do not carry across prior commands

### Batch dependency rule of thumb

- Use `dep add` for one known edge.
- Use `dep add-many` when every dependency endpoint already has a persisted UUID
  and you want one ordered transactional link step.
- Use `epic expand` instead when dependency refs need to point at tasks or
  subtasks being created in the same invocation via `@temp-key`.

## 3) Task Completion Flow

### Canonical dependency-aware execution loop

Run this sequence every session:

1. Sync branch/worktree status:
   ```bash
   trekoon sync status --toon
   ```
2. Pull deterministic ready candidates (or next candidate):
   ```bash
   trekoon task ready --limit 5 --toon
   trekoon task next --toon
   ```
3. Inspect downstream impact before changes:
   ```bash
   trekoon dep reverse <task-or-subtask-id> --toon
   ```
4. Start work with explicit status updates:
   ```bash
   trekoon task update <task-id> --status in_progress --toon
   ```
5. Finish or block with appended context + final status:
   ```bash
   trekoon task update <task-id> --append "Completed implementation" --status done --toon
   trekoon task update <task-id> --append "Blocked by <reason>" --status blocked --toon
   ```

### When Completing a Task

1. Mark the task as done:
   ```bash
   trekoon task update <task-id> --status done --toon
   ```

2. To find the next task that was blocked by this one:
   - Inspect downstream nodes: `trekoon dep reverse <task-id> --toon`
   - Pull ready queue: `trekoon task ready --limit 5 --toon`
   - Pick one deterministically: `trekoon task next --toon`

### Finding Next Work

```bash
trekoon task ready --limit 5 --toon
trekoon task next --toon
trekoon dep reverse <task-or-subtask-id> --toon
```

Use `task ready` for ranked candidates and `task next` for the top deterministic pick.

## 4) Load existing work first

Before creating or changing anything, inspect current context:

```bash
trekoon epic list --toon
trekoon task list --toon
trekoon epic show <id> --all --toon
trekoon task show <id> --all --toon
```

- `epic list` / `task list` / `subtask list` defaults:
  - open work only (`in_progress`, `in-progress`, `todo`)
  - prioritized as `in_progress`/`in-progress` first, then `todo`
  - default limit `10`
  - `--cursor <n>` is offset-like pagination for list endpoints
- Filter list explicitly when needed:

```bash
trekoon task list --status in_progress,todo --limit 20 --toon
trekoon epic list --status done --toon
trekoon task list --all --toon
```

- `--all` cannot be combined with `--status` or `--limit`.
- `--all` cannot be combined with `--cursor`.
- Machine pagination contract is in `meta.pagination.hasMore` and
  `meta.pagination.nextCursor`.
- Machine list/show responses may also include:
  - `meta.defaults`
  - `meta.filters`
  - `meta.truncation`
- `epic show <id> --all --toon`: full epic tree (tasks + subtasks)
- `task show <id> --all --toon`: task plus its subtasks

### Canonical storage root behavior

- In git repos/worktrees, Trekoon resolves storage from repository top-level so
  nested cwd invocations use one canonical `.trekoon/trekoon.db`.
- In non-git directories, Trekoon falls back to invocation cwd.
- If invocation cwd differs from canonical root, machine output may include
  `meta.storageRootDiagnostics`.

### View Options

| Command | `--view` options |
|---------|------------------|
| `list` | `table` (default), `compact` |
| `show` | `table` (default), `compact`, `tree`, `detail` |

## 5) Create work (epic/task/subtask)

```bash
trekoon epic create --title "..." --description "..." --status todo --toon
trekoon task create --epic <epic-id> --title "..." --description "..." --status todo --toon
trekoon subtask create --task <task-id> --title "..." --description "..." --status todo --toon
```

Notes:
- `description` is required for epic/task create and it must be well written.
- `status` defaults to `todo` if omitted.
- `description` is optional for subtask create.

### Batch create and expand workflows

Use batch commands when one invocation should create multiple related records
atomically. Use single-item commands when only one record is needed or when you
already have persisted IDs and do not need temp-key linking.

#### `task create-many`

Use when:

- creating several sibling tasks under one existing epic
- you want one validation/create step and a temp-key → UUID mapping back

```bash
trekoon task create-many --epic <epic-id> \
  --task "seed-api|Design API|Define grammar|todo" \
  --task "seed-cli|Wire CLI|Hook command output|todo" \
  --toon
```

Spec rules:

- `--task <temp-key>|<title>|<description>|<status>`
- repeated `--task` flags are preserved in declared order
- temp keys are local labels used only in the returned mapping

Result mapping to expect:

```text
data:
  epicId: <epic-id>
  tasks[]: created tasks in input order
  result:
    mappings[]: { kind: task, tempKey, id }
```

#### `subtask create-many`

Use when:

- creating several sibling subtasks under one existing task
- no cross-parent linking is needed in the same invocation

```bash
trekoon subtask create-many <task-id> \
  --subtask "seed-tests|Write tests|Cover parser cases|todo" \
  --subtask "seed-docs|Document behavior|Add operator notes|todo" \
  --toon
```

Task-id rules:

- pass the parent either as positional `<task-id>` or `--task <task-id>`
- if both are present, they must match exactly or Trekoon fails

Result mapping to expect:

```text
data:
  taskId: <task-id>
  subtasks[]: created subtasks in input order
  result:
    mappings[]: { kind: subtask, tempKey, id }
```

#### `dep add-many`

Use when:

- adding multiple dependency edges after all referenced nodes already exist
- you need ordered validation and linking in one transaction

```bash
trekoon dep add-many \
  --dep "<task-b>|<task-a>" \
  --dep "<subtask-c>|<task-b>" \
  --toon
```

Important temp-key limitation:

- standalone `dep add-many` does **not** resolve unresolved `@temp-key` refs
  from earlier commands
- `@temp-key` refs are for same-invocation workflows such as `epic expand`

Result mapping to expect:

```text
data:
  dependencies[]: created dependencies in input order
  result:
    mappings[]: []
```

#### `epic expand`

Use when:

- one invocation should create tasks, subtasks, and dependencies together
- later specs need to refer to earlier created records before UUIDs exist

```bash
trekoon epic expand <epic-id> \
  --task "task-api|Design API|Define grammar|todo" \
  --subtask "@task-api|sub-tests|Write tests|Cover parser cases|todo" \
  --dep "@task-api|@sub-tests" \
  --toon
```

How temp keys work:

- declare a task/subtask with a plain temp key like `task-api` or `sub-tests`
- refer to it later in the same `epic expand` invocation as `@task-api` or
  `@sub-tests`
- temp keys are transient planning handles; UUIDs are returned only after create
- if a referenced temp key is unknown, the entire expansion fails and rolls back

Background phases Trekoon performs:

1. validate compact specs, required fields, and duplicate temp keys
2. create records transactionally
3. resolve temp-key refs for subtask parents and dependency endpoints
4. link dependencies
5. append task events, then subtask events, then dependency events
6. roll back the whole batch on any failure

Result mapping to expect:

```text
data:
  epicId: <epic-id>
  tasks[]: created tasks in input order
  subtasks[]: created subtasks in input order
  dependencies[]: created dependencies in input order
  result:
    mappings[]: { kind: task|subtask, tempKey, id }
    counts: { tasks, subtasks, dependencies }
```

### Batch rollback guarantees

- batch commands validate the full request before partial success is exposed
- invalid compact specs, unresolved temp keys, missing ids, duplicates, or
  cycles fail the entire batch
- on failure, Trekoon rolls back created rows and linked dependency/event work

## 6) Update work

### Single-item update

```bash
trekoon epic update <epic-id> --title "..." --description "..." --status in_progress --toon
trekoon task update <task-id> --title "..." --description "..." --status in_progress --toon
trekoon subtask update <subtask-id> --title "..." --description "..." --status in_progress --toon
```

### Bulk update (task/epic)

```bash
trekoon task update --all --append "..." --status in_progress --toon
trekoon task update --ids id1,id2 --append "..." --status in_progress --toon

trekoon epic update --all --append "..." --status in_progress --toon
trekoon epic update --ids id1,id2 --append "..." --status in_progress --toon
```

Rules:
- `--all` and `--ids` are mutually exclusive.
- In bulk mode, do not pass a positional ID.
- Bulk update supports `--append` and/or `--status`.

## 7) Scoped search/replace recipes for agents

Use scoped search/replace instead of repeated `show` scans when you need to
locate or migrate repeated text inside one issue tree.

```bash
trekoon epic search <epic-id> "path/to/somewhere" --toon
trekoon task search <task-id> "path/to/somewhere" --toon
trekoon subtask search <subtask-id> "path/to/somewhere" --toon

trekoon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --toon
trekoon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply --toon
```

Guardrails:

- Use `search` first when you only need to confirm whether the text exists.
- Use preview `replace` next to confirm the exact candidate set.
- Use `--apply` only after preview matches the intended scope.
- Prefer the narrowest root that satisfies the task: `subtask` → `task` →
  `epic`.
- Keep prompts deterministic: literal search text, explicit IDs, no regex
  assumptions.

Agent contract for epic-scoped replace:

- Exact search command:
  `trekoon epic search <epic-id> "path/to/somewhere" --toon`
- Exact replace command:
  `trekoon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --toon`
- Apply command:
  `trekoon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply --toon`
- Epic scope includes the epic title/description plus every task and subtask
  title/description in that epic tree.

Compact TOON fields to expect:

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

Background behavior to assume:

- Scope traversal is deterministic: epic first, then descendant tasks, then
  descendant subtasks.
- Field traversal is deterministic: `title` before `description`.
- Preview reads and summarizes candidates without mutation.
- `--apply` reuses the same scoped traversal, mutates only rows with real text
  changes, and returns matched rows with `query.mode` and `summary.mode` set
  to `"apply"`.

## 8) Setup/install/init (if `trekoon` is unavailable)

1. Install Trekoon (or make sure it is on `PATH`).
2. In the target repository/worktree, initialize tracker state:

```bash
trekoon init --toon
```

3. You can always run `trekoon quickstart --toon` or `trekoon --help --toon` to
   get more information.

If `.trekoon/trekoon.db` is missing, initialize before any create/update commands.

## 9) Safety

- Never edit `.trekoon/trekoon.db` directly.
- `trekoon wipe --yes --toon` is prohibited unless the user explicitly confirms they want a destructive wipe.
