# Universal Harness Primitives

Use these intent-level primitives across Codex, Claude Code, OpenCode, Pi, and
similar agent harnesses. Prefer the intent first; let the current harness map it
to its native tools.

Trekoon is the durable source of truth. Harness-local todo/task tools are useful
as a live progress display for the user and as current-session coordination
state, but Trekoon owns statuses, owners, blockers, dependencies, completion
notes, verification evidence, and review outcomes.

## Primitive Map

| Primitive | Universal instruction | Harness decides |
|---|---|---|
| Orient | Read Trekoon session/progress/suggest to find ready work and blockers. | Shell/read tools |
| Display progress | Use local todo/task tools to show the current plan and live progress to the user. | Todo/task UI tools |
| Ask | Use the harness question tool if available; otherwise ask one concise plain-text question. | `question`, `AskUserQuestion`, or fallback text |
| Delegate | Spawn a subagent for each non-trivial independent Trekoon execution lane. | Native subagent/task mechanism |
| Explore | Use read-only/explorer subagents for noisy codebase lookup, logs, or research. | Explorer/read-only agent |
| Execute | Use write-capable worker/general subagents for bounded implementation lanes. | Worker/general/build agent |
| Test | Run the required automated or manual checks for the touched scope. | Shell, browser, simulator, test tools |
| Review | Use a capable review agent or review skill for non-trivial code changes. | Code-review subagent/skill |
| Record | Append progress, blockers, test results, review results, and completion evidence to Trekoon. | Trekoon CLI |

## Delegation Preference

Prefer offloading non-trivial, independent Trekoon execution lanes to subagents
when the harness supports it. This preserves the parent context window for
orchestration, dependency decisions, user communication, and final synthesis.

Keep work in the parent agent when it is tiny, tightly coupled, or the next
local step is immediately blocked on the result. If the harness requires
explicit user opt-in for subagents and the user has not provided it, ask one
concise confirmation or continue single-agent if asking would stall the work.

Treat requests such as "execute this epic", "work through this Trekoon plan",
"use agents", "spawn subagents", or "parallelize this" as permission to use
native subagents when the graph has safe independent lanes and the harness
policy allows it.

## Runtime Notes

- **Codex:** use natural-language delegation such as "spawn a worker subagent
  for this Trekoon lane". When native tools are exposed, the parent may use
  `spawn_agent`, `send_input`, `wait_agent`, `resume_agent`, and `close_agent`.
- **Claude Code:** use subagents for bounded side work. Use Agent Teams only
  when the user explicitly asks for team execution and the environment supports
  it.
- **OpenCode:** use `@explore` for read-only discovery and `@general` or the
  native Task tool for write-capable lane work. Use `question` when available.
- **Pi and other harnesses:** use the same universal wording and the native
  task/subagent/question tools when available.

## Local Task Tools

Use local todo/task tools to keep the user oriented:

1. Show the selected execution shape and lane list.
2. Mark each lane as pending, in progress, blocked, review, or done.
3. Keep the list short enough to be readable.
4. Mirror only the current session's coordination state.

Do not treat local todo/task tools as durable tracking. If local state and
Trekoon disagree, Trekoon wins.

## Review Guidance

For non-trivial implementation work, run a separate review pass before closing
the task or epic. Prefer a specialized code-review agent or relevant review
skill when available. The reviewer should inspect the actual diff and focus on
correctness, behavioral regressions, missing tests, security, reliability,
performance, and integration risks.

For tiny documentation or mechanical changes, a separate review agent is
optional. Still run the relevant check and record what was verified.

Append review outcomes to Trekoon before marking work done:

```bash
trekoon --toon task update <task-id> --append "Review: <summary of result or accepted risk>"
```
