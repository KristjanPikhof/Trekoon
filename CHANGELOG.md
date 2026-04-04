# Changelog

All notable changes to Trekoon are documented in this file.

## 0.3.8

### Added

- Cookie-based board session bootstrap: manual `board open` flows now
  authenticate via HttpOnly cookies and server-provided inline bootstrap data
  instead of tokenized URLs. CLI output prints stable, shareable tokenless
  board links.
- Database migration v10 (base schema v3): composite
  `idx_board_idempotency_state_created_at` index to keep completed-key pruning
  cheap as board history grows.
- Trekoon SKILL guidance: planning preflight that reuses existing brainstorm
  and research context, narrow decision-shaping clarification questions routed
  through interactive tools, explicit subtask status updates that mirror task
  state transitions, human checkpoint review before execution begins, and
  routing rules for plan/orient/execute modes so agents pick up tracked
  implementation work without being asked.
- Capability-based team execution guidance replacing harness-specific naming,
  with explicit blocker reporting and completion criteria, and commit/branch
  actions scoped to explicit user requests.
- Test coverage for cookie-based board bootstrap and snapshot payloads,
  optimistic mutation queue failure cleanup, malformed board state
  reconciliation, owner fields on board route snapshots, sync dependency edge
  conflicts, and idempotency pruning replay paths.

### Changed

- Board snapshot normalization shares reusable builders between full and delta
  responses, preserves owner fields throughout, derives dependencies from
  validated task/subtask entities, and treats blank owner updates as explicit
  clears.
- Dependency mutation events emit canonical edge identities for add/remove so
  conflict detection matches on stable IDs; event write transactions reuse
  prepared git metadata and timestamps instead of re-resolving per call.
- Sync pull preserves metadata fields in merge payloads for downstream
  processing while skipping those transport-only fields during conflict
  detection, and sync mutation handling imports shared operation constants to
  prevent drift.
- Stale board idempotency keys are pruned before replay checks to keep
  dependency event replays deterministic.
- `TrackerDomain` now owns context initialization internally; the redundant
  `cwd` argument is removed from its constructor and from board bootstrap
  payload construction.

### Fixed

- Board session tokens are no longer persisted in browser storage; sessions
  live in HttpOnly cookies sourced from the bootstrap payload.
- Optimistic mutation queue resets its state when an optimistic update throws,
  preventing the board from getting stuck in a "mutating" state and surfacing
  the underlying error.
- Local dependency delete conflict detection no longer reports a conflict when
  the dependency row is already missing, and stale remote delete operations
  against a missing local row are treated as non-conflicting — eliminating
  false sync failures during dependency cascade deletes.
- Board snapshot normalization drops tasks and subtasks with missing or
  invalid identifiers instead of generating random UUIDs, avoiding bad links
  in replayed deltas.

## 0.3.7

### Added

- Durable board idempotency storage for subtask/dependency create and delete
  mutations, plus request timeouts and retry affordances in the board client.
- Database migration v9 for board idempotency records and migration v8 sync
  scaling indexes for branch cursor scans and conflict lookups.

### Changed

- Board mutation routes now return targeted `snapshotDelta` payloads instead of
  rebuilding full mutation snapshots, while preserving fresh replay data for
  idempotent responses.
- Board snapshots and client state normalization now carry richer dependency
  metadata (`blockedBy`, `blocks`, nested task subtasks, owner support) and can
  merge partial snapshot deltas after optimistic mutations.
- Sync pull now processes incoming events in batches, scans local history in
  chunks, supports nullable task/subtask owners, and resolves large `sync
  resolve --all` sets incrementally.

### Fixed

- Board retries for timed-out or failed create/delete mutations now safely reuse
  stable client request IDs and remove optimistic ghost rows when canonical
  server deltas arrive.
- Task/subtask deletions now emit and replay dependency-removal events so board
  state and sync conflict resolution stay consistent for cascade deletes.
- Remote delete conflicts now account for local edits on child subtasks and
  touching dependencies, preventing partial delete application during sync.

## 0.3.6

### Added

- `trekoon init` auto-creates a `.gitignore` inside `.trekoon/` when running in
  a git repository, ensuring storage contents (SQLite DB, board assets) are
  gitignored by default. Reports `created`, `already_exists`, or `skipped` in
  both human and structured output. No action needed from users — the tool
  manages its own ignore rules.

## 0.3.5

### Added

- `sync resolve --all` batch-resolves all pending conflicts in one command.
  Optional `--entity <id>` and `--field <name>` filters narrow the batch.
  `--dry-run` previews without mutation. In human mode, `--use theirs` prompts
  for confirmation before execution; toon mode resolves directly.
- `sync resolve --use theirs` now applies delete conflicts by removing the
  target entity when the incoming change is a delete.
- Agent guidance in SKILL.md: why conflicts happen, decision framework for
  choosing ours vs theirs, and batch resolve command patterns.

### Changed

- Documentation, CLI help, and quickstart text now match final sync resolve
  behavior: single-conflict human prompts only apply to `--use theirs`, while
  batch `sync resolve --all --use theirs` uses a count-only confirmation.
- Machine-contract docs now describe explicit `sync.resolve` error contracts for
  `cancelled`, `already_resolved`, `no_matching_conflicts`,
  `conflict_set_changed`, and hardened domain failures
  (`unsupported_entity_kind`, `disallowed_field`, `row_not_found`).
- AGENTS.md removes the embedded atomic commit policy; automatic atomic commits
  remain handled by the editor/agent environment.

### Notes

- Version `0.3.5` is now finalized; this entry reflects its complete change set.

## 0.3.4

### Added

- `sync resolve --dry-run` previews what a resolution would write without
  touching the database, showing ours/theirs values and the intended outcome.
- Confirmation prompt for `sync resolve --use theirs` in human mode. Shows the
  field, current value, and incoming value before overwriting. 30-second timeout
  that defaults to rejection. Toon mode skips the prompt.
- Automatic pruning of resolved conflicts (default retention: 30 days) with
  dry-run support.
- Database migration v7: lookup indexes on dependencies, owner columns, and
  sync conflict resolution fields.
- Documentation for conflict resolution semantics, the shared-database model,
  and a step-by-step pre-merge sync workflow.

### Changed

- Documentation rewritten across all docs files, CLI help strings, and the
  `trekoon quickstart` output. Trimmed quickstart from 286 to 155 lines,
  removed board UI architecture from the command reference, consolidated
  duplicated sections into cross-references.
- Local skill install now copies files into `.agents/skills/trekoon/` instead
  of symlinking, so the skill can be committed to git and shared with the team.
  Global installs stay symlink-based. `skills update` migrates legacy symlinks
  automatically.
- Batch task and subtask creation now handles large batches (1000+ items)
  without hitting SQLite variable limits.
- Cascade blocker detection and dependency edge lookups run in a single query
  instead of per-row loops.

### Fixed

- `session` no longer prunes events or conflicts as a side effect. Pruning
  metrics are reported without mutation.

## 0.3.3

### Added

- Global skill installation with `trekoon skills install -g|--global`. Creates
  a global anchor at `~/.agents/skills/trekoon` and per-editor links under
  `~/.claude/skills/`, `~/.config/opencode/skills/`, and `~/.pi/skills/`.
- Short flag parsing (`-g`, `-h`, etc.) alongside long flags.
- `trekoon update` as a top-level alias for `trekoon skills update`.

### Changed

- Skill install now creates symlinks to the bundled source instead of copying
  files, so both local and global installs always match the installed CLI
  version without manual refresh.
- `skills update` probes and repairs both global and local symlinks, reporting
  per-entry status (`ok`, `repointed`, `created`, `migrated`, `skipped`).
- Symlink targets resolve correctly on macOS when OS-level path symlinks remap
  segments (e.g., `/var` to `/private/var`).
- Board status filter constant shared across components instead of duplicated.
- Reference guide filename corrected from `execution-teams.md` to
  `execution-with-team.md`.
- Updated package dependency versions.

### Fixed

- Symlink comparison no longer produces false mismatches when OS-level path
  remapping causes different prefixes.
- Broken symlinks are detected and replaced during install and update
  (previously dangling links were invisible to the check).
- Self-reference guard prevents circular symlinks when running `skills install`
  from within the Trekoon package directory.

## 0.3.2

### Added

- Board status filtering: toggle visibility of todo, blocked, in_progress, and
  done items with filter pills showing per-status counts.
- Drag-and-drop validation styles in the board workspace.
- Planning reference guide (`reference/planning.md`) covering decomposition,
  writing standards, dependency modeling, and validation.
- Execution reference guide (`reference/execution.md`) covering graph building,
  lane dispatch, task done orchestration, and verification.
- Agent Teams execution guide (`reference/execution-with-team.md`) for
  multi-agent coordination with TeamCreate/SendMessage.
- Machine contract specification (`docs/machine-contracts.md`).
- Epic lifecycle rule: agents must mark epics `in_progress` at execution start
  and `done` at cleanup.

### Changed

- SKILL.md now references external planning/execution guides instead of
  inlining the methodology.
- Epics transition to `in_progress` at execution start (before dispatching
  work), not only during cleanup. Prevents epics from staying `todo` when
  execution is interrupted.
- Plan output now requires full UUIDs in summary tables. Temp-keys are
  prohibited in user-facing output since they're ephemeral and not stored.
- Skills install/update auto-resolves symlink conflicts and replaces non-link
  directories instead of failing.
- Documentation expanded with board workflows, skill invocation syntax, and
  status machine guidance.

### Fixed

- Epics no longer get stuck in `todo` when execution is interrupted before
  reaching cleanup.
- Skills install no longer fails when a non-symlink directory exists at the
  target path.

## 0.3.1

### Added

- `trekoon suggest` command: priority-ranked next-action recommendations based
  on recovery state, sync status, readiness, and epic progress.
- `trekoon epic progress <id>`: status counts, readiness summary, and next
  candidate for an epic.
- `trekoon session --epic <id>`: scope session readiness to a specific epic.
- `--compact` flag: strips contract metadata from TOON/JSON envelopes.
- `--owner` field on tasks and subtasks (`update --owner <name>`). Migration
  0006 adds the owner column.
- Status machine enforcing `todo -> in_progress -> done`, `in_progress ->
  blocked`, `blocked -> in_progress|todo`, and `done -> in_progress`.
- `task done` auto-transitions through `in_progress` when current status is
  `todo` or `blocked`.
- `task done` reports newly unblocked downstream tasks and warns about
  incomplete subtasks.

### Changed

- `in-progress` (hyphenated) is no longer accepted. Canonical status is
  `in_progress`.

### Fixed

- `task done` from `todo` or `blocked` no longer rejected by the status
  machine.
- `suggest` no longer recommends invalid transitions like `todo -> done`;
  suggests valid intermediate steps instead.

## 0.3.0

### Added

- Copy-to-clipboard for epic IDs in the workspace header and epic rows, with
  auto-dismiss toast feedback.
- npm package metadata for registry publishing.

### Changed

- Board runtime is fully self-contained: locally hosted CSS, fonts, and vanilla
  JS with no CDN dependencies. Works offline after initial asset copy.
- README clarified that Bun is required as runtime even with npm global install.

### Fixed

- Copy feedback timer properly clears and resets state on dismiss.
- Board mutation queue respects creation ordering.

## 0.2.9

### Added

- Board top bar with epic/board navigation, global search, theme toggle, and
  storage-state info.
- Task inspector modal for inline editing, dependency management, subtask
  creation, and compact-screen focus.
- Subtask editor modal and destructive-action confirmation dialog.
- URL hash syncing: selected epic/task, search, view mode, and screen state
  are preserved across refresh, back/forward, and deep links.
- `PATCH /api/epics/:id/cascade` board API endpoint for atomic epic-wide status
  cascades.

### Changed

- Board frontend rewritten with a zero-dependency component runtime, delegated
  DOM events, and locally bundled CSS/fonts.
- Board mutations serialized through a client-side queue with optimistic
  updates and rollback on failure.
- Board workspace supports epic switching, status editing, bulk task status
  updates, notes panel, and kanban/rows views.
- Board API errors include request-scoped context. `.woff2` fonts served with
  correct MIME type.

### Fixed

- Epic status cascades stay atomic when dependency blockers prevent completion.
- Board state (search input, selected task/epic, URL history) stays in sync
  after refresh, deep links, and popstate restores.

## 0.2.8

### Added

- Board UI: web-based interface for browsing and managing epics, tasks, and
  subtasks.
- `trekoon board open`: starts a local server and opens the board in your
  browser, with real-time sync of tracker state.
- `trekoon board start`: starts the board server without opening a browser.
- Board components for epic/task overview, workspace navigation, search, and
  status management.

### Changed

- Agent documentation updated with board workflow guidance.
- README restructured around board UI and agent onboarding.
- Bundled documentation included in package distributions.

## 0.2.7

### Added

- Descendant cascade updates: `update <id> --all --status done|todo` closes or
  reopens an entire epic or task tree in one call.

### Changed

- `subtask update <id> --all --status done|todo` is accepted for consistency
  but just updates the one subtask (no descendants to cascade).
- Help text and docs clarify the two meanings of `update --all`: bulk field
  updates on selected rows vs. descendant cascades from a positional ID.
- Documentation ships in package distributions.

### Fixed

- Cascade updates stay atomic when any descendant is blocked.

## 0.2.6

### Fixed

- Skill symlinks use relative targets instead of absolute paths, so links
  survive when the repository is moved.

### Changed

- Skill documentation matches actual install/update behavior, including
  relative targets and update-time refreshes.
- Agent workflow guidance: run `sync pull --from main` before claiming work
  when `session` reports `behind > 0`.

## 0.2.5

### Fixed

- `skills update` now auto-creates editor symlinks for editors whose config
  directories exist (`.claude/`, `.opencode/`, `.pi/`). Previously it only
  refreshed the canonical file and left editor links stale or missing.

### Changed

- `skills update` output reports concrete actions (`created`, `refreshed`,
  `skipped_conflict`, `skipped_no_editor_dir`) instead of passive state labels.

## 0.2.4

### Added

- `trekoon session`: single-call agent orientation returning diagnostics, sync
  status, next ready task with subtasks, blockers, and readiness counts.
  Replaces the five-call bootstrap sequence.
- `trekoon task done <id>`: marks a task complete and returns the next ready
  task with dependencies inline. Replaces the three-call transition sequence.

### Changed

- Agent loop updated to `session -> work -> task done -> repeat`.
- Quickstart and help text now start with `session`.

### Fixed

- Readiness data in `session` output uses the same model as task transitions.

## 0.2.3

### Fixed

- `sync status` and `sync pull` correctly handle same-branch scenarios without
  spurious conflict detection.
- Sync pull cursor advances correctly for same-branch flows.

### Added

- `sameBranch` metadata in sync status and pull summaries.

### Changed

- Sync status output is clearer.
- Documentation covers same-branch sync behavior and compact-spec escaping
  rules.

## 0.2.2

### Fixed

- Storage model reworked for linked Git worktrees: shared state anchored at the
  repository root instead of inferred per worktree.
- Sync metadata scoped correctly for worktrees, with forward migration from
  older layouts.
- Startup, init, and sync handle legacy, split, and partially migrated storage
  gracefully.

### Added

- Recovery diagnostics in `init` and shell startup showing storage location,
  recovery state, and sync bootstrap issues.
- Recovery safeguards for ambiguous legacy layouts and WAL-backed databases.

### Changed

- Documentation describes the shared-storage worktree model more clearly.
- `wipe` messaging makes repository scope and safety constraints explicit.

## 0.2.1

### Added

- Batch planning commands: `task create-many`, `subtask create-many`,
  `dep add-many`, and `epic expand`.
- One-shot epic creation with `--task`, `--subtask`, and `--dep` specs, so a
  full plan tree can be created without a pre-existing epic ID.
- `@temp-key` references for same-invocation planning: reference tasks and
  subtasks before their UUIDs exist.
- Transactional batch behavior: validation, temp-key resolution, dependency
  linking, and rollback on failure.
- `trekoon quickstart`, expanded command help, and `trekoon skills
  install|update` for project-local agent onboarding.

### Changed

- Sync pull handles batch/create event replays idempotently when rows already
  exist locally.

### Notes

- Standalone `dep add-many` resolves persisted IDs only; `@temp-key` refs are
  for same-invocation workflows like `epic expand`.
- `subtask create-many` accepts a positional task ID or `--task`; when both are
  present they must match.

## 0.2.0

### Supported CLI surface

- Local-first Bun CLI for epics, tasks, subtasks, and dependency tracking.
- Lifecycle commands: create, list, show, update, delete across all entity
  types.
- Dependency graph: `dep add`, `dep remove`, `dep list`, `dep reverse`.
- Execution helpers: `task ready` and `task next` for deterministic ordering.
- Scoped search/replace for epic, task, and subtask content.
- Machine-readable JSON/TOON output with stable command IDs and request
  metadata.
- Sync workflows for branch/worktree coordination, conflict inspection, and
  resolution.
- `skills install` and `skills update` for project-local agent setup.
- Migration and event-retention commands for operational maintenance.
