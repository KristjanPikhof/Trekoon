# Execution Reference

**You are an orchestrator.** Execute work from Trekoon, not markdown plan files.
Spawn and coordinate sub-agents based on the task dependency graph and subsystem
grouping so independent lanes run in parallel and dependent lanes run
sequentially.

**Execute mode contract:** execution is complete only when the epic is marked
`done`, all remaining work is blocked with recorded reasons, or user input is
required to continue.

**Clarify ambiguity upfront.** If the plan has unclear requirements or meaningful
tradeoffs, ask the user before starting.

## Choose execution shape first

Use the lightest shape that still preserves momentum:

- **Single-agent execution**: one ready task, narrow scope, or strongly coupled
  work. Use the `session → claim → work → task done → repeat` loop from
  `SKILL.md`.
- **Orchestrated execution**: multiple ready tasks across separable lanes. This
  file focuses on that path.

Do not stop at status reporting when ready work exists.

## Build the execution graph

Construct a runnable graph from Trekoon entities using the deterministic
scheduler loop:

1. **Get the ready set for batching decisions:**
   ```bash
   trekoon --toon task ready --epic <epic-id> --limit 50
   ```
2. **Use reverse lookup when deciding what completed work unblocks:**
   ```bash
   trekoon --toon dep reverse <task-or-subtask-id>
   ```
3. **Load full context only when execution details are needed:**
   ```bash
   trekoon --toon epic show <epic-id> --all
   ```

Prefer scheduler primitives (`task next`, `task ready`, `dep reverse`) over
broad scans (`task list --all`, `epic show --all`).

## Group tasks into lanes

Batch ready tasks by subsystem/domain to minimize repeated context loading:

```
Without: Task 1 (auth/login)  -> Agent 1 [explores auth/]
         Task 2 (auth/logout) -> Agent 2 [explores auth/ again]

With:    Tasks 1-2 (auth/*)   -> Agent 1 [explores once, executes both]
```

| Signal | Group together |
|--------|----------------|
| Same directory prefix | `src/auth/*` tasks |
| Same domain/feature | Auth tasks, billing tasks |
| Same `--owner` value | Tasks assigned to same lane |
| Same Trekoon intent | Similar task title/description scope |

**Limits:** 3-4 tasks max per group. Split if larger.

**Parallel:** Groups touch different subsystems.
**Sequential:** Groups have dependency edges between them.

## Mark epic in-progress

Before dispatching any work, transition the epic so it reflects actual state:

```bash
trekoon --toon epic update <epic-id> --status in_progress
```

This must happen once, immediately after building the execution graph. If
execution is interrupted, the epic is at least `in_progress` rather than `todo`.

## Dispatch sub-agents

For each parallel lane group, spawn a sub-agent with a prompt like:

```
Execute these Trekoon tasks IN ORDER unless task description says parallel
subtasks:
- Task <id>: <title>
- Task <id>: <title>

Before starting each task:
- claim and assign owner:
  trekoon --toon task claim <id> --owner <lane-name>
- append a short start note:
  trekoon --toon task update <id> --append "Starting implementation"

While executing:
- complete required subtasks, update subtask statuses
- append meaningful progress notes (do not rewrite the task description)
- respect the status machine: todo -> in_progress -> done (never skip)

On completion:
- append final verification evidence
- mark done: trekoon --toon task done <id>
  (task done auto-transitions from todo/blocked through in_progress)
- read the response: it includes unblocked downstream tasks and open
  subtask warnings — report these back

If blocked:
- append blocker reason, dependency id, and exact failing command/output
- set status: trekoon --toon task update <id> --status blocked

Use --compact to reduce output noise:
  trekoon --toon --compact task show <id>

Only create branches, commits, or PRs if the user explicitly requested them and
the current harness policy allows it. Always report files changed, verification
results, and blockers.
```

## Use task done response for orchestration

When a sub-agent calls `task done`, the response includes:

- **`unblocked`**: array of downstream tasks that became ready. Use this to
  decide what to launch next without re-querying the full readiness graph.
- **`openSubtaskIds`/`warning`**: if subtasks remain open, decide whether to
  go back or proceed.
- **`next`**: the next ready candidate with full tree and blockers.

**Orchestration flow after each task done:**

1. Read `unblocked` from the response.
2. If unblocked tasks exist, group them by subsystem and dispatch new agents.
3. If no unblocked tasks, check `next` for the top candidate.
4. If neither exists, run `suggest --epic <id>` for guidance.

## Auto-recovery

1. Agent attempts to fix failures (has context).
2. If can't fix, report failure with error output.
3. Dispatch fix agent with context.

**`status_transition_invalid`** — exact recovery sequence:
1. Run `trekoon --toon --compact task show <id>` to read the current status.
2. Append a blocker note: `trekoon --toon task update <id> --append "Blocked: status_transition_invalid from <attempted transition>; current status is <actual>"`.
3. Identify the valid intermediate transition (see `reference/status-machine.md`).
4. Apply the correct intermediate step, then retry the intended transition.
5. Only move on to the next task after the target task reaches the intended status or is explicitly marked `blocked`.

**`dependency_blocked`** — exact recovery sequence:
1. Run `trekoon --toon --compact task show <id>` to identify which dependency is unmet.
2. Append a blocker note: `trekoon --toon task update <id> --append "Blocked: dependency_blocked; depends on <dep-id>"`.
3. Run `trekoon --toon task ready --epic <epic-id>` to get a ready candidate.
4. Only then continue with the ready candidate — do not retry the blocked task.

## Verify before closing

All checks must pass before marking the epic complete:

### Code review

Run your code-review command/flow. Fix issues before proceeding. Poor DX/UX is
a bug.

### Automated tests

Run the full test suite. All tests must pass.

### Manual verification

Automated tests aren't sufficient. Actually exercise the changes:

- **API changes:** Curl endpoints with realistic payloads when the environment
  allows it.
- **External integrations:** Test against real services when credentials and
  safe access are available; otherwise record the gap.
- **CLI changes:** Run actual commands, verify output.
- **Parser changes:** Feed real data, not just fixtures.

### DX quality

During manual testing, watch for friction: confusing errors, noisy output,
inconsistent behavior, rough edges. Fix inline or document for follow-up.

### Record evidence

Append verification results to Trekoon as progress notes:

```bash
trekoon --toon task update <task-id> --append "All 358 tests pass, lint clean"
```

### Final progress check

Before closing the epic, confirm completion state:

```bash
trekoon --toon epic progress <epic-id>
```

Verify: `doneCount` equals `total`, `todoCount`/`blockedCount`/`inProgressCount`
are all 0.

## Cleanup

After verification is complete:

1. **Verify all tasks are done:**
   ```bash
   trekoon --toon epic progress <epic-id>
   ```
   All tasks must be `done` or clearly `blocked` with reason.

2. **Mark epic done** (already `in_progress` from the start step):
   ```bash
   trekoon --toon epic update <epic-id> --status done
   ```

3. **Run suggest to confirm nothing remains:**
   ```bash
   trekoon --toon suggest --epic <epic-id>
   ```
   Should return no actionable suggestions if the epic is cleanly closed.

4. **Return final execution summary:** completed tasks, remaining blockers,
    dependency state.

## Architectural fit

Changes should integrate cleanly with existing patterns. If a change fights the
architecture, refactor first rather than bolt on. The goal is zero tech debt.

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
   resolve per-conflict. See `reference/sync.md` for full conflict guidance.
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

## Update policy: prefer append-based progress logging

Use descriptions as the durable work log. For progress updates, append instead
of rewriting full descriptions.

Status transitions must follow the status machine. Use `in_progress` as the
intermediate step to reach `done`. Direct `todo → done` is invalid via
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
| Repeated text in one scope | `trekoon --toon epic\|task\|subtask search ...` |

Avoid broad scans such as `task list --all` or `epic show --all` when
`task next`, `task ready`, `dep list`, `dep reverse`, `suggest`, or `search`
can answer the question more cheaply.
