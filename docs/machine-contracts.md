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

## Related docs

- [Quickstart](quickstart.md)
- [Command reference](commands.md)
- [AI agents and the Trekoon skill](ai-agents.md)
