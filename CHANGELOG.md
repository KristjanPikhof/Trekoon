# Changelog

All notable changes to Trekoon are documented in this file.

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
