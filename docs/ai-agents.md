# AI agents and the Trekoon skill

Use this guide when an AI agent needs to plan work in Trekoon, execute it, and
keep task state current while it works.

## What the `trekoon` skill does

The bundled `trekoon` skill is the operating guide for agents. It tells the
agent to:

- use `--toon` on Trekoon commands
- prefer the smallest sufficient read
- use transactional bulk planning commands when possible
- append progress and blocker notes instead of rewriting full descriptions
- preview scoped replace before `--apply`
- treat `.trekoon` as shared repo-scoped operational state

The canonical installed file lives at:

- `.agents/skills/trekoon/SKILL.md`

## Install the skill

Install the bundled skill into the repository:

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

- canonical install path: `.agents/skills/trekoon/SKILL.md`
- default OpenCode link path: `.opencode/skills/trekoon`
- default Claude link path: `.claude/skills/trekoon`
- default Pi link path: `.pi/skills/trekoon`
- `--to <path>` changes only the editor link root
- `--allow-outside-repo` is for intentional external links

## Recommended skill stack

If your agent environment supports skills, this is the cleanest split of
responsibilities:

| Job | Skill | Why |
| --- | --- | --- |
| Turn a request into a concrete backlog | `writing-plans` | Breaks work into epics, tasks, subtasks, and dependencies |
| Create and update tracker state | `trekoon` | Uses Trekoon safely and efficiently |
| Execute the plan in dependency order | `executing-plans` | Helps the agent work through the backlog without losing the sequence |
| Clarify architecture before planning | `architecting-systems` | Useful when boundaries or ownership are still fuzzy |

In practice, the flow is usually:

1. plan the work
2. load `trekoon`
3. create or update the Trekoon graph
4. execute the next ready task
5. update progress, blockers, and completion state as work moves forward

## Default execution loop for agents

The main loop is: **session → work → task done → repeat**.

Start with a single orientation call:

```bash
trekoon --toon session
```

If the session output shows you are behind, pull tracker events before claiming
work:

```bash
trekoon --toon sync pull --from main
```

Claim work, then finish or report a block:

```bash
trekoon --toon task update <task-id> --status in_progress
trekoon --toon task done <task-id>
trekoon --toon task update <task-id> --append "Blocked by <reason>" --status blocked
```

Use `task done` when the task is actually finished. It marks the task complete
and returns the next ready candidate with blockers inline.

## Tell the agent exactly what to do

These prompts work well because they are explicit about the skill order and the
expected loop.

### Plan first, then create the backlog

```text
Load writing-plans, break this feature into one epic with tasks and subtasks,
then load trekoon and create that graph in Trekoon.
```

### Execute an existing backlog

```text
Load trekoon, run `trekoon --toon session`, take the next ready task, do the
work, append progress notes, mark it done, and repeat until there are no ready
tasks or you hit a blocker.
```

### Use planning, tracking, and execution together

```text
Load writing-plans to shape the backlog, load trekoon to create and update the
tasks, then load executing-plans and complete the work in dependency order.
```

## Keep reads small and mutations safe

Use the narrowest command that answers the question:

| Need | Preferred command |
| --- | --- |
| Session startup | `trekoon --toon session` |
| Next task only | `trekoon --toon task next` |
| A few ready options | `trekoon --toon task ready --limit 5` |
| One task with subtasks | `trekoon --toon task show <task-id> --all` |
| One epic tree | `trekoon --toon epic show <epic-id> --all` |
| Repeated text in one scope | `trekoon --toon epic|task|subtask search ...` |

For repeated text changes, use the safe replace loop:

1. search the narrowest valid scope
2. preview replace
3. run `--apply` only after the preview matches the intended scope

Example:

```bash
trekoon --toon epic search <epic-id> "path/to/somewhere"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply
```

## Worktree and sync rules

- Treat `meta.storageRootDiagnostics` as the source of truth for storage.
- In linked worktrees, `sharedStorageRoot` may differ from `worktreeRoot`. That
  is expected.
- Do not commit `.trekoon/trekoon.db` as a recovery fix.
- Run `trekoon sync status` at session start and before merge.
- Resolve sync conflicts explicitly when they appear.

Useful commands:

```bash
trekoon --toon sync status
trekoon --toon sync pull --from main
trekoon --toon sync conflicts list
trekoon --toon sync conflicts show <conflict-id>
trekoon --toon sync resolve <conflict-id> --use ours
```

## Related docs

- [Quickstart](quickstart.md)
- [Command reference](commands.md)
- [Machine contracts](machine-contracts.md)
- [Installed skill source](../.agents/skills/trekoon/SKILL.md)
