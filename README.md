# Trekoon

AI-first issue tracking for humans and agents.

Trekoon is a local-first CLI for planning and execution inside a repository. It
keeps work in a shared **epic → task → subtask** graph so humans and agents can
work against the same state, from the terminal, with deterministic machine
output when automation needs it.

## What it is for

- Fast issue tracking for day-to-day terminal use
- One repo-scoped task graph that works across branches and worktrees
- Stable machine-readable output for AI workflows (`--toon`, `--json`)
- Minimal command surface with strong planning and execution primitives

## Why it exists

Trekoon exists to make task tracking cheap enough to use while coding, and
structured enough that agents can read, update, and complete work without
guessing.

## Install

Recommended (global install with Bun):

```bash
bun add -g trekoon
```

Alternative (npm global install):

```bash
npm i -g trekoon
```

Verify the install:

```bash
trekoon --help
trekoon quickstart
```

## Commands

These are the commands most people need to recognize quickly:

| Goal | Commands |
| --- | --- |
| Initialize a repo | `trekoon init` |
| Learn the CLI | `trekoon help [command]`, `trekoon quickstart` |
| Plan work | `trekoon epic ...`, `trekoon task ...`, `trekoon subtask ...`, `trekoon dep ...` |
| Start an execution session | `trekoon session` |
| Keep worktrees in sync | `trekoon sync ...` |
| Install or refresh the AI skill | `trekoon skills install`, `trekoon skills update` |
| Maintenance | `trekoon events prune ...`, `trekoon migrate ...`, `trekoon wipe --yes` |

Machine output modes:

- `--toon` for true TOON-encoded payloads
- `--json` for JSON output
- `--compat <mode>` for explicit compatibility behavior
- `--help` and `--version` at the root or command level

For the full command surface, flags, filters, and bulk update rules, read the
[command reference](docs/commands.md).

## AI skill

Trekoon ships with a bundled `trekoon` skill for AI agents. It teaches the
agent to:

- use `--toon` by default
- prefer the smallest sufficient read
- use bulk planning commands when possible
- keep progress in Trekoon with append-based updates
- treat `.trekoon` as shared repo-scoped operational state

Read [AI agents and the Trekoon skill](docs/ai-agents.md) for installation,
editor linking, recommended skill combinations, and example prompts.

## Read next

- [Quickstart](docs/quickstart.md)
- [Command reference](docs/commands.md)
- [AI agents and the Trekoon skill](docs/ai-agents.md)
- [Machine contracts](docs/machine-contracts.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Implementation principles

- Minimal, composable modules
- Strict validation at command boundaries
- Stable automation envelopes for JSON and TOON modes
- No unnecessary feature sprawl
