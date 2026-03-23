# Changelog

All notable changes to Trekoon are documented in this file.

## 0.3.3

### Added

- Global skill installation via `trekoon skills install -g|--global`, placing a
  global anchor symlink at `~/.agents/skills/trekoon` and per-editor links under
  each editor's global skills directory (`~/.claude/skills/`, `~/.config/opencode/skills/`,
  `~/.pi/skills/`).
- Short flag parsing in the arg parser (`-g`, `-h`, etc.) alongside existing
  long-flag (`--global`) support.
- `trekoon update` top-level alias that routes to `trekoon skills update`
  internally.
- Symlink probe/repair infrastructure for both install and update flows,
  replacing file-copy-based canonical installs with directory symlinks to the
  bundled package source.

### Changed

- Canonical skill install now creates a directory symlink to the bundled source
  instead of copying files, so local and global installs always reflect the
  currently installed package version without manual refresh.
- `skills update` now probes and repairs both global and local anchor/editor
  symlinks, reporting per-entry status (`ok`, `repointed`, `created`,
  `migrated`, `skipped`) instead of the previous action-per-editor format.
- Symlink target computation uses `realpathSync` on the nearest existing
  ancestor so relative targets are correct when OS-level symlinks remap path
  segments (e.g. macOS `/var` → `/private/var`).
- Board `DEFAULT_STATUS_FILTER` constant exported from `store.js` and used
  across `EpicsOverview`, `Workspace`, and `actions` instead of repeated inline
  object literals.
- Epic status normalized through `normalizeStatus` during board snapshot
  ingestion.
- Reference guide filename corrected from `execution-teams.md` to
  `execution-with-team.md` in docs and SKILL.md.
- SKILL.md adds a path-resolution note clarifying that reference script paths
  are relative to the skill folder, not the project root.
- Updated SKILL.md with stricter description
- Update package dependacny version

### Fixed

- Symlink comparison no longer produces false mismatches when OS-level path
  symlinks cause `readlinkSync` and `realpathSync` to return different path
  prefixes.
- Broken symlinks are now detected and replaced during both install and update
  (previously `existsSync` followed symlinks, missing dangling links).
- Self-reference guard prevents circular symlinks when running `skills install`
  from within the Trekoon package directory itself.
- Typo fix in SKILL.md execution reference table ("Uer" → "User").

## 0.3.2

### Added

- Board UI status filtering: toggle visibility of todo, blocked, in_progress,
  and done tasks/epics with filter pill buttons showing per-status counts.
- `getSelectableStatuses` utility that filters status select options by valid
  transitions from the current status.
- Drag-and-drop validation styles and filter pill CSS for board workspace.
- Trekoon planning reference guide (`reference/planning.md`) with decomposition
  methodology, information-dense writing standard, file scope declarations,
  owner assignment, dependency modeling, and validation workflow.
- Trekoon execution reference guide (`reference/execution.md`) with execution
  graph building, lane grouping, sub-agent dispatch, task done orchestration,
  verification gates, and cleanup flow.
- Trekoon Agent Teams execution reference guide
  (`reference/execution-with-team.md`) with TeamCreate/SendMessage coordination,
  teammate spawning, team lead orchestration, and shutdown workflow.
- Machine contract specification document (`docs/machine-contracts.md`).
- Epic lifecycle management in SKILL.md: orchestrators must mark epic
  `in_progress` at execution start and `done` at cleanup.

### Changed

- SKILL.md refactored to reference external planning/execution guides instead of
  inlining methodology, reducing duplication and centralizing orchestration
  patterns.
- Execution reference guides now transition epic to `in_progress` at the start
  of execution (before dispatching work), not only during cleanup. This prevents
  epics from staying in `todo` when execution is interrupted.
- Plan output format now mandates full UUIDs for epic and task IDs in summary
  tables. Temp-keys are prohibited in user-facing output since they are
  ephemeral creation-time references not stored in the database.
- `suggest` command refactored to use extracted sync helpers from
  `sync-helpers.ts`.
- `DEFAULT_SOURCE_BRANCH` constant extracted to `sync-helpers.ts` shared module.
- Board task status counting optimized from four separate filter passes to a
  single loop.
- In-progress task lookup functions consolidated to reduce duplication.
- Skills install/update now auto-resolves symlink conflicts and replaces
  non-link directories with symlinks instead of failing.
- README, quickstart, ai-agents, and commands documentation expanded with board
  workflow details, skill invocation syntax, and status machine guidance.

### Fixed

- Completed epics no longer remain stuck in `todo` status when execution is
  interrupted before reaching the cleanup phase.
- Skills install no longer fails when a non-symlink directory exists at the
  target path; it is replaced with the correct symlink automatically.

## 0.3.1

### Added

- `trekoon suggest` command for priority-ranked next-action recommendations
  based on recovery state, sync status, readiness, and epic progress.
- `trekoon epic progress <id>` subcommand returning status counts, readiness
  summary, and next candidate for an epic.
- `trekoon session --epic <id>` flag to scope session readiness to a specific
  epic.
- `--compact` output flag that strips contract metadata from TOON envelopes.
- `--owner` field on tasks and subtasks via `update --owner <name>`, with
  migration 0006 adding the `owner` column to both tables.
- Status machine with `VALID_TRANSITIONS` enforcing `todo → in_progress →
  done`, `in_progress → blocked`, `blocked → in_progress|todo`, and
  `done → in_progress`.
- `task done` auto-transitions through `in_progress` when current status is
  `todo` or `blocked`, emitting two sync events for the intermediate step.
- `task done` reports newly unblocked downstream tasks in the response.
- Open subtask warning on `task done` when subtasks remain incomplete.
- `batchResolveDependencyStatuses` domain method for single-query batch
  dependency resolution, replacing per-task N+1 lookups.
- Feature integration test suite with 827 lines covering session scoping, epic
  progress, status transitions, owner roundtrip, subtask warnings, compact
  envelopes, batch dep resolution, unblocked diffs, and suggest paths.

### Changed

- Removed `in-progress` (hyphenated) status variant; canonical status is now
  `in_progress` only.
- Sync helpers (`resolveSyncStatus`, `countAheadLocal`, `countPendingConflictsLocal`,
  `loadCursorLocal`) extracted from `session.ts` into shared `sync-helpers.ts`
  module, used by both `session` and `suggest`.
- `task done` handler optimized from two `buildTaskReadiness` calls to one,
  using lightweight reverse-dependency lookup for the pre-completion snapshot.

### Fixed

- `task done` from `todo` or `blocked` status no longer rejected by status
  machine (auto-transitions through `in_progress`).
- `suggest` command no longer recommends invalid status transitions (e.g.
  `todo → done`); suggests valid intermediate steps instead.
- TypeScript compilation error in `cli-shell.ts` where `compact` property was
  `boolean | undefined` but `RenderOptions` expected `boolean`.
- TypeScript compilation error in `output-mode.test.ts` where
  `envelope.metadata` became optional after `ToonEnvelope` change.
- Unsafe `as unknown as` type cast in `suggest.ts` replaced with spread
  operator pattern.

## 0.3.0

### Added

- Epic ID copy-to-clipboard action in the workspace header and epic rows, with
  a clipboard helper that falls back to `execCommand` when the Clipboard API is
  unavailable.
- Copy feedback UX with auto-dismiss toast notifications, copy feedback state in
  the board store, and BEM-styled toast/copy-button classes.
- `AGENTS.md` board UI guidance covering the orchestrator pattern, component
  lifecycle, delegated DOM events, and state management architecture.
- npm package metadata and keywords for registry publishing.
- Board regression coverage for the API layer, epics overview, notice toasts,
  and task modal workflows.

### Changed

- Epic row layout restructured with an extracted meta row and integrated copy
  button.
- Board Notice component refactored to use BEM toast classes for consistent
  styling.
- Board runtime is now fully self-contained with locally hosted CSS, fonts, and
  vanilla JS — no CDN dependencies, works offline after initial asset copy.
- README clarified that Bun is required as runtime even with npm global install.
- Quickstart and commands documentation updated with board workflow details and
  transactional bulk planning guidance.

### Fixed

- Copy feedback timer clearing and state reset on dismiss.
- Mutation queue creation ordering for board API calls.

## 0.2.9

### Added

- Board top bar with epic/board navigation, global search, theme toggle, and a
  storage-state explainer.
- Task inspector and modal workflow for inline task editing, dependency
  management, direct subtask creation, and compact-screen task focus.
- Subtask editor modal, destructive-action confirmation dialog, and live-region
  notices for board mutation feedback.
- URL hash syncing for selected epic/task, search, view mode, and board/epics
  screen state, including back/forward restoration and deep-link
  canonicalization.
- `PATCH /api/epics/:id/cascade` board API endpoint for atomic epic-wide status
  cascades with returned plan metadata and refreshed snapshots.
- Board regression coverage for URL state, top-bar restoration, store
  reconciliation, and atomic epic cascade behavior.

### Changed

- Board frontend was rewritten around a zero-dependency component runtime with
  delegated DOM events, extracted render helpers, reusable mount/update/unmount
  components, and locally bundled CSS/fonts.
- `app.js` now acts as a board orchestrator while shared UI behavior lives in
  focused component and state modules instead of one monolithic renderer.
- Board mutations are now serialized through a client-side queue with optimistic
  updates and rollback on failure instead of being ignored while another
  mutation is in flight.
- Board workspace controls now support epic switching, epic status editing,
  bulk task status updates, notes-panel toggling, and kanban/rows view changes.
- Board API errors now include request-scoped context, and `.woff2` assets are
  served with the correct MIME type.

### Fixed

- Epic status cascades now stay atomic across snapshot updates and emitted
  events when dependency blockers prevent completion.
- Restored board state now keeps the visible search input, selected task/epic,
  and URL history in sync after refresh, deep links, and popstate restores.

## 0.2.8

### Added

- Board UI: web-based interface for visualizing and managing epics, tasks, and
  subtasks.
- `trekoon board start` command: starts the board web server and keeps it running.
- `trekoon board open` command: opens the board in your default browser (starts
  the server if not already running).
- `trekoon board` command: shorthand that starts the server and opens the board
  in one call, with real-time sync of tracker state.
- Board server with WebSocket support for live updates and mutation streaming.
- Board components for epic/task overview, workspace navigation, search, and
  status management.
- Board state management with actions, API layer, and local store for UI state.
- Comprehensive documentation updates: README now includes board overview,
  quickstart guide expanded with board workflow, and new docs/commands.md with
  full CLI reference.

### Changed

- SKILL.md agent documentation updated with board workflow guidance.
- README restructured to surface board UI and agent onboarding flows.
- Package now includes bundled documentation in distributions.

## 0.2.7

### Added

- Descendant cascade status updates for epic/task roots via positional id plus
  `--all` and `--status done|todo`, so a whole tree can be completed or reset
  in one update call.

### Changed

- `subtask update <id> --all --status done|todo` is accepted for contract
  consistency, but because subtasks have no descendants it behaves like a
  normal single-subtask status update rather than a cascade.
- Help text, docs, and machine-readable command contracts now clarify the two
  meanings of `update --all`: bulk field application on selected rows vs.
  descendant status cascades from a positional epic/task id.
- Documentation was refactored and expanded across the README, AI agent,
  quickstart, CLI reference, and machine-contract docs, and those docs now
  ship in package distributions.

### Fixed

- Added regression coverage for blocked-descendant cascades so status updates
  stay atomic when any descendant cannot transition.

## 0.2.6

### Fixed

- `trekoon skills install` and `trekoon skills update` now write relative
  editor symlink targets instead of absolute paths, so repo-local skill links
  continue working after the repository is moved.

### Changed

- README skill-install documentation now matches the actual install/update link
  behavior, including relative symlink targets and update-time link refreshes.
- Trekoon SKILL workflow guidance now tells agents to run
  `trekoon sync pull --from main` before claiming work when `session` reports
  `behind > 0`, and clarifies that this syncs tracker events rather than git
  commits.

## 0.2.5

### Fixed

- `trekoon skills update` now auto-creates and refreshes editor symlinks for
  editors whose config directories exist (`.claude/`, `.opencode/`, `.pi/`).
  Previously it only refreshed the canonical file and passively reported link
  states, leaving editors with stale or missing links.

### Changed

- `trekoon skills update` output now reports concrete editor link actions
  (`created`, `refreshed`, `skipped_conflict`, `skipped_no_editor_dir`) instead
  of passive state labels, matching the command's active link-management
  behavior.
- Help text for `trekoon skills update` now explains automatic editor-link
  refreshes, skipped editors with no config dir, and conflict handling.

## 0.2.4

### Added

- `trekoon session` command: single-call agent orientation that returns
  diagnostics, sync status, next ready task with subtasks, blocker list, and
  readiness counts. Replaces the five-call bootstrap sequence
  (`init + sync status + task next + dep list + task show`).
- `trekoon task done <id>` subcommand: marks a task done and returns the next
  ready task with dependencies inline. Replaces the three-call task transition
  sequence (`update status + task next + dep list`).
- Shared `task-readiness.ts` module extracted from `task.ts` so `session` and
  `task done` use the same blocker/readiness logic.

### Changed

- SKILL.md agent loop updated to use `session → work → task done → repeat`.
- Quickstart and preferred agent startup flow now begin with `session`.
- Help text and command registry were updated to surface the new session flow.

### Fixed

- Corrected readiness sourcing in `session` output so blockers and next-step
  data come from the same readiness model used by task transitions.

## 0.2.3

### Fixed

- `trekoon sync status` and `trekoon sync pull` now recognize when local and
  remote refer to the same branch and avoid unnecessary conflict detection.
- Sync pull cursor advancement is preserved correctly for same-branch flows.

### Added

- `sameBranch` metadata in sync status and pull summaries for machine-readable
  branch identity reporting.

### Changed

- Sync status output is clearer and easier to read.
- Documentation now explains same-branch sync behavior and merge-sync
  handling.
- Trekoon SKILL documentation now describes valid compact-spec escaping rules,
  accepted escape sequences, and shell pitfalls for batch planning inputs.

## 0.2.2

### Fixed

- Reworked Trekoon's storage model for linked Git worktrees so shared state is
  anchored at the repository root instead of being inferred per worktree.
- Fixed sync metadata handling for worktrees by scoping metadata correctly and
  migrating older layouts forward.
- Fixed startup, init, and sync behavior when repositories contain legacy,
  split, or partially migrated storage state.

### Added

- Recovery diagnostics in `trekoon init` and shell startup so agents can see
  storage location, recovery state, and sync bootstrap issues directly.
- Recovery safeguards for ambiguous legacy layouts, WAL-backed databases, and
  backup path handling.

### Changed

- Help text, quickstart output, README, CONTRIBUTING guidance, and gitignore
  documentation now describe the shared-storage worktree model more clearly.
- `trekoon wipe` messaging now makes repository scope and safety constraints
  explicit.

## 0.2.1

### Added

- Batch planning commands for compact, task-oriented mutations:
  - `task create-many`
  - `subtask create-many`
  - `dep add-many`
  - `epic expand`
- One-shot bulk epic creation via `epic create` with repeated `--task`,
  `--subtask`, and `--dep` specs, so a full plan tree can be created without
  a pre-existing epic id.
- Temp-key based same-invocation planning for `epic expand`, including
  `@temp-key` references before UUIDs exist.
- Compact result mappings so machine consumers can translate temp keys to
  persisted task/subtask UUIDs deterministically.
- Transactional batch behavior with validation, temp-key resolution,
  dependency linking, event append ordering, and rollback on failure.
- Ordered repeated-option parsing for compact batch inputs so repeated
  `--task`, `--subtask`, and `--dep` specs are preserved exactly as provided.
- Project-local agent onboarding/help surface via `trekoon quickstart`,
  expanded command help, and `trekoon skills install|update` workflows.

### Changed

- Sync pull replay handling is hardened for canonical batch/create event
  replays, including idempotent `*.created` reprocessing when rows already
  exist locally.
- Replayed create events now keep field-level conflicts deterministic when some
  fields are withheld, avoiding follow-on bogus `__apply__` invalid conflicts.

### Notes

- Standalone `dep add-many` resolves persisted IDs only; `@temp-key` refs are
  reserved for same-invocation workflows such as `epic expand`.
- `subtask create-many` accepts a positional task id or `--task`; when both are
  present they must match exactly.

## 0.2.0

### Supported CLI surface

- Local-first Bun CLI for epics, tasks, subtasks, and dependency tracking.
- Core lifecycle commands for create/list/show/update/delete across issue types.
- Dependency graph operations with `dep add`, `dep remove`, `dep list`, and
  `dep reverse`.
- Deterministic execution helpers including `task ready` and `task next`.
- Scoped search/replace for epic, task, and subtask content.
- Machine-readable JSON/TOON output with stable command identifiers and request
  metadata.
- Sync workflows for branch/worktree coordination, conflict inspection, and
  resolution.
- Skills install/update commands for project-local agent setup.
- Migration and event-retention commands for operational maintenance.
