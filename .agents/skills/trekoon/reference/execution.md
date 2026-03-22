# Execution Reference

**You are an orchestrator.** Execute work from Trekoon, not markdown plan files.
Spawn and coordinate sub-agents based on the task dependency graph and subsystem
grouping so independent lanes run in parallel and dependent lanes run
sequentially.

**Clarify ambiguity upfront.** If the plan has unclear requirements or meaningful
tradeoffs, ask the user before starting.

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
- set status to in_progress and assign owner:
  trekoon --toon task update <id> --status in_progress --owner <lane-name>
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

Commit after each edit. Report: files changed, test results.
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
4. Same error twice -> stop and ask user.

If a status update fails with `status_transition_invalid`, check current status
and transition through the valid intermediate step.

If a status update fails with `dependency_blocked`, refresh with
`task ready`/`task next` and continue with a ready candidate.

## Verify before closing

All checks must pass before marking the epic complete:

### Code review

Run your code-review command/flow. Fix issues before proceeding. Poor DX/UX is
a bug.

### Automated tests

Run the full test suite. All tests must pass.

### Manual verification

Automated tests aren't sufficient. Actually exercise the changes:

- **API changes:** Curl endpoints with realistic payloads.
- **External integrations:** Test against real services.
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

After committing and verifying:

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

4. **Create a branch** for the work unless trivial. Merge branch to main when
   done.

5. **Return final execution summary:** completed tasks, remaining blockers,
   dependency state.

## Architectural fit

Changes should integrate cleanly with existing patterns. If a change fights the
architecture, refactor first rather than bolt on. The goal is zero tech debt.
