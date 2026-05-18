# Harness Primitives

Trekoon is durable state; local todo/task tools display only. If they disagree, Trekoon wins.

| Need | Instruction |
|---|---|
| Orient | Read `session`/`progress`/`suggest` for ready work, blockers, diagnostics. |
| Display | Local tools only for lane/status notes. |
| Ask | Native question tool if available; else one concise question. |
| Delegate | Epic execution uses subagents by default for independent work. |
| Explore | Read-only agents for noisy lookup/logs/research. |
| Execute | Write-capable agents for bounded lanes. |
| Test | Run checks for touched scope. |
| Review | Review agent/skill for non-trivial code changes when available. |
| Record | Append progress, blockers, tests, review, evidence. |

## Delegation And Runtime

Treat "execute this epic/plan", "use/spawn subagents", "delegate/parallelize lanes", and "team execute" as orchestration. If independent lanes/subagents exist, delegate by default; parent coordinates deps, orientation, synthesis. Keep tiny/tightly coupled tasks in parent. If harness needs permission, ask with lane count.

Harness notes:
- Codex: use exposed subagents; if policy needs explicit wording, ask before broad execution. Do not silently do broad work in parent. Use `spawn_agent`/`send_input`/`wait_agent`/`resume_agent`/`close_agent` when available.
- Claude Code: normal subagents for bounded work; Agent Teams only when explicitly requested/supported. Parallel `Bash` Trekoon calls read-only except atomic claim; serialize status/`task done`.
- OpenCode: `@explore` read-only; `@general`/native Task write-capable; `question` when available.
- Pi/other: native task/subagent/question tools.

## Review

For non-trivial implementation, run separate review before closing task/epic. Prefer review agent/skill; review diff for correctness/regressions/tests/security/reliability/performance/integration risk. Tiny docs/mechanical changes may skip; run checks and append gap:

```bash
trekoon --toon task update <task-id> --append "Review: <summary or accepted gap>"
```

## Atomic Claim / Append / Done

```bash
trekoon --toon task claim <task-id> --owner <name>
trekoon --toon subtask claim <subtask-id> --owner <name>
trekoon --toon task update <task-id> --append "Started implementation"
trekoon --toon task update <task-id> --append "Verified: <commands/results>"
trekoon --toon task update <task-id> --append "Review: <result or accepted gap>"
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
trekoon --toon task done <task-id>
```

`task claim` races safely; loser sees owner; `task update --status in_progress` does not. Append; do not rewrite desc. Bulk append: `--ids <csv>` with only `--append`/`--status`. `task done` auto-walks tasks from `todo`/`blocked`; subtasks must claim or move through `in_progress` before `done`.

## Compact Spec Hazards

Batch creation (`epic create/expand`, `task/subtask create-many`, `dep add-many`) splits raw `|`; escape literal pipe as `\|`. Preflight: `grep -nE '(^|[^\\])\|\||\|$' specs.txt`. Hazards: mid-value `|` shifts status, `||`/multi-pipe adds fields, trailing `|` empties desc. Full matrix: `planning.md`.
