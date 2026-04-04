# Contributing to Trekoon

Thanks for wanting to work on Trekoon. This doc covers how to get the project
running locally, how to make changes, and what the PR process looks like.

## Prerequisites

- **Bun** `>= 1.2.0` (runtime and test runner)
- **Git** (Trekoon's storage model assumes you're inside a git repo)
- Node is not required

Check your Bun version:

```bash
bun --version
```

## Get the code running

```bash
git clone https://github.com/KristjanPikhof/Trekoon.git
cd Trekoon
bun install
```

The CLI entrypoint is `bin/trekoon`, which loads `src/index.ts`. To run your
local copy without installing globally:

```bash
bun src/index.ts <command>        # direct
bun run run -- <command>          # via the package script
```

## Project layout

```
src/
  index.ts         # CLI entrypoint
  commands/        # One file per top-level command (epic, task, sync, board, ...)
  domain/          # Tracker domain + mutation service
  storage/         # SQLite schema, migrations, path resolution, recovery
  sync/            # Event writes, conflict detection, pull/merge
  board/           # HTTP server, routes, snapshot builders, browser assets
  io/              # Structured output (human, toon, json, compact)
  runtime/         # Shared runtime plumbing
tests/             # Mirrors src/ structure
docs/              # User-facing documentation
bin/trekoon        # Shell entrypoint
```

When picking up an unfamiliar area, start at the relevant file in
`src/commands/`, follow it into `src/domain/` for the mutation path, then
into `src/storage/` for persistence.

## Running tests and lint

```bash
bun run test                   # full test suite
bun test tests/sync            # run a subfolder
bun run lint                   # type-check with tsc --noEmit
```

Tests under `tests/` mirror the `src/` structure. When you add a feature or
fix a bug, add a test in the matching folder. Integration tests go in
`tests/integration/`.

TypeScript runs in strict mode with `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, and `noImplicitOverride`. `bun run lint` must
pass before a PR can land.

## Making a change

1. **Branch from `main`** with a short, descriptive name. No strict format,
   but prefixes like `fix/`, `feat/`, `refactor/`, and `rewrite/` are common
   in this repo.
2. **Write the change and a test.** Features need coverage. Bug fixes need a
   regression test that would have caught the bug.
3. **Run `bun run test` and `bun run lint`.** Both have to be green.
4. **Commit in the imperative mood** ("Add X", "Fix Y"). Keep the subject
   under 50 characters and explain the *why* in the body. Recent commits on
   `main` are a good style reference.
5. **Update `CHANGELOG.md`** under the next version section, grouped by
   Added / Changed / Fixed. Skip pure internal refactors that no user will
   notice.
6. **Bump `package.json`** as part of a release PR, not on every change.

## Coding conventions

- **Imports:** group order is stdlib, third-party, then local. Use explicit
  named imports and drop anything unused.
- **Naming:** `camelCase` for variables and functions, `PascalCase` for
  types, `UPPER_SNAKE_CASE` for constants.
- **Types:** explicit at API boundaries. Avoid `any` unless you're ready to
  defend it in review.
- **Errors:** never swallow silently. Include the operation, target, and
  any relevant identifiers in the message. Redact anything secret-shaped
  from errors and logs.
- **Edits:** prefer targeted changes over broad rewrites. Don't clean up
  surrounding code unless that's the point of the PR.
- **CLI UX:** startup speed matters. Don't do work on the hot path that
  isn't required for the current command.
- **Shells:** commands should work on macOS and Linux without special
  handling.

See `AGENTS.md` for board UI conventions: component lifecycle, delegated
events, overlay accessibility, and the client mutation queue.

## Working on storage or sync code

Trekoon's storage model has a few sharp edges that are easy to break if you
don't know they're there.

- **Shared storage per repo.** Inside a git repo or linked worktree, Trekoon
  resolves storage from the repository's shared root, not per worktree. One
  repo, one `.trekoon/trekoon.db`, regardless of how many worktrees it has.
- **`meta.storageRootDiagnostics`** is the source of truth when debugging.
  It reports `storageMode`, `repoCommonDir`, `worktreeRoot`,
  `sharedStorageRoot`, and `databaseFile`. When something works locally but
  not in CI, start here.
- **Fail fast on bootstrap mismatches.** If bootstrap reports
  `recoveryRequired`, a tracked/ignored mismatch, or an ambiguous recovery
  path, stop and repair setup. Do not add a "continue anyway" fallback.
- **Never commit `.trekoon/trekoon.db`.** If a worktree is misbehaving,
  re-bootstrap or follow the reported recovery path. `.trekoon` is
  gitignored and has to stay that way.
- **Sync writes must preserve git context** (`branch`, `head`, `worktree`).
  Dropping any of these breaks conflict detection downstream.
- **Migrations are append-only.** If you add one, give it the next version
  number, wire up `up` and `down`, and bump `SCHEMA_VERSION` in
  `src/storage/schema.ts` when the base schema changes.
- **`trekoon wipe --yes` deletes shared storage for the whole repo**, not
  just the current worktree. Any docs or help text you write about wipe has
  to say that out loud.

## PR checklist

- [ ] `bun run test` and `bun run lint` pass locally.
- [ ] New logic has a test that would fail without the change.
- [ ] Sync-related writes preserve git context (`branch`, `head`,
      `worktree`).
- [ ] CLI help text, README, and docs match the actual implemented behavior.
- [ ] `CHANGELOG.md` updated for user-facing changes.
- [ ] No `.trekoon/trekoon.db` snapshots committed as a workaround.
- [ ] Wipe-related docs explicitly say `trekoon wipe --yes` is repo-scoped.
- [ ] No secrets or tokens in code, tests, or commit messages.

## Reporting bugs and proposing features

- **Bugs:** open an issue at
  <https://github.com/KristjanPikhof/Trekoon/issues> with the command you
  ran, what you expected, and what actually happened. If it's a storage or
  sync issue, include `meta.storageRootDiagnostics` from a structured
  output run (`--json` or `--toon`).
- **Features:** open an issue first for anything bigger than a small
  change. It's much faster to get feedback on the direction before writing
  the code than after.

## License

By contributing, you agree your changes are released under the project's
MIT license (see `LICENSE`).
