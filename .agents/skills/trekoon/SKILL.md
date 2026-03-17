---
name: trekoon
description: Use Trekoon to create issues/tasks, plan backlog and sprints, create epics, update status, track progress, and manage dependencies/sync across repository workflows.
---

# Trekoon Skill

Trekoon is a local-first issue tracker for epics, tasks, and subtasks.

This skill is the agent operating guide, not the full CLI reference. Use it to
pick the right command with the fewest reads and mutations.

## Non-negotiable defaults

- Always include `--toon` on every Trekoon command.
- Prefer the smallest sufficient scope.
- Prefer transactional bulk commands over many single-item commands.
- Prefer `--append` for progress notes, completion notes, and blocker notes.
- Preview replace before `--apply`.
- Prefer `--ids` over `--all` for bulk updates.
- Never edit `.trekoon/trekoon.db` directly.
- Treat `.trekoon` as shared repo-scoped operational state in git worktrees.
- Keep `.trekoon` gitignored; do not commit the SQLite DB as a recovery fix.
- Never run `trekoon wipe --yes --toon` unless the user explicitly asks for it.

## Default agent loop

The primary loop is: **session → work → task done → repeat**.

### 1. Orient with a single call

```bash
trekoon --toon session
```

`session` replaces the old five-call bootstrap sequence
(init + sync status + task next + dep list + task show) with a single DB open.
It returns diagnostics, sync status, the full next-task tree with subtasks, blocker
list, and readiness counts in one envelope.

Fail fast if the envelope reports `recoveryRequired`, a storage mismatch, or any
bootstrap error. In linked worktrees, `sharedStorageRoot` may differ from
`worktreeRoot`; that is expected because the repo shares one DB across checkouts.

If the session envelope shows `behind > 0`, pull before claiming any task:

```bash
trekoon --toon sync pull --from main
```

This syncs tracker events (not git commits) from the source branch so task
states, dependencies, and subtrees are up to date before you start work.

### 2. Claim work explicitly

```bash
trekoon --toon task update <task-id> --status in_progress
```

### 3. Finish or report a block

```bash
trekoon --toon task done <task-id>
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

`task done` replaces the old three-call transition sequence
(mark done + get next + load deps + show task) with a single call that marks the
task done and returns the next ready candidate with its full tree and blockers.

Append a completion note before calling `task done` when useful:

```bash
trekoon --toon task update <task-id> --append "Completed implementation and checks"
trekoon --toon task done <task-id>
```

### 4. Repeat

Run `session` again at the start of each new session. After `task done`, the
returned next-task envelope is sufficient to continue; a fresh `session` call is
not required mid-loop unless you need updated diagnostics or sync status.

Recommended statuses for consistent workflows: `todo`, `in_progress`, `done`.

## Read policy: use the smallest sufficient read

Use the narrowest command that answers the question.

| Need | Preferred command |
|---|---|
| Session startup (diagnostics + sync + next task) | `trekoon --toon session` |
| Next task only | `trekoon --toon task next` |
| A few ready options | `trekoon --toon task ready --limit 5` |
| Direct blockers for one task | `trekoon --toon dep list <task-id>` |
| What this item unblocks | `trekoon --toon dep reverse <task-or-subtask-id>` |
| One full task payload | `trekoon --toon task show <task-id> --all` |
| One full epic tree | `trekoon --toon epic show <epic-id> --all` |
| Repeated text in one scope | `trekoon --toon epic|task|subtask search ...` |

Avoid broad scans such as `task list --all` or `epic show --all` when
`task next`, `task ready`, `dep list`, `dep reverse`, or `search` can answer the
question more cheaply.

## Creation policy: prefer bulk planning workflows

When creating multiple related records, do not loop through repeated single-item
creates unless only one record is needed.

### Which command to use

| Situation | Preferred command |
|---|---|
| New epic and full graph already known | `trekoon --toon epic create ... --task ... --subtask ... --dep ...` |
| Existing epic needs linked additions | `trekoon --toon epic expand <epic-id> ...` |
| Multiple sibling tasks under one epic | `trekoon --toon task create-many --epic <epic-id> --task ...` |
| Multiple sibling subtasks under one task | `trekoon --toon subtask create-many <task-id> --subtask ...` |
| Multiple dependency edges across existing IDs | `trekoon --toon dep add-many --dep ...` |
| One record only | `epic create`, `task create`, or `subtask create` |

### Compact spec escaping rules

Compact specs (pipe-delimited `--task`, `--subtask`, `--dep` values) use `\` as
the escape character. Only these sequences are valid:

| Sequence | Produces |
|---|---|
| `\|` | literal `|` (not a field separator) |
| `\\` | literal `\` |
| `\n` | newline |
| `\r` | carriage return |
| `\t` | tab |

Any other `\X` combination (e.g., `\!`, `\=`, `\$`) is rejected with
`Invalid escape sequence`. To avoid accidental escapes:

- Do not use `!=` or similar operators in description text; rephrase instead
  (e.g., "null does not equal sourceBranch" instead of "null !== sourceBranch").
- If a literal backslash is needed, double it: `\\`.
- When using shell line continuations (`\` at end of line), ensure the next
  line's first character is not one that forms an invalid escape with `\`.

### Critical temp-key rule

- Use plain temp keys when declaring records in compact specs, for example
  `task-api` or `sub-tests`.
- Refer to those records later in the same invocation as `@task-api` or
  `@sub-tests`.
- `@temp-key` references work in same-invocation graph workflows such as
  one-shot `epic create` and `epic expand`.
- `dep add-many` does **not** resolve temp keys from earlier commands. Use real
  persisted IDs there.

### Compact examples

#### One-shot epic creation

Use this when the epic does not exist yet and you already know the tree.

```bash
trekoon --toon epic create \
  --title "Batch command rollout" \
  --description "Ship linked planning in one transaction" \
  --task "task-api|Design API|Define compact grammar|todo" \
  --task "task-cli|Wire CLI|Hook parser and output|todo" \
  --subtask "@task-api|sub-tests|Write tests|Cover parser cases|todo" \
  --dep "@task-cli|@task-api"
```

#### Expand an existing epic

Use this when the epic already exists and the new batch needs internal links.

```bash
trekoon --toon epic expand <epic-id> \
  --task "task-docs|Document workflow|Write operator guide|todo" \
  --subtask "@task-docs|sub-examples|Add examples|Show canonical flows|todo" \
  --dep "@sub-examples|@task-docs"
```

#### Create sibling tasks or subtasks

```bash
trekoon --toon task create-many --epic <epic-id> \
  --task "seed-api|Design API|Define grammar|todo" \
  --task "seed-cli|Wire CLI|Hook output|todo"

trekoon --toon subtask create-many <task-id> \
  --subtask "seed-tests|Write tests|Cover happy path|todo" \
  --subtask "seed-docs|Document flow|Add notes|todo"
```

#### Add dependencies after records already exist

```bash
trekoon --toon dep add-many \
  --dep "<task-b>|<task-a>" \
  --dep "<subtask-c>|<task-b>"
```

## Update policy: prefer append-based progress logging

Use descriptions as the durable work log. For progress updates, append instead
of rewriting full descriptions.

### Preferred patterns

```bash
trekoon --toon task update <task-id> --append "Started implementation" --status in_progress
trekoon --toon task update <task-id> --append "Completed implementation and checks" --status done
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

### Bulk update rules

- Bulk update is available for `epic update`, `task update`, and
  `subtask update`.
- Bulk mode uses `--ids <csv>` or `--all`.
- Bulk mode supports only `--append` and/or `--status`.
- Do not pass a positional ID in bulk mode.
- `--append` and `--description` are mutually exclusive.
- Prefer `--ids` for narrow, explicit updates.
- Use `--all` only for clear maintenance sweeps or when the user explicitly wants
  a broad update.

Examples:

```bash
trekoon --toon task update --ids id1,id2 --append "Waiting on release" --status blocked
trekoon --toon epic update --ids epic1,epic2 --append "Sprint planning refreshed" --status in_progress
```

## Search and replace policy

Use scoped search before manual tree reads when you need to locate repeated
paths, labels, owners, or migration targets.

### Scope choice

Prefer the narrowest valid root:

1. `subtask search` or `subtask replace`
2. `task search` or `task replace`
3. `epic search` or `epic replace`

Scope behavior:

- `subtask` scope scans only that subtask.
- `task` scope scans the task plus descendant subtasks.
- `epic` scope scans the epic plus descendant tasks and subtasks.

### Safe replace workflow

1. Search first.
2. Preview replace.
3. Apply only after preview matches the intended scope.

```bash
trekoon --toon epic search <epic-id> "path/to/somewhere"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply
```

Guardrails:

- Use literal, explicit search text.
- Narrow fields when useful: `--fields title`, `--fields description`, or
  `--fields title,description`.
- Do not jump straight to `--apply`.
- Prefer scoped search/replace over manually reading a whole tree and editing
  many records one by one.

## Setup and fallback

If Trekoon is unavailable or storage diagnostics require repair:

```bash
trekoon --toon init
trekoon --toon sync status
trekoon --toon quickstart
trekoon --toon help sync
```

Rules:

- Re-bootstrap first, then re-read diagnostics.
- Stop if `recoveryRequired` stays true or diagnostics report storage mismatch.
- Do not continue with task selection after missing shared storage or broken
  bootstrap.
- Do not commit `.trekoon/trekoon.db`; remove the tracked DB and keep
  `.trekoon` ignored instead.

Use `quickstart` for the canonical execution loop. Use help when you need exact
syntax.

## Sync reminders

Same-branch sync is a no-op: `sync pull --from main` while on `main` produces
zero conflicts and simply advances the cursor. `sync status` returns `behind=0`
on the source branch. No action is needed.

Cross-branch sync matters before merging a feature branch back:

- Before merge, pull tracker events from the base branch:

  ```bash
  trekoon --toon sync pull --from main
  ```

- If conflicts exist, inspect and resolve them explicitly:

  ```bash
  trekoon --toon sync conflicts list
  trekoon --toon sync conflicts show <conflict-id>
  trekoon --toon sync resolve <conflict-id> --use ours
  ```

## Worktree diagnostics and destructive scope

- Inspect machine-readable storage fields when debugging worktrees:
  `storageMode`, `repoCommonDir`, `worktreeRoot`, `sharedStorageRoot`, and
  `databaseFile`.
- `sharedStorageRoot` is the repo-scoped source of truth for `.trekoon` in git
  worktrees.
- If `trekoon wipe --yes --toon` is explicitly requested, warn that it deletes
  shared storage for the entire repository and every linked worktree.
- Wipe is destructive recovery only; it is never the right fix for a tracked DB
  or gitignore mistake.

Trekoon stores local state in `.trekoon/trekoon.db`. In git repos and
worktrees, storage resolves from the shared repository root rather than each
worktree independently.
