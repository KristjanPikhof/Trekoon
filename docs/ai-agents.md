# AI agents and the Trekoon skill

How to wire an AI agent into Trekoon so it can plan work, execute it, and keep
task state current as it goes.

## What the skill does

The bundled `trekoon` skill is the operating guide for agents. It teaches the
agent to:

- use `--toon` on Trekoon commands
- prefer the smallest read that answers the question
- use batch planning commands when possible
- append progress and blocker notes instead of rewriting descriptions
- preview scoped replace before `--apply`
- treat `.trekoon` as shared repo-scoped state

The skill ships with reference guides so the agent can handle the full
plan-to-completion workflow from one install:

```
.agents/skills/trekoon/
  SKILL.md                      <- command reference, status machine, agent loop
  reference/
    planning.md                 <- decomposition, writing standard, validation
    execution.md                <- graph building, lane dispatch, verification
    execution-with-team.md      <- Agent Teams pattern (Claude Code only)
```

The agent loads the relevant reference on demand: `planning.md` when asked to
plan, `execution.md` when asked to execute, `execution-with-team.md` when Agent
Teams are available.

## Install the skill

```bash
trekoon skills install
```

Create a project-local editor link when your agent environment supports it:

```bash
trekoon skills install --link --editor opencode
trekoon skills install --link --editor claude
trekoon skills install --link --editor pi
trekoon skills install --link --editor opencode --to ./.custom-editor/skills
trekoon skills update
```

Path behavior:

- Canonical install: `.agents/skills/trekoon/SKILL.md`
- OpenCode link: `.opencode/skills/trekoon`
- Claude link: `.claude/skills/trekoon`
- Pi link: `.pi/skills/trekoon`
- `--to <path>` changes only the editor link root
- `--allow-outside-repo` is for intentional external links

## Using the skill with arguments

The skill accepts an optional entity ID and action text:

```
/trekoon                              -> loads the skill normally
/trekoon <id>                         -> resolves the entity, shows status and next steps
/trekoon <id> analyze                 -> runs epic progress + suggest, reports findings
/trekoon <id> execute                 -> starts the execution loop for the entity's epic
/trekoon <id> plan the implementation -> decomposes into tasks/subtasks/deps
```

The skill resolves the ID as an epic, task, or subtask. For tasks and subtasks,
it scopes session/suggest/progress calls to the parent epic automatically.

## Companion skills

The `trekoon` skill handles the full plan-to-completion workflow on its own.
These optional companions add value for specialized needs:

| Job | Skill | When to use |
| --- | --- | --- |
| Clarify architecture before planning | `architecting-systems` | Boundaries or ownership are still fuzzy |
| Structured code review | `code-review-expert` | Want review before closing an epic |

Typical flow:

1. `/trekoon` to load the skill
2. Plan the work (reads `reference/planning.md` internally)
3. Create the Trekoon graph
4. Execute the plan (reads `reference/execution.md` internally)
5. Update progress, blockers, and completion state as you go

## Default execution loop

The core loop: **session, work, task done, repeat**.

Start with a single orientation call, optionally scoped to an epic:

```bash
trekoon --toon session
trekoon --toon session --epic <epic-id>
```

Or use `suggest` for priority-ranked recommendations:

```bash
trekoon --toon suggest
trekoon --toon suggest --epic <epic-id>
```

If the session shows you're behind, pull tracker events before claiming work:

```bash
trekoon --toon sync pull --from main
```

Claim work, assign ownership, then finish or report a block:

```bash
trekoon --toon task update <task-id> --status in_progress --owner "agent-1"
trekoon --toon task done <task-id>
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

Use `task done` when the task is actually finished. It marks the task complete,
auto-transitions through `in_progress` if needed, reports newly unblocked
downstream tasks, warns about incomplete subtasks, and returns the next ready
candidate. Strip envelope metadata with `--compact` when you don't need it:

```bash
trekoon --toon --compact task done <task-id>
```

## Status machine

Trekoon enforces valid transitions. Don't try direct jumps like `todo` to
`done`; they fail with `status_transition_invalid`. Use `task done` for
completing tasks (it handles the intermediate step).

See [Command reference: Status machine](commands.md#status-machine) for the
full transition table.

## Cascade mode

When you need to close or reopen an entire epic or task tree, use positional-ID
`update --all` instead of looping one row at a time:

```bash
trekoon --toon epic update <epic-id> --all --status done
trekoon --toon task update <task-id> --all --status done
```

Epic and task cascades are atomic. If any descendant is blocked, the whole update
fails. Only `--status done|todo` is supported. See
[Command reference: Cascade mode](commands.md#cascade-mode-with-positional-id)
for the full rules.

## Tell the agent exactly what to do

These prompts work well because they're explicit about the expected workflow.

### Plan first, then create the backlog

```text
/trekoon -- plan this feature as one epic with tasks, subtasks, and dependencies,
then create the graph in Trekoon.
```

### Execute an existing backlog

```text
/trekoon <epic-id> execute
```

Or more explicitly:

```text
/trekoon -- run session, take the next ready task, do the work, append progress
notes, mark it done, and repeat until there are no ready tasks or you hit a
blocker.
```

### Plan and execute end to end

```text
/trekoon -- plan this feature, create the backlog, then execute the tasks in
dependency order until the epic is complete.
```

## Keep reads small and mutations safe

Use the narrowest command that answers the question:

| Need | Command |
| --- | --- |
| Session startup | `trekoon --toon session` |
| Session scoped to epic | `trekoon --toon session --epic <epic-id>` |
| Next-action suggestions | `trekoon --toon suggest` |
| Epic progress summary | `trekoon --toon epic progress <epic-id>` |
| Next task only | `trekoon --toon task next` |
| A few ready options | `trekoon --toon task ready --limit 5` |
| One task with subtasks | `trekoon --toon task show <task-id> --all` |
| One epic tree | `trekoon --toon epic show <epic-id> --all` |
| Export epic to Markdown | `trekoon --toon epic export <epic-id>` |
| Repeated text in one scope | `trekoon --toon epic|task|subtask search ...` |

For repeated text changes, use the safe replace loop:

1. Search the narrowest valid scope
2. Preview replace
3. Run `--apply` only after the preview matches the intended scope

```bash
trekoon --toon epic search <epic-id> "path/to/somewhere"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply
```

## Shared-database model

Trekoon uses one live SQLite database per repository at
`<repoRoot>/.trekoon/trekoon.db`. In worktree setups, storage resolves from the
shared repository root, so all linked worktrees read and write the same database.

What this means for agents:

- **Worktrees share state.** A task marked `done` in one worktree is `done`
  everywhere immediately.
- **Branch checkout doesn't switch tracker state.** The database lives outside
  the git object store. `git checkout feature-branch` doesn't roll back the
  task graph.
- **Sync moves events, not database snapshots.** Use `sync pull --from main`
  to import events, not file copies.

## Worktree and sync rules

- `meta.storageRootDiagnostics` is the source of truth for storage location.
- In linked worktrees, `sharedStorageRoot` may differ from `worktreeRoot`.
  That's expected.
- Don't commit `.trekoon/trekoon.db` as a recovery fix.
- Run `trekoon sync status` at session start and before merge.
- Resolve sync conflicts explicitly when they appear.

### Ours vs theirs

Conflicts are field-level, not whole-record. Each conflict targets a single
field (`status`, `title`, `description`, etc.) on one entity.

- `--use ours` keeps the current DB value. The entity isn't written, but the
  conflict is marked resolved and a resolution event is appended.
- `--use theirs` overwrites the DB field with the source-branch value.

Always inspect conflicts before resolving. Choosing `theirs` without looking
can overwrite in-progress work. Use `--dry-run` to preview first:

```bash
trekoon --toon sync resolve <conflict-id> --use theirs --dry-run
```

In human mode (no `--toon`), `--use theirs` shows a confirmation prompt with a
30-second timeout that defaults to rejection. Toon mode skips the prompt.

Quick reference:

```bash
trekoon --toon sync status
trekoon --toon sync pull --from main
trekoon --toon sync conflicts list
trekoon --toon sync conflicts show <conflict-id>
trekoon --toon sync resolve <conflict-id> --use theirs --dry-run
trekoon --toon sync resolve <conflict-id> --use ours
```

## Related docs

- [Quickstart](quickstart.md)
- [Command reference](commands.md)
- [Machine contracts](machine-contracts.md)
- [Installed skill source](../.agents/skills/trekoon/SKILL.md)
