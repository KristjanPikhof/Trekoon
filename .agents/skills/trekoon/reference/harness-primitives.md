# Harness Primitives

Use these intent-level primitives across Codex, Claude Code, OpenCode, Pi, and
similar harnesses. Trekoon is durable state; harness-local todo/task tools are
only live session display.

| Need | Instruction |
|---|---|
| Orient | Read Trekoon session/progress/suggest for ready work and blockers. |
| Display progress | Use local todo/task tools for the current execution shape and lane status. |
| Ask | Use the harness question tool when available; otherwise ask one concise plain-text question. |
| Delegate | When executing an epic, use subagents by default for meaningful work that can run independently. |
| Explore | Use read-only/explorer subagents for noisy codebase lookup, logs, or research. |
| Execute | Use write-capable worker/general subagents for bounded implementation lanes. |
| Test | Run the required automated or manual checks for touched scope. |
| Review | Use a review agent/skill for non-trivial code changes when available. |
| Record | Append progress, blockers, tests, review, and completion evidence to Trekoon. |

## Delegation Default

When executing an epic, use subagents by default for any meaningful work that
can run independently. Keep small or tightly coupled tasks in the parent agent.
Use the parent session to coordinate the epic, make dependency decisions, keep
the user oriented, and synthesize results.

Treat "execute this epic", "work through this Trekoon plan", "use agents",
"spawn subagents", "delegate independent lanes", "execute with subagents",
"parallelize this", and "team execute" as requests to orchestrate work to
completion. If safe independent lanes exist and the harness supports subagents,
delegate those lanes by default.

If a higher-priority harness policy blocks subagents without explicit user
wording, tell the user immediately:

```text
I found <n> independent Trekoon lanes. This harness requires explicit
permission before I can spawn subagents. Should I delegate those lanes and keep
coordinating from the parent session?
```

## Runtime Notes

- Codex: use subagents by default when exposed. If Codex policy requires
  explicit user wording, ask immediately before broad execution. Do not silently
  do broad work in the parent. When available, use `spawn_agent`, `send_input`,
  `wait_agent`, `resume_agent`, and `close_agent`.
- Claude Code: use normal subagents for bounded side work. Use Agent Teams only
  when the user explicitly asks for team execution and the environment supports
  it.
- OpenCode: use `@explore` for read-only discovery and `@general` or native
  Task for write-capable lane work. Use `question` when available.
- Pi/other harnesses: use the same intent and native task/subagent/question
  tools when available.

## Local Task Tools

Use local todo/task tools to show only current-session coordination:

1. Execution shape and lane list.
2. Lane status: pending, in progress, blocked, review, done.
3. Short enough to stay readable.

If local state and Trekoon disagree, Trekoon wins.

## Review

For non-trivial implementation, run a separate review pass before closing the
task or epic. Prefer a specialized review agent/skill. Review the actual diff
for correctness, regressions, missing tests, security, reliability, performance,
and integration risk.

Tiny docs/mechanical changes may skip separate review. Still run relevant
checks and record the review gap or decision:

```bash
trekoon --toon task update <task-id> --append "Review: <summary or accepted gap>"
```
