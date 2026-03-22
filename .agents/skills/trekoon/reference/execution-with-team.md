# Execution with Agent Teams Reference

**You are a team lead orchestrator.** Execute work from Trekoon using Agent
Teams — real parallel Claude Code instances coordinated via TeamCreate,
TaskCreate, SendMessage, and shared task lists. Each teammate runs in its own
tmux pane.

**Prerequisite:** Agent Teams requires the Claude Code environment variable
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` set to `"true"`. This feature is Claude
Code only — it is not available in OpenCode or other harnesses.

- [Claude Agent Teams documentation](https://code.claude.com/docs/en/agent-teams.md)

**Clarify ambiguity upfront.** If the plan has unclear requirements or meaningful
tradeoffs, ask the user before starting.

## Build the execution graph

Same as the standard execution reference — use `task ready`, `dep reverse`, and
lane grouping to construct a runnable graph. See `reference/execution.md` for
the full scheduler loop and lane grouping rules.

## Mark epic in-progress

Before dispatching any work, transition the epic so it reflects actual state:

```bash
trekoon --toon epic update <epic-id> --status in_progress
```

This must happen once, immediately after building the execution graph. If
execution is interrupted, the epic is at least `in_progress` rather than `todo`.

## Create the team

Use **TeamCreate** to set up the team, then **TaskCreate** to populate the
shared task list, then **Agent** with `team_name` to spawn teammates.

### Step 1: Create the team

```
TeamCreate:
  team_name: "<epic-slug>"
  description: "Executing epic <epic-id>: <title>"
```

### Step 2: Create tasks in the shared task list

For each task group from the execution graph, create a task:

```
TaskCreate:
  subject: "<lane description>: <task-ids/titles>"
  description: |
    Execute these Trekoon tasks IN ORDER unless task description says
    parallel subtasks:
    - Task <id>: <title>
    - Task <id>: <title>

    Before starting each task:
    - claim and assign owner:
      trekoon --toon task update <id> --status in_progress --owner <lane-name>
    - append a short start note:
      trekoon --toon task update <id> --append "Starting implementation"

    While executing:
    - complete required subtasks, update subtask statuses
    - append meaningful progress notes (do not rewrite task description)
    - respect the status machine: todo -> in_progress -> done (never skip)
    - use --compact to reduce output noise:
      trekoon --toon --compact task show <id>

    On completion:
    - append final verification evidence
    - mark done: trekoon --toon task done <id>
      (task done auto-transitions from todo/blocked through in_progress)
    - read the response: it includes unblocked downstream tasks and open
      subtask warnings — report these back via SendMessage

    If blocked:
    - append blocker reason, dependency id, and exact failing command/output
    - set status: trekoon --toon task update <id> --status blocked
    - notify team lead via SendMessage with blocker details

    Commit after each edit tool usage.
    Report: files changed, test results

    **Commit format**:
      <imperative verb> <what changed>     <- Line 1: max 50 chars
      <blank line>                         <- Line 2: blank
      <why/context, one point per line>    <- Body: max 72 chars per line
```

Use `blockedBy` via TaskUpdate to set dependencies between tasks that require
sequential execution.

### Step 3: Spawn teammates

For each parallel lane, spawn a teammate using the Agent tool:

```
Agent:
  name: "developer-1"
  team_name: "<epic-slug>"
  subagent_type: "general-purpose"
  description: "<lane>: <task titles>"
  prompt: |
    You are a developer on team "<epic-slug>".
    Check TaskList for your assigned tasks and work through them.
    Use TaskUpdate to claim tasks (set owner to your name) and mark
    them completed.

    Status machine rules:
    - todo -> in_progress -> done (valid)
    - todo -> done (INVALID — use task done which auto-transitions)
    - in_progress -> blocked (valid, with reason)
    - blocked -> in_progress (valid, to resume)

    When you complete a Trekoon task with `task done`, read the response:
    - unblocked: tasks that became ready — report via SendMessage
    - warning: open subtasks — report via SendMessage
    - next: next ready candidate

    Communicate with teammates via SendMessage if you need coordination.
    After completing a task, check TaskList for the next available task.
```

**Teammate count:** 3-5 teammates for most epics. Don't over-parallelize.

**Agent types:**
- Use `general-purpose` for implementation work (has edit/write/bash access)
- Use `Explore` or `Plan` only for read-only research or planning tasks

## Coordinate as team lead

Your job as team lead:

1. **Monitor progress** — teammates send messages when they complete tasks or
   hit blockers.
2. **Use task done responses** — when a teammate reports `unblocked` tasks from
   a `task done` response, create new team tasks via TaskCreate for the
   unblocked work and assign to idle teammates.
3. **Unblock work** — when a teammate reports a blocker, help resolve it or
   reassign.
4. **Assign ownership** — use TaskUpdate with `owner` to assign tasks to idle
   teammates. Also set Trekoon owner:
   ```bash
   trekoon --toon task update <task-id> --owner <teammate-name>
   ```
5. **Send messages** — use SendMessage to direct teammates, never plain text
   output.
6. **Check progress** — periodically run `epic progress` to gauge completion:
   ```bash
   trekoon --toon epic progress <epic-id>
   ```
7. **Get suggestions when stuck** — when all teammates are blocked:
   ```bash
   trekoon --toon suggest --epic <epic-id>
   ```

## Auto-recovery

1. If status update fails with `status_transition_invalid`, check current status
   and use the valid intermediate transition.
2. If status update fails with `dependency_blocked`, refresh with
   `task ready`/`task next` and continue with a ready candidate.
3. Teammate attempts to fix failures (has context).
4. If can't fix, teammate reports failure with error output via SendMessage.
5. Dispatch fix instructions via SendMessage to the teammate.
6. Same error twice -> stop and ask user.

## Verify and close

Same verification steps as the standard execution reference: code review,
automated tests, manual verification, DX quality, record evidence, final
progress check. See `reference/execution.md` for details.

## Shutdown and cleanup

After all work is verified:

1. **Check everything is done:**
   ```bash
   trekoon --toon epic progress <epic-id>
   ```

2. **Confirm nothing remains:**
   ```bash
   trekoon --toon suggest --epic <epic-id>
   ```
   Should return no actionable suggestions.

3. **Mark epic done** (already `in_progress` from the start step):
   ```bash
   trekoon --toon epic update <epic-id> --status done
   ```

4. **Shutdown teammates** — send `shutdown_request` via SendMessage to each.
5. **Delete the team** — use TeamDelete to clean up team and task directories.
6. Merge branch to main (if using branches).
7. Remove worktree (if using worktrees).
8. Return final execution summary: completed tasks, remaining blockers,
   dependency state.

## Team orchestration tools

| Purpose | Tool |
|---------|------|
| Create the team | `TeamCreate` |
| Manage shared task list | `TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet` |
| Spawn teammates | `Agent` (with `team_name`) |
| Communicate | `SendMessage` |
| Clean up | `TeamDelete` |
