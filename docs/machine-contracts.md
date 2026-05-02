# Machine contracts

Use `--toon` for agent loops. Use `--json` only when an integration explicitly
requires JSON.

## Base envelope

Every machine response uses the same top-level shape:

```text
ok: true|false
command: <stable command id>
data: <payload>
metadata:
  contractVersion: "1.0.0"
  requestId: req-<stable-id>
```

Most subcommand IDs are dot-namespaced (`task.list`, `sync.pull`). Root-level
commands use single tokens (`help`, `init`, `quickstart`, `wipe`, `version`).

Additional metadata appears when relevant:

- `metadata.compatibility` when `--compat` mode is active
- `meta.storageRootDiagnostics` when storage resolves from a non-canonical cwd

## Ready queue

```bash
trekoon --toon task ready --limit 3
```

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
  summary:
    totalOpenTasks
    readyCount
    returnedCount
    appliedLimit
    blockedCount
    unresolvedDependencyCount
```

## Reverse dependency walk

```bash
trekoon --toon dep reverse <task-or-subtask-id>
```

```text
ok: true
command: dep.reverse
data:
  targetId: <id>
  targetKind: task|subtask
  blockedNodes[]: { id, kind, distance, isDirect }
```

## Pagination

```bash
trekoon --toon task list --status todo --limit 2
trekoon --toon task list --status todo --limit 2 --cursor 2
```

Rules:

- `--cursor <n>` is offset-like pagination for `epic list`, `task list`, and
  `subtask list`
- Don't combine `--all` with `--cursor`
- Page using `meta.pagination.hasMore` and `meta.pagination.nextCursor`

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

## Descendant cascade update

```bash
trekoon --toon epic update <epic-id> --all --status done
trekoon --toon task update <task-id> --all --status todo
```

Success:

```text
ok: true
command: epic.update | task.update
data:
  epic | task: { ...updated root row... }
  cascade:
    mode: descendants
    root: { kind: epic|task, id: <root-id> }
    targetStatus: done|todo
    atomic: true
    changedIds[]
    unchangedIds[]
    counts:
      scope
      changed
      unchanged
      blockers
      changedEpics
      changedTasks
      changedSubtasks
```

Failure (blocked descendants):

```text
ok: false
error:
  code: dependency_blocked
data:
  entity: epic|task
  id: <root-id>
  status: done|todo
  atomic: true
  changedIds[]
  unchangedIds[]
  blockerCount
  blockedNodeIds[]
  unresolvedDependencyIds[]
  blockers[]:
    sourceId
    sourceKind
    dependsOnId
    dependsOnKind
    dependsOnStatus
    inScope
    willCascade
```

Notes:

- `subtask update <subtask-id> --all --status done|todo` is accepted but
  returns the normal single-subtask payload (no descendants to traverse)
- Cascade is status-only; use separate commands for append/title/description

## Batch create and expand

Stable batch payloads for one-shot graph creation and sibling batch commands.

### `epic create` and `epic expand`

```bash
trekoon --toon epic create --title "..." --description "..." --task "..."
trekoon --toon epic expand <epic-id> --task "..."
```

```text
ok: true
command: epic.create | epic.expand
data:
  epic: { ... }                    # epic.create only
  epicId: <epic-id>                # epic.expand only
  tasks[]
  subtasks[]
  dependencies[]
  result:
    mappings[]: { kind, tempKey, id }
    counts: { tasks, subtasks, dependencies }
```

### `task create-many`

```bash
trekoon --toon task create-many --epic <epic-id> --task "..."
```

```text
ok: true
command: task.create-many
data:
  epicId: <epic-id>
  tasks[]
  result:
    mappings[]: { kind: task, tempKey, id }
```

### `subtask create-many`

```bash
trekoon --toon subtask create-many --task <task-id> --subtask "..."
```

```text
ok: true
command: subtask.create-many
data:
  taskId: <task-id>
  subtasks[]
  result:
    mappings[]: { kind: subtask, tempKey, id }
```

## Sync compatibility mode

For integrations that still use legacy sync command IDs:

```bash
trekoon --json --compat legacy-sync-command-ids sync status
trekoon --toon --compat legacy-sync-command-ids sync pull --from main
```

- Default output uses canonical dotted IDs (`sync.status`)
- Compat mode rewrites to legacy forms (`sync_status`)
- Machine-only, valid only for `sync` commands
- Output includes `metadata.compatibility` with migration guidance and removal
  timing

## Compact envelope

```bash
trekoon --toon --compact task list
```

`--compact` omits the `metadata` key from the envelope. `ok`, `command`, `data`,
`error`, and `meta` are unaffected.

## Status transition errors

Invalid transitions return:

```text
ok: false
error:
  code: status_transition_invalid
  message: "cannot transition <kind> <id> from '<from>' to '<to>'"
data:
  entity: epic|task|subtask
  id: <entity-id>
  fromStatus: <current-status>
  toStatus: <attempted-status>
  allowedTransitions[]: <valid targets from current status>
```

Transition details are in `data`, not `error.details`. `error` only has `code`
and `message`.

**Allowed bypass:** `task done` performs an atomic single-transaction direct
write to `done` from any non-`done` status (`todo`, `blocked`, `in_progress`),
emitting one `task.updated` event — there is no intermediate `in_progress`
event when starting from `todo`/`blocked`. This is the only sanctioned
bypass of the status-machine checker.

## Epic progress

```bash
trekoon --toon epic progress <epic-id>
```

```text
ok: true
command: epic.progress
data:
  epicId: <epic-id>
  title: <epic-title>
  total
  doneCount
  inProgressCount
  blockedCount
  todoCount
  readyCount
  nextCandidate: { id, title } | null
```

## Task done (enhanced)

```bash
trekoon --toon task done <task-id>
```

```text
ok: true
command: task.done
data:
  completed: { ...task record... }
  openSubtaskCount
  openSubtaskIds[]
  warning: "Warning: N subtask(s) still open." | null
  unblocked[]:
    id
    kind: task
    title
    status
    wasBlockedBy[]
  next: { ...task tree... } | null
  nextDeps[]
  readiness:
    readyCount
    blockedCount
```

## Suggest

```bash
trekoon --toon suggest [--epic <epic-id>]
```

```text
ok: true
command: suggest
data:
  suggestions[]:
    priority
    action
    command
    reason
    category: recovery|sync|execution|planning
  context:
    totalEpics
    activeEpic: <epic-id> | null
    readyTasks
    blockedTasks
    inProgressTasks
    syncBehind
    pendingConflicts
```

## Task claim

```bash
trekoon --toon task claim <task-id> --owner <owner>
trekoon --toon subtask claim <subtask-id> --owner <owner>
```

Atomically claims a task or subtask using SQL compare-and-swap. The single
UPDATE predicate ensures exactly one concurrent caller gets `claimed: true`.

Success (claimed):

```text
ok: true
command: task.claim | subtask.claim
data:
  claimed: true
  currentOwner: <owner>
  currentStatus: in_progress
  task | subtask: { ...full record... }
```

Not claimed (another owner holds it, or status is done/in_progress by others):

```text
ok: true
command: task.claim | subtask.claim
data:
  claimed: false
  currentOwner: <string> | null
  currentStatus: in_progress | done | todo | blocked
```

Note: `claimed: false` is a successful response (`ok: true`). The command
reports the current state, not an error condition. Check `data.claimed` to
distinguish the two cases.

Dependency gating on claim (cr-expert hardening): when the task or subtask is
in `blocked` or `todo` and has unresolved dependencies, the claim atomically
fails with `code: dependency_blocked` rather than flipping the row into
`in_progress`. This mirrors `task done` semantics so neither
forward-progress transition (`todo|blocked → in_progress` via claim,
`* → done` via `task done`) can bypass dependency resolution.

```text
ok: false
command: task.claim | subtask.claim
error:
  code: dependency_blocked
  message: "task cannot transition to in_progress while dependencies are unresolved"
data:
  unresolvedDependencyCount: <number>
  unresolvedDependencyIds: [<id>, ...]
  unresolvedDependencies: [{ id, kind, status }, ...]
```

The only intentional direct-status-write exception in the codebase remains
`MutationService.markTaskDoneAtomically`, which bypasses
`validateStatusTransition` for the `* → done` flip but still goes through
`assertNoUnresolvedDependenciesForStatusTransition` before issuing the UPDATE.
No other call site is permitted to write `status` directly without going
through the public transition checker.

## Owner field in updates

Task and subtask update payloads include `owner`:

```text
data:
  task | subtask:
    ...existing fields...
    owner: <string> | null
```

The board API accepts `owner` on `PATCH /api/tasks/{id}` and
`PATCH /api/subtasks/{id}`.

## Sync resolve dry-run

```bash
trekoon --toon sync resolve <conflict-id> --use ours|theirs --dry-run
```

```text
ok: true
command: sync.resolve
data:
  conflictId: <conflict-id>
  resolution: ours|theirs
  entityKind: epic|task|subtask
  entityId: <entity-id>
  fieldName: <conflicted field>
  oursValue: <current DB value>
  theirsValue: <source branch value>
  wouldWrite: <value that would be written>
  dryRun: true
```

No mutation occurs. The conflict stays pending.

## Sync batch resolve

```bash
trekoon --toon sync resolve --all --use ours|theirs [--entity <id>] [--field <name>]
```

```text
ok: true
command: sync.resolve
data:
  resolution: ours|theirs
  resolvedCount: <number>
  resolvedIds: [<conflict-id>, ...]
  filters:
    entity: <entity-id> | null
    field: <field-name> | null
```

Human-mode note: `sync resolve --all --use theirs` asks for confirmation before
execution. Cancellation returns `error.code: cancelled` with the requested
`resolution`, `cancelled: true`, and the normalized `filters`.

When confirmation is required, execution is bound to the previewed conflict ID
set. If another process resolves one of those conflicts before the confirmed
write happens, the command fails with `error.code: conflict_set_changed`
instead of partially resolving a drifted batch.

## Sync batch resolve dry-run

```bash
trekoon --toon sync resolve --all --use ours|theirs [--entity <id>] [--field <name>] --dry-run
```

```text
ok: true
command: sync.resolve
data:
  resolution: ours|theirs
  matchedCount: <number>
  matchedIds: [<conflict-id>, ...]
  filters:
    entity: <entity-id> | null
    field: <field-name> | null
  dryRun: true
```

No mutation occurs. Returns `no_matching_conflicts` error when no pending
conflicts match the filters.

## Sync resolve hardening errors

Recent `sync.resolve` hardening added explicit machine-visible failure modes for
race conditions and invalid persisted conflict targets.

### Single resolve — cancelled

Returned in human mode when the user rejects or times out a confirmation prompt.
Single-conflict prompts only appear for `--use theirs`.

```text
ok: false
command: sync.resolve
data:
  conflictId: <conflict-id>
  resolution: ours|theirs
  cancelled: true
error:
  code: cancelled
  message: "Resolution cancelled by user."
```

### Batch resolve — cancelled

Returned in human mode when the user rejects or times out the batch prompt.

```text
ok: false
command: sync.resolve
data:
  resolution: ours|theirs
  cancelled: true
  filters:
    entity: <entity-id> | null
    field: <field-name> | null
error:
  code: cancelled
  message: "Batch resolution cancelled by user."
```

### Single resolve — already_resolved

Returned when a conflict is still pending at preview time but another process
resolves it before the confirmed write happens.

```text
ok: false
command: sync.resolve
data:
  conflictId: <conflict-id>
  resolution: ours|theirs
  reason: already_resolved
error:
  code: already_resolved
  message: "Conflict '<conflict-id>' already resolved."
```

### Resolve write hardening errors

These surface as domain failures when persisted conflict metadata no longer maps
to a valid writable target.

```text
ok: false
command: sync.resolve
data:
  reason: unsupported_entity_kind | disallowed_field | row_not_found
  ...details
error:
  code: unsupported_entity_kind | disallowed_field | row_not_found
  message: <stable human-readable message>
```

Per-code details:

- `unsupported_entity_kind`
  - `data.entityKind`
- `disallowed_field`
  - `data.tableName`
  - `data.fieldName`
- `row_not_found`
  - `data.tableName`
  - `data.entityKind`
  - `data.entityId`

## Sync batch resolve — no_matching_conflicts error

Applies to both the execute and dry-run variants of `sync resolve --all`.
Returned when the given filters match zero pending conflicts.

```text
ok: false
command: sync.resolve
data:
  filters:
    entity: <entity-id> | null
    field: <field-name> | null
  reason: no_matching_conflicts
error:
  code: no_matching_conflicts
  message: "No pending conflicts match the given filters."
```

## Sync batch resolve — conflict_set_changed error

Returned in human mode when batch confirmation was based on one pending conflict
set but one or more of those conflicts were resolved before the confirmed write
was applied.

```text
ok: false
command: sync.resolve
data:
  filters:
    entity: <entity-id> | null
    field: <field-name> | null
  expectedConflictIds: [<conflict-id>, ...]
  availableConflictIds: [<conflict-id>, ...]
  reason: conflict_set_changed
error:
  code: conflict_set_changed
  message: "Pending conflicts changed before batch resolution could be applied."
```

## Error code registry

All machine-visible error codes emitted by Trekoon. Every `error.code` value in
any `ok: false` response will be one of the following strings.

| Code | Description |
|---|---|
| `already_done` | Entity is already in `done` status; transition is a no-op. |
| `already_resolved` | Conflict was resolved by another process before this write. |
| `ambiguous_legacy_state` | Legacy worktree state is ambiguous and cannot be automatically resolved. |
| `backpressure` | SSE snapshot stream disconnected a slow client whose queued bytes exceeded the hard limit. |
| `backup_already_exists` | A backup file already exists at the target path; overwrite was not requested. |
| `backup_database_missing` | Source database file not found when attempting to create a backup. |
| `backup_failed` | Backup operation failed (I/O or copy error). |
| `cancelled` | Operation was cancelled by the user (e.g. confirmation prompt rejected). |
| `confirmation_required` | Human-mode operation requires explicit confirmation before proceeding. |
| `conflict_set_changed` | Batch conflict set changed between preview and confirmed write. |
| `daemon_start_failed` | Daemon failed to start (socket bind error or already running). |
| `database_busy` | SQLite database is locked; retry after a short wait. |
| `dependency_blocked` | Cascade update blocked because one or more descendants have unresolved dependencies. |
| `disallowed_field` | Sync resolve attempted to write a field that is not on the allow-list. |
| `events_failed` | Event log query or export failed. |
| `install_failed` | Skill installation failed (file copy or permission error). |
| `internal_error` | Unexpected internal error; inspect server logs for details. |
| `invalid_args` | Required positional arguments are missing or malformed. |
| `invalid_dependency` | Dependency edge is invalid (self-loop, wrong entity type, or duplicate). |
| `invalid_input` | One or more option values failed validation. |
| `invalid_path` | File path is invalid for the requested operation (e.g. path is a directory). |
| `invalid_source` | Source entity for a dependency or sync operation does not exist or is of wrong kind. |
| `invalid_state` | Entity or system is in a state that does not permit the requested operation. |
| `invalid_subcommand` | Unrecognised subcommand for this command group. |
| `legacy_import_failed` | Import from a legacy (pre-`.trekoon`) data directory failed. |
| `migrate_failed` | Database schema migration failed. |
| `migration_down_unsupported` | Down-migrations are not supported; only forward migrations are allowed. |
| `missing_asset` | Expected bundled asset (skill file, template) was not found. |
| `no_matching_conflicts` | `sync resolve --all` filters matched zero pending conflicts. |
| `not_found` | Requested entity (epic, task, subtask, dependency) does not exist. |
| `orphaned_external_node` | Dependency graph contains a node that belongs to a different epic. |
| `outside_repo_target` | Skill install target path is outside the repository root. |
| `permission_denied` | File-system permission denied for the requested path. |
| `precondition_failed` | `If-Match` precondition header did not match the entity's current `updatedAt`. |
| `row_not_found` | Sync resolve target row no longer exists in the database. |
| `status_transition_invalid` | Requested status transition is not permitted by the status machine. |
| `stream_unavailable` | SSE snapshot stream is not available (board not initialised or shutting down). |
| `sync_failed` | Sync pull or push operation failed. |
| `tracked_ignored_mismatch` | Worktree is tracked by Trekoon but its path is in `.gitignore`, or vice-versa. |
| `unauthorized` | Request lacks valid authentication credentials. |
| `unhandled_command` | Command matched a known group but no case handled the subcommand. |
| `unknown_command` | Top-level command token is not recognised. |
| `unknown_option` | An option flag passed to the command is not recognised. |
| `unsupported_entity_kind` | Sync resolve encountered an entity kind that the writer does not handle. |
| `update_failed` | Skill update failed (download, copy, or permission error). |
| `wrong_entity_type` | Operation requires a specific entity kind but a different kind was supplied. |

## Related docs

- [Quickstart](quickstart.md)
- [Command reference](commands.md)
- [AI agents and the Trekoon skill](ai-agents.md)
