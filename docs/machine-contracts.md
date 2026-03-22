# Machine contracts

Use `--toon` for production agent loops. Use `--json` only when an integration
explicitly requires JSON.

## Base envelope

All machine responses use the same top-level shape:

```text
ok: true|false
command: <stable command id>
data: <payload>
metadata:
  contractVersion: "1.0.0"
  requestId: req-<stable-id>
```

Most subcommand identifiers are dot-namespaced, such as `task.list` or
`sync.pull`. Root-level commands may use single-token IDs such as `help`,
`init`, `quickstart`, `wipe`, or `version`.

Additional metadata may appear when relevant:

- `metadata.compatibility` when `--compat` mode is active
- `meta.storageRootDiagnostics` when storage resolves from a non-canonical cwd

## Ready queue contract

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

Payload fields:

```text
ok: true
command: dep.reverse
data:
  targetId: <id>
  targetKind: task|subtask
  blockedNodes[]: { id, kind, distance, isDirect }
```

## Pagination contract for list calls

```bash
trekoon --toon task list --status todo --limit 2
trekoon --toon task list --status todo --limit 2 --cursor 2
```

Cursor rules:

- `--cursor <n>` is offset-like pagination for `epic list`, `task list`, and
  `subtask list`
- do not combine `--all` with `--cursor`
- machine consumers should page using `meta.pagination.hasMore` and
  `meta.pagination.nextCursor`

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

## Descendant cascade update contract

```bash
trekoon --toon epic update <epic-id> --all --status done
trekoon --toon task update <task-id> --all --status todo
```

Success payload fields for epic/task cascade mode:

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

Failure contract for blocked epic/task cascade mode:

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

- `subtask update <subtask-id> --all --status done|todo` is accepted, but it
  returns the normal single-subtask `subtask.update` payload because there are
  no descendants to traverse
- Cascade mode is reserved for status-only close/reopen operations; combine
  append/title/description changes in separate commands

## Batch create and expand payloads

Trekoon uses stable batch payloads for one-shot graph creation and sibling batch
creation commands.

### `epic create` and `epic expand`

```bash
trekoon --toon epic create --title "..." --description "..." --task "..."
trekoon --toon epic expand <epic-id> --task "..."
```

Payload fields:

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

Payload fields:

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

Payload fields:

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

Compatibility mode exists for integrations that still consume legacy sync
command IDs:

```bash
trekoon --json --compat legacy-sync-command-ids sync status
trekoon --toon --compat legacy-sync-command-ids sync pull --from main
```

Behavior:

- default output uses canonical dotted IDs such as `sync.status`
- compatibility mode rewrites sync command IDs to legacy forms such as
  `sync_status`
- compatibility mode is machine-only and valid only for `sync` commands
- machine output includes `metadata.compatibility` with migration guidance and
  removal timing

## Compact envelope mode

```bash
trekoon --toon --compact task list
```

When `--compact` is passed, the `metadata` key is omitted from the TOON/JSON
envelope. The `ok`, `command`, `data`, `error`, and `meta` keys are unaffected.

## Status transition error contract

Invalid status transitions return:

```text
ok: false
error:
  code: status_transition_invalid
  message: "cannot transition <kind> <id> from '<from>' to '<to>'"
  details:
    entity: epic|task|subtask
    id: <entity-id>
    fromStatus: <current-status>
    toStatus: <attempted-status>
    allowedTransitions[]: <valid targets from current status>
```

## Epic progress contract

```bash
trekoon --toon epic progress <epic-id>
```

Payload fields:

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

## Task done enhanced contract

```bash
trekoon --toon task done <task-id>
```

Payload fields:

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

## Suggest command contract

```bash
trekoon --toon suggest [--epic <epic-id>]
```

Payload fields:

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

## Owner field in update payloads

Task and subtask update payloads now include `owner` in their event data:

```text
data:
  task | subtask:
    ...existing fields...
    owner: <string> | null
```

The board API accepts `owner` on `PATCH /api/tasks/{id}` and
`PATCH /api/subtasks/{id}`.

## Related docs

- [Quickstart](quickstart.md)
- [Command reference](commands.md)
- [AI agents and the Trekoon skill](ai-agents.md)
