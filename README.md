# Trekoon

AI-first task tracking that lives in your repo. You describe what to build, your
agent plans it as a dependency graph, then executes it task by task.

Trekoon stores work as **epics > tasks > subtasks** with dependency edges in a
local SQLite database. Every command has structured output (`--toon`, `--json`)
so agents can read and update state without parsing human text. No server, no
accounts. The database lives in `.trekoon/` inside your repo.

## Install

```bash
bun add -g trekoon
```

Or via npm (Bun still needs to be installed as the runtime):

```bash
npm i -g trekoon
```

```bash
trekoon init          # set up .trekoon/ in your repo
trekoon quickstart    # walkthrough of the basics
```

## The two workflows

Trekoon gives agents two modes: **plan** and **execute**. You can run them
separately or back to back.

For a human driving the workflow, the recommended path is:

```bash
trekoon plan <goal>
trekoon <epic-id>
trekoon <epic-id> execute
```

- Use `plan` after you already have enough context from discussion,
  brainstorming, or research.
- Use `trekoon <epic-id>` to inspect the created epic, review the next ready
  work, and decide whether anything needs refinement.
- Use `execute` when you want the agent to keep working through the epic until
  it is done, all remaining work is blocked, or it needs your input.

### Plan

Tell the agent what you want to build or what problem you want fixed. If you
already did brainstorming or research, Trekoon should use that context instead
of starting from zero. Planning decomposes the work into an epic with tasks,
subtasks, and dependency edges, then writes the whole graph into Trekoon.

```bash
trekoon plan <description>
```

What the agent does during planning:

1. Reuses the current conversation, prior research, and existing constraints
2. Asks clarifying questions if requirements are ambiguous
3. Creates an epic with outcome-oriented title and scoped description
4. Breaks it into tasks grouped by subsystem (auth, billing, UI, etc.)
5. Adds subtasks with concrete file paths, acceptance criteria, and test commands
6. Wires dependency edges so the execution order is explicit
7. Assigns lane owners when multiple agents will work in parallel
8. Validates the graph with `epic progress` and `suggest` before handing off

For humans: use `plan` when you want Trekoon to turn a feature request or bug
investigation into a tracked, execution-ready backlog.

Each task description includes target files, read-first files, do-not-touch
paths, and verification commands. Another agent (or a human) can pick up any
task and execute it without re-reading the codebase to figure out what to do.

### Execute

Point the agent at an epic and it works through the dependency graph
automatically. It is recommended to do it with clean context window.

```bash
trekoon <id> execute
```

What the agent does during execution:

1. Runs `session --epic <id>` to get diagnostics, sync status, and the first
   ready task
2. Marks the epic `in_progress`
3. Groups ready tasks into lanes by subsystem to minimize redundant codebase
   exploration
4. Spawns sub-agents for parallel lanes (auth tasks go to one agent, billing
   tasks to another)
5. Each sub-agent claims a task, does the work, appends progress notes, and
   calls `task done`
6. `task done` returns which downstream tasks just became unblocked, so the
   orchestrator knows what to dispatch next
7. After all tasks complete: code review, tests, manual verification, then marks
   the epic `done`

The orchestrator uses `task done` responses to drive the whole loop. No polling,
no guessing. When a task finishes, Trekoon tells you exactly what's ready next.

For humans: use `execute` when the plan looks good and you want the agent to own
the epic end to end. It should keep going until the epic is complete, all
remaining work is blocked with recorded reasons, or it needs a product or
technical decision from you.

## Install the skill

The `trekoon` skill is what teaches agents the planning methodology, execution
orchestration, status machine rules, and command reference. Without the skill,
agents don't know how to use Trekoon properly.

```bash
trekoon skills install          # repo-local (.agents/skills/trekoon/)
trekoon skills install -g       # global (~/.agents/skills/trekoon)
trekoon update                  # refresh all installed skills
```

The skill bundles three reference documents that agents load on demand:

| Agent needs to... | Skill reads | What it covers |
| --- | --- | --- |
| Plan a feature | `reference/planning.md` | Decomposition, writing standard, dependency modeling, validation |
| Execute an epic | `reference/execution.md` | Graph building, lane grouping, sub-agent dispatch, verification (universal) |
| Execute with Agent Teams | `reference/execution-with-team.md` | TeamCreate/SendMessage, parallel Claude Code instances in tmux |

### Invoke the skill

```
/trekoon                     → load the skill
/trekoon plan                → decompose into tasks/subtasks/deps
/trekoon <id>                → show status and next steps for an entity
/trekoon <id> execute        → start the execution loop
/trekoon <id> analyze        → run progress + suggest, report findings
```

### Example prompts

Plan only:

```
/trekoon — plan this feature as one epic with tasks, subtasks, and dependencies
```

Execute only:

```
/trekoon <epic-id> execute
```

Plan and execute end to end:

```
/trekoon — plan this feature, create the backlog, then execute the tasks in
dependency order until the epic is complete
```

## Agent Teams

For larger epics, Trekoon supports Claude Code Agent Teams. Instead of
sequential sub-agents, you get real parallel Claude Code instances coordinated
through `TeamCreate` and `SendMessage`, each running in its own tmux pane.

Requires Claude Code env variable `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true`.

The team lead orchestrator creates a team, populates a shared task list, spawns
3-5 teammates per lane, and coordinates via messages. Teammates claim tasks,
report completions and blockers, and the lead dispatches new work as tasks get
unblocked.

## Status machine

Trekoon enforces valid transitions. You can't skip straight from `todo` to
`done`.

| From | Allowed targets |
| --- | --- |
| `todo` | `in_progress`, `blocked` |
| `in_progress` | `done`, `blocked` |
| `blocked` | `in_progress`, `todo` |
| `done` | `in_progress` |

Exception: `task done` auto-transitions through `in_progress`, so agents can
call it from any non-done status.

## Local board

Trekoon includes a browser-based board for humans who like having visual overview.
No build step, no framework dependencies, works offline.

```bash
trekoon board open      # starts a local server, opens browser
trekoon board update    # refresh assets only
```

Binds to `127.0.0.1` only with a per-session token. Gives you an epics
overview, kanban workspace per epic, task detail modals, and search.

## Commands

| What you want to do | How |
| --- | --- |
| Set up a repo | `trekoon init` |
| Open the local board | `trekoon board open` |
| Plan work | `trekoon epic create ...`, `trekoon epic expand ...` |
| Create tasks in bulk | `trekoon task create-many ...` |
| Add dependencies | `trekoon dep add-many ...` |
| Start an agent session | `trekoon session --epic <id>` |
| Get next-action suggestions | `trekoon suggest --epic <id>` |
| Check epic progress | `trekoon epic progress <id>` |
| Export epic to Markdown | `trekoon epic export <id>` |
| Mark a task done | `trekoon task done <id>` |
| Sync across worktrees | `trekoon sync pull --from main` |
| Get help | `trekoon [command] -h` |

Every command supports `--toon`, `--json`, `--compact` for structured output.

Full flag reference in [docs/commands.md](docs/commands.md).

## Docs

- [Quickstart](docs/quickstart.md)
- [Command reference](docs/commands.md)
- [AI agents and the Trekoon skill](docs/ai-agents.md)
- [Machine contracts](docs/machine-contracts.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
