---
name: trekoon
description: Use Trekoon to create issues/tasks, plan backlog and sprints, create epics, update status, track progress, and manage dependencies/sync across repository workflows.
---

# Trekoon Skill

Trekoon is a local-first issue tracker for epics, tasks, and subtasks.

This skill is the agent operating guide, not the full CLI reference. Use it to
pick the right command with the fewest reads and mutations.

## Skill arguments

When invoked with arguments (e.g., `/trekoon <id> [user text]`), resolve the
argument as a Trekoon entity ID and choose the action based on user intent:

### 1. Resolve the entity

```bash
trekoon --toon epic show <id> 2>/dev/null || \
trekoon --toon task show <id> 2>/dev/null || \
trekoon --toon subtask show <id> 2>/dev/null
```

If none match, tell the user the ID was not found.

### 2. Choose the action

Interpret the user's accompanying text (or lack thereof) to decide what to do:

| User intent signal | Action |
|---|---|
| No text, just an ID | Orient: run `session --epic <epic-id>` (or show the task/subtask) and summarize status, readiness, and next steps |
| "analyze", "review", "check", "status", "progress" | **Analyze:** run `epic progress <id>` or `task show <id> --all`, then `suggest --epic <id>`, and report findings |
| "execute", "implement", "do", "complete", "start", "run" | **Execute:** read `reference/execution.md`, scope session to the entity's epic, and begin the execution loop |
| "plan", "break down", "design", "architect" | **Plan:** read `reference/planning.md` and create or expand the epic graph |

### Examples

```
/trekoon abc-123
  → shows epic/task/subtask abc-123, summarizes status and next candidate

/trekoon abc-123 analyze this epic
  → runs epic progress, suggest, reports readiness and blockers

/trekoon abc-123 execute
  → reads execution reference, starts session --epic, begins work loop

/trekoon abc-123 plan the implementation
  → reads planning reference, decomposes into tasks/subtasks/deps
```

When the entity is a **task or subtask**, resolve its parent epic ID from the
entity record and scope session/suggest/progress calls to that epic.

## Reference guides

This skill ships with bundled reference guides for planning and execution. Read
them when the task calls for it — they extend this command reference with
methodology and orchestration patterns.

| When | Read | What it covers |
|---|---|---|
| User asks to plan, design, or architect a feature | `reference/planning.md` | Decomposition into epic/task/subtask DAGs, writing standard, file scopes, owner assignment, dependency modeling, validation |
| User asks to execute, implement, or complete an epic | `reference/execution.md` | Execution graph building, lane grouping, sub-agent dispatch, task done orchestration, verification, cleanup |
| User asks to execute task with Agent Team (or just team) AND Agent Teams are available (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true`) | `reference/execution-with-team.md` | TeamCreate/SendMessage pattern, teammate spawning, team coordination, shutdown |

**Typical flow:**
1. Read `reference/planning.md` and create the epic with tasks, subtasks, deps,
   owners.
2. Read `reference/execution.md` (or `reference/execution-with-team.md` for Agent
   Teams), run `session --epic`, build lane groups, dispatch agents, use
   `task done` responses to orchestrate waves.
3. This file (SKILL.md) provides the command reference and status machine rules
   that both planning and execution rely on.

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

## Status machine

Trekoon enforces a status transition graph. Only these transitions are valid:

| From | Allowed targets |
|---|---|
| `todo` | `in_progress`, `blocked` |
| `in_progress` | `done`, `blocked` |
| `blocked` | `in_progress`, `todo` |
| `done` | `in_progress` |

Invalid transitions (e.g. `todo → done`) return error code
`status_transition_invalid`. Always transition through `in_progress` to reach
`done`.

**Exception:** `task done` auto-transitions through `in_progress` when the task
is in `todo` or `blocked` status, so you can call `task done` from any
non-done status.

Recommended statuses for consistent workflows: `todo`, `in_progress`, `done`.
Use `blocked` with an appended reason when work is stuck.

## Epic lifecycle

The orchestrator is responsible for managing the epic's status throughout
execution. Epics follow the same status machine as tasks — they must transition
through `in_progress` to reach `done`.

### Start: mark epic `in_progress`

Immediately after session bootstrap and before dispatching any work, transition
the epic:

```bash
trekoon --toon epic update <epic-id> --status in_progress
```

This ensures the epic reflects actual state even if execution is interrupted.

### Finish: mark epic `done`

After all tasks are verified done (see cleanup in execution references), mark
the epic complete:

```bash
trekoon --toon epic update <epic-id> --status done
```

Since the epic is already `in_progress` from the start step, this is a single
valid transition.

## Default agent loop

The primary loop is: **session → claim → work → task done → repeat**.

### 1. Orient with a single call

```bash
trekoon --toon session
```

If you already know which epic you are working on, scope the session:

```bash
trekoon --toon session --epic <epic-id>
```

`session` returns diagnostics, sync status, the next ready task with subtrees,
blocker list, and readiness counts in one envelope. Use `--compact` to reduce
output size when you do not need contract metadata:

```bash
trekoon --toon --compact session
```

**After session returns, follow this decision tree in order:**

1. **`recoveryRequired` is true?** → Stop. Run `trekoon --toon init` and
   re-check.
2. **`behind > 0`?** → Sync first: `trekoon --toon sync pull --from main`.
   This pulls tracker events (not git commits) so task states are current.
3. **`pendingConflicts > 0`?** → Resolve before claiming work:
   `trekoon --toon sync conflicts list`.
4. **Session returned a next task?** → Proceed to step 2 (claim work).
5. **No next task and unsure what to do?** → Run `trekoon --toon suggest` for
   priority-ranked recommendations (see step 1b below).

### 1b. Get suggestions when stuck

When the session has no clear next task, or you are unsure what action to take:

```bash
trekoon --toon suggest
trekoon --toon suggest --epic <epic-id>
```

`suggest` inspects recovery state, sync status, readiness, and epic progress,
then returns up to 3 suggestions ranked by priority. Each suggestion includes a
category (`recovery`, `sync`, `execution`, `planning`), a reason, and a
ready-to-run command you can execute directly.

Suggest respects the status machine — it will never recommend an invalid
transition. Use it:
- At session start when `readyCount` is 0 and you need guidance.
- Mid-loop when all tasks are blocked and you need to decide what to unblock.
- Before closing an epic to confirm the right next step.

### 1c. Check epic progress

When you need a quick dashboard before or during work on an epic:

```bash
trekoon --toon epic progress <epic-id>
```

Returns done/in_progress/blocked/todo counts, ready task count, and the next
candidate. Use this:
- Before starting a work session to gauge how much remains.
- After completing several tasks to report progress to the user.
- To decide whether an epic is ready to be marked done.

### 2. Claim work explicitly

Once you know which task to work on, claim it:

```bash
trekoon --toon task update <task-id> --status in_progress
```

Optionally assign ownership when multiple agents or people are working:

```bash
trekoon --toon task update <task-id> --status in_progress --owner <name>
```

Owner is for tracking who is responsible. Set it on tasks or subtasks:

```bash
trekoon --toon task update <task-id> --owner alice
trekoon --toon subtask update <subtask-id> --owner bob
```

### 3. Work on the task

While working, append progress notes:

```bash
trekoon --toon task update <task-id> --append "Started implementation"
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

### 4. Finish or report a block

When done, append a completion note then mark done:

```bash
trekoon --toon task update <task-id> --append "Completed implementation and checks"
trekoon --toon task done <task-id>
```

`task done` works from any non-done status (`todo`, `in_progress`, `blocked`).
It auto-transitions through `in_progress` when needed. The response includes:

- **Next candidate**: the next ready task with its full tree and blockers.
- **Unblocked tasks**: downstream tasks that became ready after this completion.
  Use this to decide what to claim next or to launch parallel work.
- **Open subtask warning**: if subtasks remain incomplete (completion still
  proceeds, but the warning is surfaced so you can decide whether to go back).

If blocked instead of done:

```bash
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

### 5. Repeat

After `task done`, the returned next-task envelope is sufficient to continue
the loop from step 2. A fresh `session` call is not required mid-loop unless
you need updated diagnostics, sync status, or want to switch epics.

Run `session` again at the start of each new conversation session.

**When to use each command during the loop:**

| Situation | Command |
|---|---|
| Start of session | `session` or `session --epic <id>` |
| Unsure what to do next | `suggest` or `suggest --epic <id>` |
| Quick progress check | `epic progress <epic-id>` |
| Claim a task | `task update <id> --status in_progress` |
| Assign ownership | `task update <id> --owner <name>` |
| Log progress | `task update <id> --append "..."` |
| Mark done | `task done <id>` |
| Report blocker | `task update <id> --append "..." --status blocked` |
| Reduce output noise | Add `--compact` to any command |

## Read policy: use the smallest sufficient read

Use the narrowest command that answers the question.

| Need | Preferred command |
|---|---|
| Session startup (diagnostics + sync + next task) | `trekoon --toon session` |
| Session scoped to one epic | `trekoon --toon session --epic <epic-id>` |
| Next-action suggestions | `trekoon --toon suggest` |
| Epic progress dashboard | `trekoon --toon epic progress <epic-id>` |
| Next task only | `trekoon --toon task next` |
| A few ready options | `trekoon --toon task ready --limit 5` |
| Direct blockers for one task | `trekoon --toon dep list <task-id>` |
| What this item unblocks | `trekoon --toon dep reverse <task-or-subtask-id>` |
| One full task payload | `trekoon --toon task show <task-id> --all` |
| One full epic tree | `trekoon --toon epic show <epic-id> --all` |
| Repeated text in one scope | `trekoon --toon epic|task|subtask search ...` |

Avoid broad scans such as `task list --all` or `epic show --all` when
`task next`, `task ready`, `dep list`, `dep reverse`, `suggest`, or `search`
can answer the question more cheaply.

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

Status transitions must follow the status machine (see above). Use `in_progress`
as the intermediate step to reach `done`. Direct `todo → done` is invalid via
`task update`; use `task done` instead, which auto-transitions.

### Preferred patterns

```bash
trekoon --toon task update <task-id> --append "Started implementation" --status in_progress
trekoon --toon task update <task-id> --append "Completed implementation and checks"
trekoon --toon task done <task-id>
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
trekoon --toon task update <task-id> --owner alice
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

## Tool selection

Check your available tool list to determine which harness you are running in.

### Core tools (both harnesses)

| Purpose | Claude Code | OpenCode |
|---------|------------|----------|
| File search | `Glob` | `glob` |
| Content search | `Grep` | `grep` |
| Read files | `Read` | `read` |
| Edit files | `Edit` | `edit` |
| Write files | `Write` | `write` |
| Shell commands | `Bash` | `bash` |
| Ask user | `AskUserQuestion` | `question` |
| Web fetch | `WebFetch` | `webfetch` |
| Web search | `WebSearch` | `websearch` |
| Directory listing | `Bash(ls)` | `list` |

### LSP tools (OpenCode only — use if available)

- `lsp goToDefinition`/`lsp findReferences`: navigate symbols safely.
- `lsp hover`: inspect type signatures.
- `lsp documentSymbol`/`lsp workspaceSymbol`: search symbols.
- `lsp goToImplementation`: find interface implementations.

**Fallbacks:** use `Grep`/`grep` for symbols, `Bash`/`bash` for compiler
diagnostics.

### General guidance

- Do not overuse bash for searching/reading; prefer dedicated tools.
- Use LSP over grep for symbol navigation when available.
- Run Trekoon, git, build/lint/test, and verification commands via `Bash`/`bash`.
- Use `--compact` on Trekoon commands in sub-agent prompts to reduce token usage.
