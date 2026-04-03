---
name: trekoon
description: Use for Trekoon-based planning and execution: creating epics, tasks, and subtasks; breaking work into dependency-aware graphs; checking status and progress; planning backlog or sprint work; and coordinating agent execution from Trekoon. Prefer this whenever the user wants tracked implementation planning or Trekoon entity management, even if they do not explicitly say "Trekoon."
---

# Trekoon Skill

Trekoon is a local-first execution harness for tracked implementation work.
Treat Trekoon as the source of truth for plans, progress, blockers, readiness,
and orchestration state.

This skill is the operating guide, not the full CLI reference. Use it to route
into the right mode quickly, keep momentum, and finish work rather than
stalling in analysis.

## Operating contract

Treat these entrypoints as hard mode contracts:

- `trekoon plan <goal>` → create an **execution-ready epic** in Trekoon.
- `trekoon <epic-id>` → **orient** on the current state and report the next
  concrete action.
- `trekoon <epic-id> execute` → **own the epic until it is done, hard-blocked,
  or requires user input**.
- `trekoon <epic-id> team execute` → same execution contract, but use Agent
  Teams only when the environment supports it and the user explicitly wants it.

Reading `reference/planning.md` or `reference/execution.md` is a required setup
step for those modes, not the end of the workflow.

## Trigger guidance

Use this skill whenever the user wants tracked planning or tracked execution in
Trekoon, for example:

- break a feature into epics, tasks, subtasks, or dependencies
- create backlog or sprint-ready work items
- check epic/task status, progress, readiness, or blockers
- execute a Trekoon epic end to end with sub-agents
- coordinate parallel implementation lanes from tracked work

Do **not** use this skill for generic coding work that is not meant to be
tracked in Trekoon.

## Command router

When invoked with arguments, determine the mode first, then load only the
reference needed for that mode.

## Planning preflight

Before entering plan mode, harvest the context already available in the current
conversation and workspace. Planning should build on prior thinking, not restart
discovery from zero.

Treat these as primary inputs when they exist:

- brainstorm output
- research notes or library findings
- codebase exploration results
- prior user decisions and constraints
- existing Trekoon entities that should be expanded rather than replaced

Compress that context into a short internal planning brief before creating the
epic graph:

- goal and why now
- decisions already made
- constraints and risks already known
- affected systems/files/interfaces
- verification expectations
- unresolved questions that actually block planning

If the remaining unknowns are real blockers, do targeted follow-up research or
ask the user a narrow clarification question. Use the harness's interactive user
question tool for this — `question` in OpenCode or `AskUserQuestion` in Claude
Code — instead of guessing.

### 1. Route by first argument

| Command shape | Mode | Required read | Completion target |
|---|---|---|---|
| `trekoon plan <goal>` | Plan | `reference/planning.md` | Epic exists, graph is validated, next-wave summary is returned |
| `trekoon <epic-id>` | Orient | None beyond this file unless needed | User knows current state, next ready action, and blockers |
| `trekoon <epic-id> execute` | Execute | `reference/execution.md` | Epic is done, all remaining work is blocked, or user input is required |
| `trekoon <epic-id> team execute` | Team execute | `reference/execution-with-team.md` | Same as execute, using Agent Teams |

### 2. Resolve entity IDs when present

If the first argument is not `plan`, resolve it as a Trekoon entity:

```bash
trekoon --toon epic show <id> 2>/dev/null || \
trekoon --toon task show <id> 2>/dev/null || \
trekoon --toon subtask show <id> 2>/dev/null
```

If none match, tell the user the ID was not found.

When the entity is a **task or subtask**, resolve its parent epic ID from the
entity record and scope `session`, `suggest`, and `epic progress` to that epic.
If the user asked to execute a task or subtask, make forward progress on that
requested entity first; continue broader epic execution only if that matches the
user's intent.

### 3. Interpret missing or extra text

| User intent signal | Action |
|---|---|
| No text, just an ID | **Orient:** run `session --epic <epic-id>` (or show the task/subtask), summarize status, readiness, and next action |
| `analyze`, `review`, `check`, `status`, `progress` | **Analyze:** run `epic progress <id>` or `task show <id> --all`, then `suggest --epic <id>`, and report findings |
| `execute`, `implement`, `do`, `complete`, `start`, `run` | **Execute:** read `reference/execution.md`, choose single-agent vs orchestrated execution, and keep going until the mode contract is satisfied |
| `team execute`, `execute with team` | **Team execute:** read `reference/execution-with-team.md` only when Agent Teams are available |
| `plan`, `break down`, `design`, `architect` | **Plan:** read `reference/planning.md` and create or expand the epic graph |

### Examples

```text
trekoon plan build a dependency-aware release workflow
  → reads planning reference, creates a validated epic, returns epic ID + wave summary

trekoon abc-123
  → orients on epic/task/subtask abc-123, summarizes state and next action

trekoon abc-123 execute
  → reads execution reference, starts the execution loop, keeps going until done or blocked

trekoon abc-123 team execute
  → reads team execution reference, starts Agent Teams orchestration if supported
```

## Reference guides

Read references lazily based on mode.

> **Path note:** Script paths below are relative to this skill's folder (where this SKILL.md lives), not the current project root. Resolve them from this skill folder when invoking Bash.

| Mode | Read | Use it for |
|---|---|---|
| Plan | `reference/planning.md` | Converting a goal into a real epic/task/subtask dependency graph with validation and handoff |
| Execute | `reference/execution.md` | Running an epic end to end, choosing lanes, dispatching sub-agents, recording evidence, and closing the epic |
| Team execute | `reference/execution-with-team.md` | Agent Teams coordination via TeamCreate/TaskCreate/SendMessage when the environment supports it |

## Mode completion rules

These stop conditions are the core contract for the skill.

- **Plan mode** is complete only when the epic has been created in Trekoon,
  tasks/subtasks/dependencies exist, validation passes, and the user receives
  the epic ID plus an execution-ready summary.
- **Orient mode** is complete when the user has the current state, ready work,
  blockers, and the most likely next command.
- **Execute mode** is complete only when one of these is true:
  1. the epic is fully completed and marked `done`
  2. all remaining work is blocked and blockers are recorded in Trekoon
  3. a real ambiguity, approval, or external dependency requires user input

## Anti-stall rules

- Do not stop after `session`, `suggest`, or `epic progress` if a clear next
  action exists.
- Do not stop after completing one task if more ready work exists.
- After each `task done`, inspect `unblocked` and `next` to decide the next
  move immediately.
- If multiple independent tasks are ready and isolation is safe, group them by
  lane and delegate.
- Ask the user only when the work is genuinely blocked by ambiguity, approval,
  or missing external access.

## Clarification tool rule

When planning or execution needs user input, use the harness's user-question
tool rather than burying the question inside narration:

- OpenCode: `question`
- Claude Code: `AskUserQuestion`

Ask narrow, decision-shaping questions. Prefer one clear question with concrete
options over a broad list of speculative unknowns.

## Non-negotiable defaults

- Always include `--toon` on every Trekoon command.
- Prefer the smallest sufficient scope.
- Prefer transactional bulk commands over many single-item commands.
- Prefer `--append` for progress notes, completion notes, and blocker notes.
- Preview replace before `--apply`.
- Prefer `--ids` over `--all` for bulk updates.
- Treat Trekoon state updates as part of the workflow, not as after-the-fact
  bookkeeping.
- Never edit `.trekoon/trekoon.db` directly.
- Treat `.trekoon` as shared repo-scoped operational state in git worktrees.
- Keep `.trekoon` gitignored; do not commit the SQLite DB as a recovery fix.
- Never run `trekoon wipe --yes --toon` unless the user explicitly asks for it.
- Create branches, commits, merges, or PRs only when the user explicitly asks
  and the current harness policy allows it.

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

## Execution mode selection

Choose the lightest mode that will still move the work forward.

| Situation | Mode | First move |
|---|---|---|
| One ready task, narrow scope, or user asked to continue personally | Single-agent execution | `session --epic <epic-id>` |
| Multiple ready tasks across separable subsystems or owners | Orchestrated execution | Read `reference/execution.md`, then `task ready --epic <epic-id> --limit 50` |
| User explicitly asked for team execution and Agent Teams are available | Team execution | Read `reference/execution-with-team.md` |

## Delegation policy

Prefer one sub-agent per execution lane, not one sub-agent per tiny task.

- Spawn sub-agents when 2+ ready tasks are independent, touch different
  subsystems, or can be grouped into bounded lanes.
- Keep each lane small enough to verify and report clearly.
- Avoid delegation when the scope is tiny, the tasks are tightly coupled, or the
  overhead exceeds the gain.
- When tasks share the same directory roots, owners, or subsystem context, group
  them into one lane.

## Single-agent execution loop

Use this loop when one agent should continue the work directly. The primary loop
is: **session → claim → work → task done → repeat**.

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
   `trekoon --toon sync conflicts list`. For uniform conflicts, batch resolve:
   `trekoon --toon sync resolve --all --use ours` (or `--use theirs`). For
   mixed conflicts, inspect individually with `sync conflicts show <id>` and
   resolve per-conflict.
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

### 3b. Work on subtasks explicitly when they matter

Use the same status discipline for subtasks when a task depends on concrete
subtask progress:

```bash
trekoon --toon subtask update <subtask-id> --status in_progress
trekoon --toon subtask update <subtask-id> --append "Implemented parser branch"
trekoon --toon subtask update <subtask-id> --append "Verified with fixture set" --status done
trekoon --toon subtask update <subtask-id> --append "Blocked by <reason>" --status blocked
```

Use subtasks for real execution units, not filler. If a task has open subtasks
when `task done` is called, treat the warning as a prompt to consciously decide
whether the task is genuinely complete.

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

Use `session` as the primary entry point — it returns diagnostics, sync status,
and the next ready task in one call. Use `suggest` for priority-ranked
recommendations. Use `quickstart` for the canonical bootstrapping walkthrough
and execution loop reference. Use `help` when you need exact flag syntax for a
specific command.

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
  trekoon --toon sync resolve <conflict-id> --use theirs --dry-run
  trekoon --toon sync resolve <conflict-id> --use ours
  ```

### Conflict resolution: ours vs theirs

Conflicts are **field-level**, not whole-record. Each conflict targets one field
(e.g., `status`, `title`, `description`) on one entity.

- `--use ours` — keep the current entity field value in the shared DB. The
  entity is not written, but the conflict record is marked resolved and a
  resolution event is appended.
- `--use theirs` — overwrite the shared DB entity field with the source-branch
  value. The conflict record is marked resolved and a resolution event is
  appended.
- `--dry-run` — preview the resolution without mutating the database. Returns
  `oursValue`, `theirsValue`, `wouldWrite`, and `dryRun: true`. Use this before
  committing to a resolution.

**Example:** after `sync pull --from main`, a conflict appears on epic `abc123`,
field `status`:
- ours (current DB): `in_progress`
- theirs (source branch): `done`
- `--use ours` keeps status as `in_progress`
- `--use theirs` changes status to `done` in the live shared DB

Always inspect conflicts with `sync conflicts show` before resolving. Choosing
`theirs` without inspection can overwrite in-progress work in the shared DB.

### Understanding why conflicts happen

| Scenario | Typical resolution | Why |
|---|---|---|
| Completed work vs stale main state | ours | Your branch has the latest progress |
| Enriched descriptions vs original | ours | Your descriptions are more detailed |
| Upstream updates from another agent | theirs | Accept the newer upstream state |
| User-intentional reset | theirs | Respect the user's explicit action |

### Agent decision framework

1. List conflicts: `trekoon --toon sync conflicts list`
2. Group by pattern — are conflicts on the same field or direction?
3. If uniform pattern, batch resolve: `trekoon --toon sync resolve --all --use ours`
4. If mixed, narrow by entity or field, or inspect individually
5. When unsure, ask the user

### Batch resolve patterns

Common scenarios:

```bash
# Resolve all conflicts at once (most common after completing work)
trekoon --toon sync resolve --all --use ours

# Preview before resolving
trekoon --toon sync resolve --all --use ours --dry-run

# Narrow to status field conflicts only
trekoon --toon sync resolve --all --use ours --field status

# Narrow to a specific entity
trekoon --toon sync resolve --all --use theirs --entity <id>

# Combine filters
trekoon --toon sync resolve --all --use ours --entity <id> --field description
```

## Shared-database model

Trekoon uses **one live SQLite database per repository**. The file lives at
`<sharedStorageRoot>/.trekoon/trekoon.db`, where `sharedStorageRoot` is the
parent of `git rev-parse --git-common-dir` (i.e., the main worktree root).

Key consequences:

- **All linked worktrees share the same database.** A status change in one
  worktree is immediately visible in every other worktree.
- **`git checkout` / `git switch` does not change tracker state.** The database
  is outside the git object store, so switching branches does not roll back or
  swap task data.
- **Sync operates on tracker events, not on the database file itself.** Use
  `sync pull` to import events between branches — never copy or commit the
  `.db` file.

Treat every write as a mutation of shared repo-wide state, not branch-scoped
state.

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

## Tool capability guidance

Inspect your available tools before assuming names. Prefer capability-based
selection over harness-specific tool names.

- Use your harness's structured file search and file read tools instead of shell
  commands for code inspection whenever possible.
- Use symbol-aware tools when available; fall back to content search when they
  are not.
- Run Trekoon commands, build/lint/test flows, and explicit git operations via
  your shell tool.
- Use `--compact` on Trekoon commands in sub-agent prompts to reduce token
  usage.

## User manual input:
