---
name: trekoon
description: "Use for Trekoon-based planning and execution: creating epics, tasks, and subtasks; breaking work into dependency-aware graphs; checking status and progress; planning backlog or sprint work; and coordinating agent execution from Trekoon. Prefer this whenever the user wants tracked implementation planning or Trekoon entity management, even if they do not explicitly say \"Trekoon\"."
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
| Plan | `reference/planning.md` | Converting a goal into a real epic/task/subtask dependency graph with validation and handoff. Includes creation policy, search/replace policy. |
| Execute | `reference/execution.md` | Running an epic end to end, choosing lanes, dispatching sub-agents, recording evidence, closing the epic. Includes single-agent loop, update policy, read policy. |
| Team execute | `reference/execution-with-team.md` | Agent Teams coordination via TeamCreate/TaskCreate/SendMessage when the environment supports it |
| Status machine | `reference/status-machine.md` | Canonical status transition table |
| Sync | `reference/sync.md` | Cross-branch sync, conflict resolution, shared-database model, worktree diagnostics |

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

See `reference/status-machine.md` for the canonical transition table and
`task done` auto-transition exception.

## Epic lifecycle

Epics follow the same status machine as tasks — they must transition through
`in_progress` to reach `done`.

```bash
# Start: mark epic in_progress before dispatching any work
trekoon --toon epic update <epic-id> --status in_progress

# Finish: mark epic done after all tasks are verified done
trekoon --toon epic update <epic-id> --status done
```

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

## Setup and fallback

If Trekoon is unavailable or storage diagnostics require repair:

```bash
trekoon --toon init
trekoon --toon sync status
trekoon --toon quickstart
trekoon --toon help sync
```

Re-bootstrap first, then re-read diagnostics. Do not continue with task
selection after missing shared storage or broken bootstrap.

## Tool capability guidance

- Use your harness's structured file search and file read tools for code
  inspection whenever possible.
- Use symbol-aware tools when available; fall back to content search otherwise.
- Run Trekoon commands, build/lint/test flows, and explicit git operations via
  your shell tool.
- Use `--compact` on Trekoon commands in sub-agent prompts to reduce token usage.

## User manual input:
