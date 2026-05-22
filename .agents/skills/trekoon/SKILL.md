---
name: trekoon
description: "Use for Trekoon planning/execution: epics, tasks, subtasks, dependency graphs, status/progress, backlog, agent execution. Prefer for tracked planning/entity management even when unnamed."
---

# Trekoon Skill

Trekoon is source of truth for plans, readiness, owners, blockers, progress, verification, completion. Load only needed refs.

## Modes

- `trekoon plan <goal>`: create execution-ready epic.
- `trekoon brainstorm[: <scope>]`: design only; create no Trekoon items until user accepts.
- `trekoon code-review[: <scope>]` or `trekoon code-review`: review current changes/scope only; fix nothing until user asks.
- `trekoon <id>`: orient on epic/task/subtask; report state, blockers, ready work, next.
- `trekoon <id> execute`: execute until epic done, rest blocked with reasons, or real user input required; delegate independent work by default.
- `trekoon <id> team execute`: same with Claude Agent Teams only when explicitly requested/supported.

Do not stop at analysis while ready work exists or invent non-Trekoon parallel plans.

## Load

| Situation | Load |
|---|---|
| Any Trekoon request | this file |
| Explicit `brainstorm:` | `reference/brainstorming.md`; after accepted design, `reference/harness-primitives.md` + `reference/planning.md` |
| Explicit `code-review` | `reference/code-review.md` |
| Plan/design tracked work | `reference/harness-primitives.md` + `reference/planning.md` |
| Execute/implement/complete | `reference/harness-primitives.md` + `reference/execution.md` |
| Sync gaps/conflicts/storage | `reference/sync.md` |

`harness-primitives` is required before planning/execution: claim, append, finish, runtime, task tools, review.

## Route Input

Resolve first non-mode arg:

```bash
trekoon --toon session --item <id>
```

Use returned `kind`, `parentEpicId`, payload, readiness, `suggestedNext`. Fallback:

```bash
trekoon --toon epic show <id> 2>/dev/null || trekoon --toon task show <id> 2>/dev/null || trekoon --toon subtask show <id> 2>/dev/null
```

For task/subtask IDs, scope `suggest`/`epic progress` to `parentEpicId`; execute item first, broader epic only if intended.

| Signal | Mode |
|---|---|
| ID only | Orient: `session --epic <epic-id>` or targeted show |
| `status`, `progress`, `analyze`, `review`, `check` | Analyze: `epic progress`, targeted show, `suggest --epic` |
| `trekoon brainstorm:` | Brainstorm, then Plan only after accepted design |
| `code-review` | Code review: review-only diff/scope, then ask before fixes |
| `plan`, `break down`, `design`, `architect` | Plan |
| `execute`, `implement`, `do`, `complete`, `start`, `run` | Execute |
| `team execute`, `execute with team` | Team execute |

## Done

- Plan: epic/tasks/subtasks/deps recorded, graph validated, user has epic ID + first wave.
- Code review: scoped findings by severity, reviewed files/checks stated, next-step confirmation.
- Orient: state, blockers, ready work, next command.
- Execute: epic `done`, remaining work `blocked` with reasons, or real user input required.

## Execution Defaults

Start with `session`; add `--epic <id>` when known. Keep moving while ready work exists. After each `task done`, inspect `unblocked`, `warning`/`openSubtaskIds`, `next`. Epic execution delegates independent lanes; parent coordinates deps/comms/synthesis/close. If harness blocks subagents, ask. Non-trivial implementation needs tests + separate review; record evidence.

## Non-Negotiables

- Use `--toon` on every Trekoon command.
- Trekoon updates are workflow state, not bookkeeping.
- Prefer small reads: `session`, `suggest`, `task ready`, `task next`, `dep list/reverse`, targeted `show`; add `--compact` for subagent prompts/noisy reads.
- Planning: prefer transactional/bulk commands; narrow `--ids` for bulk updates.
- Claude Code: parallel `Bash` Trekoon batches are read-only except atomic `task claim`/`subtask claim`; serialize `task done`/status changes after reread.
- Append progress/verification/blockers with `--append`; rewrite descriptions only to fix plans.
- Compact specs are pipe-split. Before `--task`/`--subtask`/`--dep`, rephrase or escape bare `|` as `\|`, esp. `||`/trailing `|`.
- Batch refs: declare temp keys bare (`--task "gate|..."`), but reference same-command temp keys with `@` (`--subtask "@gate|gate-help|..."`, `--dep "@ai|@gate"`). Later command/`dep add-many` refs = UUID; bare refs are IDs. Never use a bare temp key as a parent/source/depends-on ref in the same command.
- Preview search/replace before `--apply`.
- Never edit `.trekoon/trekoon.db`; keep `.trekoon` gitignored.
- Never run `trekoon wipe --yes --toon` unless explicitly requested.
- Branches, commits, merges, pushes, PRs only when asked and harness-allowed.

## Status/Recovery

Valid status moves: `todo→in_progress|blocked`, `in_progress→done|blocked`, `blocked→in_progress|todo`, `done→in_progress`; invalid returns `status_transition_invalid`. `task done` auto-walks tasks from `todo`/`blocked`; subtasks must claim or move through `in_progress` before `done`. Use `blocked` only with appended reason, evidence, unblock condition.

If diagnostics show `recoveryRequired`, stop selection; run:

```bash
trekoon --toon init
trekoon --toon sync status
```

If sync is behind/conflicted, resolve before claiming work; load `sync.md`.
