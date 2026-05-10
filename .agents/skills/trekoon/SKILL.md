---
name: trekoon
description: "Use for Trekoon-based planning and execution: creating epics, tasks, and subtasks; breaking work into dependency-aware graphs; checking status and progress; planning backlog or sprint work; and coordinating agent execution from Trekoon. Prefer this whenever the user wants tracked implementation planning or Trekoon entity management, even if they do not explicitly say \"Trekoon\"."
---

# Trekoon Skill

Trekoon is the source of truth for tracked implementation work: plans,
readiness, owners, blockers, progress, verification evidence, and completion.
Use this file as the router. Load references only when the current mode needs
them.

## Mode Contracts

- `trekoon plan <goal>`: create an execution-ready epic in Trekoon.
- `trekoon <id>`: orient on the epic/task/subtask and report current state,
  blockers, and next action.
- `trekoon <id> execute`: own the epic until it is done, hard-blocked, or needs
  user input. Use subagents by default for meaningful work that can run
  independently when the harness exposes them.
- `trekoon <id> team execute`: same completion contract, using Claude Agent
  Teams only when the user explicitly asks and the environment supports it.

Do not stop at analysis when Trekoon shows ready work. Do not invent a parallel
plan outside Trekoon.

## Load Rules

| Situation | Load |
|---|---|
| Any Trekoon request | This file |
| Plan, break down, design tracked work | `reference/harness-primitives.md`, then `reference/planning.md` |
| Execute, implement, complete tracked work | `reference/harness-primitives.md`, then `reference/execution.md` |
| User explicitly asks for Claude team execution | `reference/harness-primitives.md`, then `reference/execution-with-team.md` |
| Sync gaps, conflicts, shared-storage questions | `reference/sync.md` |
| Status transition error or status uncertainty | `reference/status-machine.md` |

`reference/harness-primitives.md` is required before planning or execution
because those modes may need local task displays, user questions, subagents,
review agents, testing tools, and Trekoon evidence recording.

## Route Input

Resolve the first non-mode argument as an epic, task, or subtask:

```bash
trekoon --toon epic show <id> 2>/dev/null || \
trekoon --toon task show <id> 2>/dev/null || \
trekoon --toon subtask show <id> 2>/dev/null
```

If the ID is a task or subtask, resolve its parent epic and scope `session`,
`suggest`, and `epic progress` to that epic. If the user asked to execute a task
or subtask, start with that item; continue broader epic execution only when it
matches the user intent.

| User signal | Mode |
|---|---|
| ID only | Orient: `session --epic <epic-id>` or show the item |
| `status`, `progress`, `analyze`, `review`, `check` | Analyze: `epic progress`, targeted show, then `suggest --epic` |
| `plan`, `break down`, `design`, `architect` | Plan |
| `execute`, `implement`, `do`, `complete`, `start`, `run` | Execute |
| `team execute`, `execute with team` | Team execute |

## Completion Rules

- Plan mode is complete only when the epic exists, tasks/subtasks/dependencies
  exist in Trekoon, the graph is validated, and the user gets the epic ID plus
  first execution wave.
- Orient mode is complete when the user knows current state, blockers, ready
  work, and the likely next command.
- Execute mode is complete only when the epic is marked `done`, all remaining
  work is blocked with recorded reasons, or real user input is required.

## Execution Defaults

- Start with `trekoon --toon session`; scope with `--epic <id>` when known.
- If ready work exists, keep moving. After each `task done`, inspect
  `unblocked`, `warning`/`openSubtaskIds`, and `next`.
- When executing an epic, use subagents by default for any meaningful work that
  can run independently. Keep small or tightly coupled tasks in the parent
  agent.
- Use your context for orchestration, dependency decisions, user communication,
  and final synthesis. Your job is to finish the epic, not personally perform
  every implementation step.
- If a higher-priority harness rule blocks subagents without explicit user
  wording, ask immediately and explain that Trekoon execution preserves the
  parent context for orchestration.
- For non-trivial implementation, run relevant tests and a separate review pass
  when a review agent/skill is available. Record checks and review results in
  Trekoon before closing work.

## Non-Negotiables

- Use `--toon` on every Trekoon command.
- Treat Trekoon updates as workflow state, not after-the-fact bookkeeping.
- Prefer smallest sufficient reads: `session`, `suggest`, `task ready`,
  `task next`, `dep list`, `dep reverse`, targeted `show`.
- Prefer transactional/bulk commands for planning and narrow `--ids` for bulk
  updates.
- In Claude Code, keep parallel `Bash` batches read-only for Trekoon commands.
  Only `task claim` and `subtask claim` are safe parallel write exceptions.
  Run `task done` and other status-changing commands sequentially after reading
  current state.
- Append progress, verification, and blocker notes with `--append`; do not
  rewrite descriptions unless fixing the plan itself.
- Preview search/replace before `--apply`.
- Never edit `.trekoon/trekoon.db` directly. Keep `.trekoon` gitignored.
- Never run `trekoon wipe --yes --toon` unless the user explicitly asks.
- Create branches, commits, merges, pushes, or PRs only when the user explicitly
  asks and the harness policy allows it.
- Use `--compact` in subagent prompts and noisy reads.

## Status Reminder

Normal status flow is `todo -> in_progress -> done`; `blocked` requires an
appended reason. Use `task done` for task completion because it auto-transitions
from `todo` or `blocked` through `in_progress`. Load
`reference/status-machine.md` for transition errors or uncertainty. For
subtasks, claim or move through `in_progress` before marking `done`.

## Recovery

If Trekoon diagnostics show `recoveryRequired`, stop task selection and run:

```bash
trekoon --toon init
trekoon --toon sync status
```

If sync is behind or conflicts exist, resolve that before claiming work. Load
`reference/sync.md` for conflict handling.
