# AGENTS.md

This file contains guidelines for agents.

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

## CLI command development

**Arg parser API** (`src/commands/arg-parser.ts`):
- `parseArgs()` returns `{ positional, options, flags, missingOptionValues, providedOptions }`
- `options` is a `ReadonlyMap<string, string>` — pass `parsed.options` to `readOption()`
- `flags` is a `ReadonlySet<string>` — pass `parsed.flags` to `hasFlag()`
- Never pass the full `parsed` object to these helpers; they expect the specific field

**Adding a new subcommand** (e.g., `epic export`):
1. Add a `case` in the switch statement in the command file (before `default:`)
2. Define an `OPTIONS` constant for `findUnknownOption` validation
3. Update the `default` case usage string to include the new subcommand
4. Update `EPIC_HELP`/`TASK_HELP` in `src/commands/help.ts`
5. Custom error types (not `DomainError`) must be caught inside the case block — the outer `catch` only handles `DomainError` and SQLite busy errors; everything else becomes a generic `internal_error`

**Domain method signatures** (`src/domain/tracker-domain.ts`):
- All create methods take object inputs: `createEpic({ title, description })`, `createTask({ epicId, title, description })`, `createSubtask({ taskId, title, description })`
- `updateTask(id, { status?, title?, description?, owner? })` takes positional ID + object
- `addDependency(sourceId, dependsOnId)` takes positional strings

## Export pipeline

The export feature uses a format-agnostic bundle pattern:
- `src/export/types.ts` — `ExportBundle` intermediate representation
- `src/export/build-epic-export-bundle.ts` — reads domain, classifies deps, builds bundle
- `src/export/render-markdown.ts` — one renderer consuming the bundle
- `src/export/path.ts` — deterministic default path under `plans/`
- `src/export/write.ts` — atomic write with overwrite guard

To add a new export format, add a renderer (e.g., `render-json.ts`) and a `--format` flag in the command — do not modify the bundle builder.

## Security

- Never commit secrets (tokens, credentials)
- Redact secrets from errors and logs
