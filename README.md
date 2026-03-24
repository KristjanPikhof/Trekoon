# Trekoon

Local-first issue tracking for your terminal. Works for humans and AI agents
against the same repo-scoped task graph.

You plan work as **epics > tasks > subtasks**, track it from the command line,
and get structured output (`--toon`, `--json`) when automation needs to read it.
No server, no accounts, no context switching.

## Install

```bash
bun add -g trekoon
```

Or via npm (Bun still needs to be installed as the runtime):

```bash
npm i -g trekoon
```

Then:

```bash
trekoon init          # set up .trekoon/ in your repo
trekoon quickstart    # walkthrough of the basics
```

## Core commands

| What you want to do | How |
| --- | --- |
| Set up a repo | `trekoon init` |
| Open the local board | `trekoon board open` |
| Plan work | `trekoon epic ...`, `trekoon task ...`, `trekoon subtask ...` |
| Add dependencies | `trekoon dep ...` |
| Check epic progress | `trekoon epic progress <id>` |
| Start an execution session | `trekoon session`, `trekoon session --epic <id>` |
| Get next-action suggestions | `trekoon suggest`, `trekoon suggest --epic <id>` |
| Sync across worktrees | `trekoon sync ...` |
| Install the AI skill | `trekoon skills install` (local) or `trekoon skills install -g` (global) |
| Get help | `trekoon [command] -h` |

### Machine output

Every command supports structured output for scripting and agent consumption:

- `--toon` for TOON-encoded payloads
- `--json` for JSON
- `--compact` to strip envelope metadata
- `--compat <mode>` for explicit compatibility behavior

Full flag reference in [docs/commands.md](docs/commands.md).

## Local board

Trekoon includes a browser-based board. No extra install, no build step, no
framework dependencies. Everything is self-hosted (CSS, fonts, JS) and works
offline.

```bash
trekoon board open      # copies assets, starts a local server, opens browser
trekoon board update    # refresh assets only, no server
```

The server binds to `127.0.0.1` only, uses a per-session token, and prints a
fallback URL if the browser launch fails. Nothing leaves your machine.

The board gives you an epics overview, a kanban workspace per epic, task detail
modals, search across all fields, and a theme toggle. It adapts to screen size
with responsive breakpoints.

## AI skill

Trekoon ships a skill that teaches AI agents the full plan-to-completion
workflow: decomposition, dependency modeling, lane grouping, sub-agent dispatch,
and verification.

Install per-repo or globally:

```bash
trekoon skills install          # repo-local
trekoon skills install -g       # global (~/.agents/skills/trekoon)
trekoon update                  # refresh all installed skill links
```

Quick actions from the prompt:

```
/trekoon                     → load the skill
/trekoon <id>                → status and next steps for an entity
/trekoon <id> execute        → start executing the epic
/trekoon <id> plan           → decompose into tasks/subtasks/deps
```

Supports Claude Code agent teams (`TeamCreate`/`SendMessage`) for parallel
execution when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=true` is set.

More in [docs/ai-agents.md](docs/ai-agents.md).

## Docs

- [Quickstart](docs/quickstart.md)
- [Command reference](docs/commands.md)
- [AI agents and the Trekoon skill](docs/ai-agents.md)
- [Machine contracts](docs/machine-contracts.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
