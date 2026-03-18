# AGENTS.md

This file contains guidelines for agents.

## Mandatory: Atomic Commit Policy

Every code change MUST be followed by an immediate commit.

**Commit format**:
```
<imperative verb> <what changed>     ← Line 1: max 50 chars
<blank line>                         ← Line 2: blank
<why/context, one point per line>    ← Body: max 72 chars per line
```

**Rules**:
1. One commit per logical change
2. Small, atomic commits - one file per commit preferred
3. Never batch unrelated changes

**Enforcement**:
- After any file modification, stop and commit before modifying another file
- Run `git status --short` after each commit to verify clean tree
- At milestones: run `bun run build && bun run lint && bun run test`

**Anti-patterns**:
- ❌ Multiple unrelated files in one commit
- ❌ Generic messages like "Update file", "WIP", "Fix stuff"
- ❌ Commit message over 50 chars on first line

## Coding Conventions

For Bun/TypeScript code:
- **Imports**: Group order (stdlib → third-party → local), explicit named imports, remove unused
- **Formatting**: Consistent quotes, avoid mixed tabs/spaces
- **Types**: Prefer explicit types at API boundaries, avoid `any` unless justified
- **Naming**: `camelCase` (vars/functions), `PascalCase` (types), `UPPER_SNAKE_CASE` (constants)

**Error handling**:
- Never silently swallow errors
- Include actionable context (operation + endpoint + status code)
- Redact secrets from errors and logs

## Agent Behavior

- Prefer minimal, targeted edits; avoid broad rewrites
- Preserve existing examples unless fixing factual issues
- For CLI changes, prioritize startup speed and low-latency UX
- Keep commands compatible with macOS and Linux shells

## Board UI and mutation guidance

- Treat `src/board/assets/app.js` as the board orchestrator. Put shared UI
  logic in focused component/state/runtime modules instead of growing a new
  monolith.
- Prefer the board component lifecycle pattern (`mount`, `update`, `unmount`)
  for stateful or rerendered UI.
- Use delegated `data-*` event hooks through
  `src/board/assets/runtime/delegation.js` instead of attaching ad hoc DOM
  listeners after each render.
- Reuse shared helpers from `src/board/assets/components/helpers.js` and
  `src/board/assets/state/utils.js` for rendering, escaping, formatting,
  status/view constants, and snapshot normalization.
- Preserve rerender stability. Do not regress input values, cursor position,
  search text, or `<details>` open state when updating board UI.
- Preserve overlay accessibility behavior: inert background, focus trap,
  opener-focus restoration, and dialog/live-region semantics.
- If UI state should survive refresh or deep links, wire it through
  `src/board/assets/state/url.js`. If it is local-only, persist it explicitly
  in board storage instead of inventing a parallel mechanism.
- Board client mutations are intentionally serialized through the queue in
  `src/board/assets/state/api.js`. Do not reintroduce "drop while mutating"
  behavior or bypass rollback handling with one-off fetch flows.
- For board/API mutations, preserve CLI-equivalent canonical per-entity events
  and full payloads.
- Multi-entity cascades must stay atomic: no partial writes, snapshots, or
  emitted events on dependency-blocked failures.

## Security

- Never commit secrets (tokens, credentials)
- Redact secrets from errors and logs
