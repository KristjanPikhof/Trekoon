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

## Related docs

- [Quickstart](quickstart.md)
- [Command reference](commands.md)
- [AI agents and the Trekoon skill](ai-agents.md)
