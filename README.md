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

Alternative (npm global install — Bun must still be installed as the runtime):

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
| Learn the CLI | `trekoon [command] -h`, `trekoon [command] [subcommand] -h`, `trekoon quickstart` |
| Plan work | `trekoon epic ...`, `trekoon task ...`, `trekoon subtask ...`, `trekoon dep ...` |
| Track epic progress | `trekoon epic progress <id>` |
| Start an execution session | `trekoon session`, `trekoon session --epic <id>` |
| Get next-action suggestions | `trekoon suggest`, `trekoon suggest --epic <id>` |
| Keep worktrees in sync | `trekoon sync ...` |
| Install or refresh the AI skill | `trekoon skills install`, `trekoon skills install -g`, `trekoon skills update` |
| Maintenance | `trekoon events prune ...`, `trekoon migrate ...`, `trekoon wipe --yes` |

Machine output modes:

- `--toon` for true TOON-encoded payloads
- `--json` for JSON output
- `--compact` to strip metadata from TOON envelopes
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
- all assets are self-hosted: the board ships its own CSS, fonts (Inter,
  Material Symbols), and vanilla JS with no framework or CDN dependencies
- the board works fully offline once `trekoon board open` copies the runtime
  assets into `.trekoon/board`

Current board behavior to expect:

- the topbar is a compact single-row navbar showing the Trekoon brand, Epics
  and Board navigation, search, theme toggle, and a workspace info popover;
  selecting an epic adds the active epic context to the topbar
- the board toggles between an epics overview and a task workspace view; task
  detail opens as a modal overlay; responsive breakpoints adjust kanban column
  counts and component spacing
- the page scrolls naturally as a single SPA surface; modal overlays (task
  detail, subtask editor) lock body scroll while open
- overview cards are the primary entry point into an epic; clicking a card opens
  that epic's board workspace
- task cards show truncated descriptions; clicking anywhere on a card opens the
  task detail modal with the full description
- search is debounced and filters client-side across titles, descriptions,
  statuses, and subtask content

For the full lifecycle and examples, read [Quickstart](docs/quickstart.md) and
[Command reference](docs/commands.md).

## AI skill

Trekoon ships with a self-contained `trekoon` skill for AI agents. One skill
covers the full plan-to-completion workflow:

- **Command reference** — `--toon` defaults, status machine, bulk planning,
  append-based progress logging
- **Planning** — decomposition into epic/task/subtask DAGs, writing standard,
  file scopes, owner assignment, dependency modeling
- **Execution** — graph building, lane grouping, sub-agent dispatch, task done
  orchestration, verification
- **Agent Teams** — TeamCreate/SendMessage pattern for parallel Claude Code
  instances (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true`)

Install it per-repo or globally:

```bash
trekoon skills install          # repo-local (default)
trekoon skills install -g       # global (~/.agents/skills/trekoon)
trekoon update                  # refresh all installed links
```

The skill accepts arguments for quick entity-scoped actions:

```
/trekoon                     → load the skill
/trekoon <id>                → show status and next steps for an entity
/trekoon <id> execute        → start executing the entity's epic
/trekoon <id> plan           → decompose into tasks/subtasks/deps
```

Read [AI agents and the Trekoon skill](docs/ai-agents.md) for installation,
editor linking, and example prompts.

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
