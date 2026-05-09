# Execution With Agent Teams Reference

You are a team lead orchestrator. Use this file only for Claude Code Agent
Teams when the user explicitly asks for team execution and
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true`. This is a runtime-specific path,
not the default subagent path for Codex, OpenCode, Pi, or other harnesses.

Team execution is complete only when the epic is marked `done`, all remaining
work is blocked with recorded reasons, or real user input is required.

Clarify meaningful ambiguity before starting.

## Start

Build the graph with the standard execution reference: `task ready`,
`dep reverse`, lane grouping, and first-wave validation. Then mark the epic in
progress:

```bash
trekoon --toon epic update <epic-id> --status in_progress
```

## Create Team And Tasks

1. Create the team:

```text
TeamCreate:
  team_name: "<epic-slug>"
  description: "Executing epic <epic-id>: <title>"
```

2. Create one shared team task per lane:

```text
TaskCreate:
  subject: "<lane>: <task-ids/titles>"
  description: |
    Execute these Trekoon tasks IN ORDER unless task descriptions allow
    parallel subtasks:
    - Task <id>: <title>

    Before each task:
    - trekoon --toon task claim <id> --owner <lane-name>
    - trekoon --toon task update <id> --append "Starting implementation"

    While working:
    - Complete required subtasks.
    - Append progress notes; do not rewrite task descriptions.
    - Use task done for task completion.
    - For subtasks, claim or move through in_progress before done.
    - Keep parallel Trekoon Bash calls read-only; serialize status-changing
      commands unless using atomic claim.
    - Use --compact for noisy Trekoon reads.

    On completion:
    - Append verification evidence.
    - trekoon --toon task done <id>
    - Report unblocked tasks, open subtask warnings, and next candidate via
      SendMessage.
    - Report review result or review gap for non-trivial code changes.

    If blocked:
    - Append blocker reason, dependency id, and exact failing command/output.
    - trekoon --toon task update <id> --append "Blocked by <reason>" --status blocked
    - Notify team lead via SendMessage.

    Do not create branches, commits, pushes, or PRs unless the user explicitly
    asked and harness policy allows it.
```

Use `blockedBy` via TaskUpdate for team tasks that must run sequentially.

3. Spawn one teammate per parallel lane:

```text
Agent:
  name: "developer-1"
  team_name: "<epic-slug>"
  subagent_type: "general-purpose"
  description: "<lane>: <task titles>"
  prompt: |
    You are a developer on team "<epic-slug>".
    Work through your TaskList assignment.
    Claim each Trekoon task before editing:
      trekoon --toon task claim <trekoon-task-id> --owner <your-name>

    Use task done for task completion. For subtasks, claim or move through
    in_progress before done. Do not batch multiple Trekoon status-changing Bash
    calls in one parallel tool turn. Read and report unblocked tasks, warnings,
    and next candidate via SendMessage.

    Communicate blockers and coordination needs via SendMessage.
```

Use 3-5 teammates for most epics. Do not over-parallelize. Use
`general-purpose` for implementation and `Explore`/`Plan` only for read-only
research or planning.

## Coordinate

Your job as team lead:

1. Monitor SendMessage updates.
2. When a teammate reports `unblocked` tasks from `task done`, create new team
   tasks and assign idle teammates.
3. Help resolve or reassign blockers.
4. Keep Trekoon owners current:
   ```bash
   trekoon --toon task update <task-id> --owner <teammate-name>
   ```
5. Use SendMessage to direct teammates.
6. Check progress:
   ```bash
   trekoon --toon epic progress <epic-id>
   ```
7. When all teammates are blocked, run:
   ```bash
   trekoon --toon suggest --epic <epic-id>
   ```

## Recovery

Use the standard execution recovery rules. Teammates should try to fix failures
with their local context. If they cannot, they must report exact command/output
via SendMessage so you can give fix instructions or reassign.

For `status_transition_invalid`, inspect current status with:

```bash
trekoon --toon --compact task show <id>
```

If the error came from a cancelled parallel Bash batch, first re-read the
affected task or subtask, then retry only the valid next transition. Do not
replay the whole batch.

For `dependency_blocked`, inspect the dependency, append a blocker note, then
continue with a ready candidate from:

```bash
trekoon --toon task ready --epic <epic-id>
```

## Verify And Close

Use the standard execution verification rules: review, automated tests, manual
checks, DX quality, and Trekoon evidence notes.

After all work is verified:

```bash
trekoon --toon epic progress <epic-id>
trekoon --toon suggest --epic <epic-id>
trekoon --toon epic update <epic-id> --status done
```

Then send `shutdown_request` to each teammate, delete the team with TeamDelete,
and return completed tasks, files changed, verification, review, remaining
blockers, and dependency state.

## Team Tools

| Purpose | Tool |
|---|---|
| Create team | `TeamCreate` |
| Manage shared tasks | `TaskCreate` / `TaskList` / `TaskUpdate` / `TaskGet` |
| Spawn teammates | `Agent` with `team_name` |
| Communicate | `SendMessage` |
| Clean up | `TeamDelete` |
