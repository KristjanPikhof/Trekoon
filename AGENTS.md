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

## Security

- Never commit secrets (tokens, credentials)
- Redact secrets from errors and logs
