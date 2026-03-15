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
| Install/open/update the local board | `trekoon board open`, `trekoon board update` |
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

## Local board workflow

Trekoon ships a no-extra-install local board for browsing and updating work in a
browser.

- `trekoon init` creates the shared `.trekoon` storage, database, and board
  runtime under `.trekoon/board`
- `trekoon board open` ensures those bundled board assets are installed, starts a
  token-gated loopback server on `127.0.0.1`, and launches the browser
- `trekoon board update` refreshes the board runtime assets only; it does not
  start the server or open a browser

Keep the operator path simple:

```bash
trekoon board open
```

Use `trekoon board update` only when you want to refresh the copied runtime
assets without opening a session.

The browser flow is local-only by design:

- Trekoon copies the board shell and app files into repo-shared storage, so the
  board still starts with one CLI command and no separate frontend build step
- the board server binds only to `127.0.0.1`
- every `board open` session uses a per-session token in the URL/API requests
- command output always includes a manual fallback URL if the browser launch
  fails

Current runtime expectations:

- the local runtime is served from `.trekoon/board`
- the shell currently loads Vue from `esm.sh`, Tailwind from
  `cdn.tailwindcss.com`, and Google-hosted fonts/icons when the page renders
- if your environment blocks those hosts, `trekoon board open` still starts the
  local server, but the browser UI may render without the enhanced shell until
  network access is restored

Current board behavior to expect:

- wide screens show the epic switcher, workspace, and task inspector together
- narrower screens collapse supporting panels into stacked or drawer-style
  surfaces so the board remains usable without horizontal overflow
- long descriptions and dependency/subtask lists use disclosure controls such as
  “Show more” and “Collapse” instead of expanding dense rows by default
- overview cards are the primary entry point into an epic; the topbar then keeps
  the active scope visible as you switch between overview, board, and detail
  contexts
- compact/mobile layouts use explicit `Epics`, `Board`, and `Detail` modes so
  one dominant region owns attention at a time instead of stacking multiple
  competing panes
- scroll ownership moves with the active surface: page in overview, workspace in
  an epic, inspector/task modal for detail, and subtask modal for the top-most
  overlay; background layers stay locked while overlays are open

For the full lifecycle and examples, read [Quickstart](docs/quickstart.md) and
[Command reference](docs/commands.md).

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
