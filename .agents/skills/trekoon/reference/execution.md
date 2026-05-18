# Execution Reference

You are the orchestrator. Execute from Trekoon, not markdown. Done = epic `done`, rest `blocked` with reasons, or real user input required. Do not stop at status while ready work exists.

Default: delegate independent lanes; keep tiny/tightly coupled work in parent. Parent coordinates graph/deps/comms/synthesis/close. If unclear, ask before starting. Atomic claim/append/`task done`: `harness-primitives.md`.

## Shape And Graph

Direct = one ready/tightly coupled task. Orchestrated = ready separable lanes. Read scheduler data before broad repo reads:

```bash
trekoon --toon task ready --epic <epic-id> --limit 50
trekoon --toon dep reverse <task-or-subtask-id>
trekoon --toon epic show <epic-id> --all
trekoon --toon epic update <epic-id> --status in_progress
```

Group ready tasks by dir, subsystem/domain, owner, context. Parallel lanes touch different areas and lack deps; sequential lanes have hard deps. Keep lanes ~3-4 tasks; split large lanes. If harness blocks subagents, ask with lane count.

## Delegate Lanes

Spawn one write-capable subagent per independent lane when available. Local task tools display only; Trekoon is durable. Brief:

```text
Write-capable subagent for Trekoon lane. Epic <epic-id>; owner <lane-name>.
Execute tasks in order unless descriptions allow parallel subtasks: <ids/titles>.
Scope: target <paths incl UI/rendering>; read first <paths>; avoid <other-lane paths>.
For each task: atomic claim --owner; append progress/verification/blockers; task done. Subtasks claim or in_progress before done. If blocked append reason + dependency/failing output and set blocked.
Assume unrelated files may change; do not revert. Claude Code: parallel Trekoon Bash read-only except atomic claim; serialize status/task done; re-read after sibling cancellation. Use --compact for noisy reads. No branches/commits/pushes/PRs unless asked/allowed.
Final: completed tasks, files changed, checks, review/gap, task done response, blockers, integration step.
```

## Work Loop

1. Orient: `trekoon --toon session`, `trekoon --toon session --epic <epic-id>`.
2. If diagnostics show `recoveryRequired`, stop; run `trekoon --toon init`; if behind/conflicted, resolve sync before claim (load `sync.md`).
3. Claim, append, finish per `harness-primitives.md`.
4. Important subtasks: `subtask claim <id> --owner <name>`, `subtask update <id> --append "Verified ..." --status done`.
5. After each `task done`, inspect `unblocked`, `warning`/`openSubtaskIds`, `next`; dispatch newly unblocked safe work, else inspect `next`, else `suggest --epic`. If open subtasks remain, verify completion.

## Recovery Cases

`status_transition_invalid`: compact-show task; append attempted/current status; apply valid SKILL.md transition; retry only until reached or task `blocked` with reason.

`dependency_blocked`: compact-show task; append unmet dependency; run `task ready --epic <epic-id>`; work a ready candidate. Do not retry before dependency completes.

## Verify And Close

Before tasks/epic done, checks pass and evidence is appended. Non-trivial implementation needs separate review agent/skill when available; review diff for correctness/regressions/missing tests/security/reliability/performance/integration risk. Tiny docs/mechanical changes may skip; record gap. Run relevant checks, broaden for shared contracts, exercise realistic CLI/API/parser/integration inputs; record unavailable services.

Close only after all tasks are `done` or rest is `blocked` with reasons:

```bash
trekoon --toon epic progress <epic-id>
trekoon --toon suggest --epic <epic-id>
trekoon --toon epic update <epic-id> --status done
```

Return completed tasks, files changed, verification, review, blockers, deps.

## Read/Update Cheat Sheet

Use `--toon`; add `--compact` for noisy reads. Common reads: `session`, `session --epic`, `suggest --epic`, `epic progress`, `task next`, `task ready --epic --limit 50`, `dep list/reverse`, `task/epic show --all`.

Descriptions are logs. Append progress; rewrite only when plan is wrong. Bulk updates use `--ids <csv>`/`--all` (prefer `--ids`), only `--append`/`--status`, no positional ID; `--append`/`--description` are exclusive.

## Claude Agent Teams

Only when user explicitly asks for Claude Code Agent Teams and `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true`; otherwise standard subagents. Tools: `TeamCreate`, `TaskCreate/List/Update/Get`, `Agent` with `team_name`, `SendMessage`, `TeamDelete`. Flow: graph, epic `in_progress`, create team, one `TaskCreate` per lane with standard brief/claim/append/done/block and `blockedBy`, spawn 3-5 `general-purpose` teammates (`Explore`/`Plan` read-only), coordinate, update owners, if all block run `suggest --epic`, close epic, `shutdown_request`, `TeamDelete`.
