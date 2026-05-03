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
  or requires user input**. Use subagents by default for non-trivial
  independent lanes when the harness exposes them.
- `trekoon <epic-id> team execute` → same execution contract, but use Agent
  Teams only when the environment supports it and the user explicitly wants it.

Reading `reference/planning.md` or `reference/execution.md` is a required setup
step for those modes, not the end of the workflow. Read
`reference/harness-primitives.md` before any mode that uses harness-local
question tools, local todo/task displays, subagents, review agents, or
runtime-specific orchestration.

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
| `trekoon plan <goal>` | Plan | `reference/harness-primitives.md`, then `reference/planning.md` | Epic exists, graph is validated, next-wave summary is returned |
| `trekoon <epic-id>` | Orient | None beyond this file unless needed | User knows current state, next ready action, and blockers |
| `trekoon <epic-id> execute` | Execute | `reference/harness-primitives.md`, then `reference/execution.md` | Epic is done, all remaining work is blocked, or user input is required |
| `trekoon <epic-id> team execute` | Team execute | `reference/harness-primitives.md`, then `reference/execution-with-team.md` | Same as execute, using Agent Teams |

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
| `execute`, `implement`, `do`, `complete`, `start`, `run` | **Execute:** read `reference/harness-primitives.md` and `reference/execution.md`, choose single-agent vs orchestrated execution, and keep going until the mode contract is satisfied |
| `team execute`, `execute with team` | **Team execute:** read `reference/harness-primitives.md` and `reference/execution-with-team.md` only when Agent Teams are available |
| `plan`, `break down`, `design`, `architect` | **Plan:** read `reference/harness-primitives.md` and `reference/planning.md`, then create or expand the epic graph |

### Examples

```text
trekoon plan build a dependency-aware release workflow
  → reads harness primitives + planning reference, creates a validated epic, returns epic ID + wave summary

trekoon abc-123
  → orients on epic/task/subtask abc-123, summarizes state and next action

trekoon abc-123 execute
  → reads harness primitives + execution reference, starts the execution loop, keeps going until done or blocked

trekoon abc-123 team execute
  → reads harness primitives + team execution reference, starts Agent Teams orchestration if supported
```

## Reference guides

Read references lazily based on mode.

> **Path note:** Script paths below are relative to this skill's folder (where this SKILL.md lives), not the current project root. Resolve them from this skill folder when invoking Bash.

| Mode | Read | Use it for |
|---|---|---|
| Harness primitives | `reference/harness-primitives.md` | Required before Plan, Execute, and Team execute. Universal intent-level guidance for local task displays, questions, subagent delegation, testing, review agents, and Trekoon evidence recording across Codex, Claude Code, OpenCode, Pi, and similar harnesses. |
| Plan | `reference/harness-primitives.md`, then `reference/planning.md` | Converting a goal into a real epic/task/subtask dependency graph with validation and handoff. Includes creation policy, search/replace policy. |
| Execute | `reference/harness-primitives.md`, then `reference/execution.md` | Running an epic end to end, choosing lanes, dispatching sub-agents, recording evidence, closing the epic. Includes single-agent loop, update policy, read policy. |
| Team execute | `reference/harness-primitives.md`, then `reference/execution-with-team.md` | Agent Teams coordination via TeamCreate/TaskCreate/SendMessage when the environment supports it |
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
  lane and delegate by default when the harness exposes subagents.
- If a higher-priority harness policy blocks subagent use without explicit user
  wording, ask immediately and explain that Trekoon execution is designed to
  preserve the parent context for orchestration.
- Ask the user only when the work is genuinely blocked by ambiguity, approval,
  or missing external access.

## Clarification tool rule

When planning or execution needs user input, use the harness's structured
question tool when available rather than burying the question inside narration:

- OpenCode: `question`
- Claude Code: `AskUserQuestion`
- Codex/Pi/other harnesses: use the native question tool if exposed; otherwise
  ask one concise plain-text question

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
| One ready task, narrow scope, tiny change, or tightly coupled work | Single-agent execution | `session --epic <epic-id>` |
| Multiple ready tasks across separable subsystems or owners | Orchestrated execution with subagents by default | Read `reference/harness-primitives.md` and `reference/execution.md`, then `task ready --epic <epic-id> --limit 50`; delegate safe independent lanes when the harness exposes subagents |
| User explicitly asked for team execution and Agent Teams are available | Team execution | Read `reference/execution-with-team.md` |

Single-agent loop shape: **session → claim → work → task done → repeat**.
Read `reference/execution.md` for the full loop, including subtask discipline,
update/recovery policy, and the canonical command sequences.

## Delegation policy

Use subagents by default for non-trivial independent Trekoon execution lanes
when the harness supports them. This preserves the parent context window for
orchestration, dependency decisions, user communication, and final synthesis.
The parent agent's job is to keep finishing the epic, not to personally perform
every implementation step.

- A bare `execute` request means own the epic to completion using Trekoon's
  orchestration strategy, including subagents for safe independent lanes when
  the harness supports them.
- If a higher-priority harness rule requires explicit permission before
  spawning subagents, ask immediately instead of quietly falling back to
  single-agent execution.
- The parent may complete tiny tasks directly. Prefer delegation once work is
  non-trivial, separable, or likely to consume context needed for later
  dependency decisions.
- Use the harness's native subagent/task mechanism. If exact tool names are not
  known, phrase the action as "spawn a subagent for this bounded Trekoon lane".
- Prefer one subagent per execution lane, not one subagent per tiny task.
- Spawn subagents when 2+ ready tasks are independent, touch different
  subsystems, or can be grouped into bounded lanes.
- Use read-only/explorer subagents for noisy discovery and write-capable
  worker/general subagents for implementation lanes.
- Keep each lane small enough to verify and report clearly.
- Avoid delegation when the scope is tiny, the tasks are tightly coupled, or the
  overhead exceeds the gain.
- When tasks share the same directory roots, owners, or subsystem context, group
  them into one lane.
- Use local todo/task tools as a live progress display for the user and as
  current-session coordination state. Trekoon remains the durable source of
  truth for status, owners, blockers, dependencies, notes, and evidence.

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
