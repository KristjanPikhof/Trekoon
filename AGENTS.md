# CLAUDE.md

Guide for agents working in this repo.

## Bootstrap (start of every session)

1. `trekoon --toon session` — diagnostics, sync state, next ready task. If `recoveryRequired`, stop and `trekoon --toon init`.
2. Scope to active work: `trekoon --toon session --epic <id>`.
3. Trekoon is the source of truth for tracked work — do not duplicate plans elsewhere.

## Workflow rules

- **Atomic-commits hook is active.** Every Edit/Write triggers a per-file commit. Do **not** run `git commit`, `git add`, or `git push` manually unless the user asks.
- **Tracker DB is shared, repo-scoped.** `.trekoon/trekoon.db` lives outside the git object store; never commit it. `git checkout` does not roll back tracker state.
- **Trekoon skill** at `.agents/skills/trekoon/`. SKILL.md is the lean router (≤250 LOC); deep guidance in `reference/*`. Status-machine table is canonical at `reference/status-machine.md` — do not restate elsewhere.
- **Prefer minimal, targeted edits.** No broad rewrites. Preserve existing examples unless fixing factual issues.

## Dev CLI and verify

- Run local source: `bun run run -- <subcommand>` (= `bun run ./src/index.ts`). Or use installed `trekoon`.
- Build: `bun run build`. Lint: `bun run lint` (= `bunx tsc --noEmit`).
- Verify before claiming done:
  - Touched board: `bun test tests/board && bunx tsc --noEmit`
  - Touched commands: `bun test tests/commands && bunx tsc --noEmit`
  - Single file: `bun test tests/board/foo.test.ts`
- Pre-existing TS errors in unrelated files (e.g. `tests/export/*`) are out of scope unless your task touches them.

## Coding conventions

- **Imports:** stdlib → third-party → local. Explicit named imports. Remove unused.
- **Formatting:** consistent quotes, no mixed tabs/spaces.
- **Types:** explicit at API boundaries. Avoid `any` unless justified. Stubbing `globalThis.fetch` in tests: cast `as unknown as typeof fetch` (bare `() => Promise<Response>` lacks `preconnect`).
- **Naming:** `camelCase` (vars/fns), `PascalCase` (types), `UPPER_SNAKE_CASE` (constants).
- **Errors:** never silently swallow. Include op + endpoint + status code. Redact secrets from errors, logs, and machine output; require explicit `--reveal-*` flag to expose.
- **Shells:** keep commands portable across macOS and Linux.

## Board architecture

### Orchestrator and modules
- `src/board/assets/app.js` is the orchestrator. Put shared UI logic in component/state/runtime modules, not in `app.js`.
- Component lifecycle: `mount`, `update`, `unmount` for stateful UI.
- Event hooks: delegated `data-*` via `src/board/assets/runtime/delegation.js`. No ad-hoc per-render listeners.
- Helpers: `src/board/assets/components/helpers.js` and `src/board/assets/state/utils.js`. `escapeHtml` covers 5 chars including `'`.

### Rerender stability
- Do not regress input values, cursor position, search text, or `<details>` open state on update.
- `preserveFormState` accepts an optional `cache: Map` per form to avoid O(n²) `getManagedControls` walks.
- `deriveBoardState` is memoized via `createBoardStateMemo` (reference-stable until `notify()`). Time-sensitive selectors must include a `Math.floor(Date.now()/BUCKET_MS)` dep so they re-evaluate on long-open pages.

### Modal visibility pattern
- Each overlay has a separate open flag: `taskModalOpen`, `subtaskModalOpen`. Render gates on `flag === true && selectedX !== null`. `open<X>` and `close<X>` flip both flag and selection.
- Selection mutations (drag-drop, status patches) must **not** alter `selectedTaskId` / `taskModalOpen`.

### Overlay accessibility
- Preserve inert background, focus trap, opener-focus restoration, dialog/live-region semantics.
- Focus trap is **lazy**: `attach()` when an overlay opens, `detach()` when none remain. Helper at `src/board/assets/runtime/focus-trap.js`. Do not register `document.keydown`/`focusin` unconditionally.

### URL state
- Refresh-survivable / deep-link state goes through `src/board/assets/state/url.js`. `hashToState` must set the matching `<X>ModalOpen=true` whenever `task=` or `subtask=` is present.
- Local-only state goes to board storage. Do not invent parallel mechanisms.

### Mutations and realtime
- Client mutations are serialized through the queue in `src/board/assets/state/api.js`. No "drop while mutating", no one-off fetch flows that bypass rollback.
- Each enqueued mutation gets `mutationId = crypto.randomUUID()`. Clear `lastFailedMutation` by `mutationId`, not function-reference.
- Rollback uses `computeInverseDelta` against the post-optimistic snapshot, never `replaceSnapshot(previous)` — preserves concurrent server-pushed deltas on unrelated entities.
- Preserve CLI-equivalent canonical per-entity events and full payloads.
- Multi-entity cascades stay atomic: no partial writes / snapshots / events on dep-blocked failures.
- **PATCH preconditions:** `/api/epics/:id`, `/api/tasks/:id`, `/api/subtasks/:id`, `/api/epics/:id/cascade` accept `If-Match: <updatedAt-ms>` (bare or quoted). Mismatch → 409 with `currentUpdatedAt`. Missing header allowed for back-compat.
- **SSE channel:** `/api/snapshot/stream` is fed by `src/board/event-bus.ts`. Bus is **per-server-instance** (not module-level singleton) so concurrent test servers stay isolated.
- **External CLI writes:** `src/board/wal-watcher.ts` watches `.trekoon/trekoon.db-wal` mtime, debounces, diffs the snapshot, publishes deltas to the same bus. Boards reflect CLI mutations within ~1s.

### Security
- Board HTML routes are auth-gated. Unauthenticated `GET /` returns 401 with no snapshot or token.
- Bootstrap fetches `/api/snapshot` client-side after auth. Do **not** inline the snapshot in `index.html`.
- `trekoon board open` redacts the token from default machine output. Use `--reveal-token` to opt in.

## CLI command development

**Arg parser** (`src/commands/arg-parser.ts`):
- `parseArgs()` returns `{ positional, options, flags, missingOptionValues, providedOptions }`.
- `options: ReadonlyMap<string,string>` — pass `parsed.options` to `readOption()`.
- `flags: ReadonlySet<string>` — pass `parsed.flags` to `hasFlag()`.
- Never pass the full `parsed` object to these helpers.

**New subcommand checklist** (e.g. `epic export`):
1. Add `case` in command file's switch (before `default:`).
2. Define `OPTIONS` const for `findUnknownOption` validation.
3. Update the `default` case usage string.
4. Update `EPIC_HELP` / `TASK_HELP` in `src/commands/help.ts`.
5. Custom error types (not `DomainError`) must be caught inside the case block — outer `catch` only handles `DomainError` and SQLite busy errors; everything else becomes `internal_error`.

**Domain method signatures** (`src/domain/tracker-domain.ts`):
- Create methods take object inputs: `createEpic({title,description})`, `createTask({epicId,title,description})`, `createSubtask({taskId,title,description})`.
- `updateTask(id, {status?,title?,description?,owner?})` — positional ID + object.
- `addDependency(sourceId, dependsOnId)` — positional strings.

Prioritize startup speed and low-latency UX in CLI changes.

## Documentation surfaces for new commands

When adding a CLI subcommand, update **all** of:

1. `src/commands/help.ts` — `*_HELP` constant.
2. `src/commands/quickstart.ts` — human text **and** structured arrays (`powerUserCommands`, `machineExamples`). Easy to miss; serves different consumers.
3. The `default` case usage string in the command handler.
4. `README.md` — commands table.
5. `CHANGELOG.md` — current version's Added section.
6. `docs/commands.md`.
7. `docs/quickstart.md` — if it fits getting-started.
8. `docs/ai-agents.md` — if agents use the command.

## Export pipeline

Format-agnostic bundle pattern:
- `src/export/types.ts` — `ExportBundle` IR.
- `src/export/build-epic-export-bundle.ts` — reads domain, classifies deps, builds bundle.
- `src/export/render-markdown.ts` — renderer consuming the bundle.
- `src/export/path.ts` — deterministic default path under `plans/`.
- `src/export/write.ts` — atomic write with overwrite guard.

New format = new renderer (e.g. `render-json.ts`) + `--format` flag. **Do not modify the bundle builder.**
