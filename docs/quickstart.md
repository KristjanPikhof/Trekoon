# Quickstart

Shortest path from zero to a working Trekoon workflow.

## Recommended human workflow

If you are driving Trekoon with an AI agent, the usual path is:

```bash
trekoon plan <goal>
trekoon <epic-id>
trekoon <epic-id> execute
```

- Use `plan` after you already have enough context from discussion,
  brainstorming, or research. Trekoon should turn that context into an
  execution-ready epic.
- Use `trekoon <epic-id>` to inspect the created epic, next ready work, and any
  blockers before starting execution.
- Use `execute` when you want the agent to keep working through the epic until
  it is done, all remaining work is blocked, or it needs your input.

The rest of this page is mostly the lower-level command surface that agents and
power users rely on.

## How storage works

Trekoon keeps one SQLite database per repository at `.trekoon/trekoon.db`. In
worktree setups, all worktrees share the same database because storage resolves
from the repository root.

Key points:

- `.trekoon` is gitignored. It's operational state, not source code.
- Outside git repos, Trekoon falls back to the current working directory.
- `worktreeRoot` is your checkout. `sharedStorageRoot` is the repo root that
  owns `.trekoon`.

## Initialize

```bash
trekoon init
trekoon --version
```

If an agent is driving the workflow:

```bash
trekoon --toon init
trekoon --toon sync status
```

Run `init` once per repository. It creates the shared storage root and installs
the board runtime under `.trekoon/board`. If `sync status` reports
`recoveryRequired` or a tracked/ignored mismatch, fix the setup before
continuing.

## Open the board

```bash
trekoon board open
```

Starts a loopback-only server on `127.0.0.1`, opens the browser, and prints a
fallback URL. The board is a self-hosted single-page app with no CDN
dependencies, so it works offline once initialized. Use `trekoon board update`
if you just need to refresh the runtime assets without opening the browser.

## Create work

```bash
trekoon epic create --title "Agent backlog stabilization" --description "Track stabilization work" --status todo
trekoon task create --title "Implement sync status" --description "Add status reporting" --epic <epic-id> --status todo
trekoon subtask create --task <task-id> --title "Add cursor model" --status todo
```

Browse results:

```bash
trekoon task list
trekoon task list --status done
trekoon task list --limit 25
trekoon task list --all --view compact
```

## One-shot planning

If you already know the full epic tree, create everything in one call:

```bash
trekoon epic create \
  --title "Batch command rollout" \
  --description "Ship one-shot planning workflows" \
  --task "task-a|First task|First description|todo" \
  --task "task-b|Second task|Second description|todo" \
  --subtask "@task-a|sub-a|First subtask|Subtask description|todo" \
  --dep "@task-b|@task-a" \
  --dep "@sub-a|@task-a"
```

This is better than sequential creates because later records can reference
earlier ones with `@temp-key`, and you get one atomic operation with mappings
and counts in the response.

## Dependencies

```bash
trekoon dep add <task-id> <depends-on-id>
trekoon dep list <task-id>
```

## Batch commands

For larger updates, use batch commands instead of looping:

| Need | Command |
| --- | --- |
| Multiple tasks under one epic | `trekoon task create-many --epic <epic-id> --task ...` |
| Multiple subtasks under one task | `trekoon subtask create-many <task-id> --subtask ...` |
| Multiple dependency edges | `trekoon dep add-many --dep ...` |
| Expand an existing epic | `trekoon epic expand <epic-id> ...` |

These validate the whole batch before applying, so a bad input fails the entire
operation instead of leaving partial state.

## Close or reopen a whole tree

```bash
trekoon epic update <epic-id> --all --status done
trekoon task update <task-id> --all --status done
```

Cascades atomically through all descendants. If any descendant has an unresolved
external dependency, the whole update fails with no partial writes. Works with
`--status done` and `--status todo` only.

## Export an epic to Markdown

```bash
trekoon epic export <epic-id>
trekoon epic export <epic-id> --path docs/plan.md        # exact file
trekoon epic export <epic-id> --path docs/plans           # default name inside dir
trekoon epic export <epic-id> --overwrite
```

Writes a readable Markdown snapshot under `plans/` by default. With `--path`,
a file extension means "write this file"; no extension means "put the default-
named file in this directory". Use `--overwrite` to resave after the plan state
changes.

## Check progress

```bash
trekoon epic progress <epic-id>
trekoon suggest
trekoon suggest --epic <epic-id>
```

`epic progress` returns task status counts and the next ready candidate.
`suggest` gives priority-ranked next-action recommendations.

## Status machine

Trekoon enforces status transitions. The statuses are `todo`, `in_progress`,
`done`, and `blocked`.

| From | Allowed targets |
| --- | --- |
| `todo` | `in_progress`, `blocked` |
| `in_progress` | `done`, `blocked` |
| `blocked` | `in_progress`, `todo` |
| `done` | `in_progress` |

Direct jumps like `todo` to `done` are rejected. Use `task done` instead, which
auto-transitions through `in_progress`.

## Install the AI skill

```bash
trekoon skills install                # repo-local (default)
trekoon skills install -g             # global (~/.agents/skills/trekoon)
trekoon skills install --link --editor claude  # repo-local + editor symlink
```

After upgrading Trekoon, refresh installed skills:

```bash
trekoon update                        # alias for: trekoon skills update
```

For agent integration details, see [AI agents and the Trekoon skill](ai-agents.md).

## Pre-merge sync

Before opening or merging a PR:

```bash
trekoon --toon sync status
trekoon --toon sync pull --from main
trekoon --toon sync conflicts list
trekoon --toon sync conflicts show <id>
trekoon --toon sync resolve <id> --use theirs --dry-run
trekoon --toon sync resolve <id> --use ours|theirs
trekoon --toon sync resolve --all --use ours          # batch: all pending at once
trekoon --toon sync status
```

Always run `sync conflicts show` before resolving so you know what you're
overwriting. For uniform conflicts, `--all` resolves every pending conflict in
one command. Optional `--entity <id>` and `--field <name>` narrow the batch.
In human mode, `--use theirs` prompts for both single-conflict and batch
resolve. Single-conflict prompts include field/value details; batch prompts use
a count-only confirmation. All prompts time out after 30 seconds and default to
rejection. Toon mode skips prompts.

## What to read next

- [Command reference](commands.md) for flags, defaults, and behavior
- [AI agents and the Trekoon skill](ai-agents.md) for agent integration
- [Machine contracts](machine-contracts.md) for structured output schemas
