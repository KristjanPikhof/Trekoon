# Sync Reference

## Sync reminders

Same-branch sync is a no-op: `sync pull --from main` while on `main` produces
zero conflicts and simply advances the cursor. `sync status` returns `behind=0`
on the source branch. No action is needed.

Cross-branch sync matters before merging a feature branch back:

- Before merge, pull tracker events from the base branch:

  ```bash
  trekoon --toon sync pull --from main
  ```

- If conflicts exist, inspect and resolve them explicitly:

  ```bash
  trekoon --toon sync conflicts list
  trekoon --toon sync conflicts show <conflict-id>
  trekoon --toon sync resolve <conflict-id> --use theirs --dry-run
  trekoon --toon sync resolve <conflict-id> --use ours
  ```

### Conflict resolution: ours vs theirs

Conflicts are **field-level**, not whole-record. Each conflict targets one field
(e.g., `status`, `title`, `description`) on one entity.

- `--use ours` — keep the current entity field value in the shared DB. The
  entity is not written, but the conflict record is marked resolved and a
  resolution event is appended.
- `--use theirs` — overwrite the shared DB entity field with the source-branch
  value. The conflict record is marked resolved and a resolution event is
  appended.
- `--dry-run` — preview the resolution without mutating the database. Returns
  `oursValue`, `theirsValue`, `wouldWrite`, and `dryRun: true`. Use this before
  committing to a resolution.

**Example:** after `sync pull --from main`, a conflict appears on epic `abc123`,
field `status`:
- ours (current DB): `in_progress`
- theirs (source branch): `done`
- `--use ours` keeps status as `in_progress`
- `--use theirs` changes status to `done` in the live shared DB

Always inspect conflicts with `sync conflicts show` before resolving. Choosing
`theirs` without inspection can overwrite in-progress work in the shared DB.

### Understanding why conflicts happen

| Scenario | Typical resolution | Why |
|---|---|---|
| Completed work vs stale main state | ours | Your branch has the latest progress |
| Enriched descriptions vs original | ours | Your descriptions are more detailed |
| Upstream updates from another agent | theirs | Accept the newer upstream state |
| User-intentional reset | theirs | Respect the user's explicit action |

### Agent decision framework

1. List conflicts: `trekoon --toon sync conflicts list`
2. Group by pattern — are conflicts on the same field or direction?
3. If uniform pattern, batch resolve: `trekoon --toon sync resolve --all --use ours`
4. If mixed, narrow by entity or field, or inspect individually
5. When unsure, ask the user

### Batch resolve patterns

Common scenarios:

```bash
# Resolve all conflicts at once (most common after completing work)
trekoon --toon sync resolve --all --use ours

# Preview before resolving
trekoon --toon sync resolve --all --use ours --dry-run

# Narrow to status field conflicts only
trekoon --toon sync resolve --all --use ours --field status

# Narrow to a specific entity
trekoon --toon sync resolve --all --use theirs --entity <id>

# Combine filters
trekoon --toon sync resolve --all --use ours --entity <id> --field description
```

## Shared-database model

Trekoon uses **one live SQLite database per repository**. The file lives at
`<sharedStorageRoot>/.trekoon/trekoon.db`, where `sharedStorageRoot` is the
parent of `git rev-parse --git-common-dir` (i.e., the main worktree root).

Key consequences:

- **All linked worktrees share the same database.** A status change in one
  worktree is immediately visible in every other worktree.
- **`git checkout` / `git switch` does not change tracker state.** The database
  is outside the git object store, so switching branches does not roll back or
  swap task data.
- **Sync operates on tracker events, not on the database file itself.** Use
  `sync pull` to import events between branches — never copy or commit the
  `.db` file.

Treat every write as a mutation of shared repo-wide state, not branch-scoped
state.

**Conflicts are scoped per worktree + branch.** `sync_conflicts` rows are
recorded with the originating worktree path and current branch, so resolving a
conflict in one worktree never erases a peer worktree's conflict on the same
entity. `sync conflicts list` and `sync resolve` from a given worktree only
see and act on rows scoped to that worktree's branch.

## Worktree diagnostics and destructive scope

- Inspect machine-readable storage fields when debugging worktrees:
  `storageMode`, `repoCommonDir`, `worktreeRoot`, `sharedStorageRoot`, and
  `databaseFile`.
- `sharedStorageRoot` is the repo-scoped source of truth for `.trekoon` in git
  worktrees.
- If `trekoon wipe --yes --toon` is explicitly requested, warn that it deletes
  shared storage for the entire repository and every linked worktree.
- Wipe is destructive recovery only; it is never the right fix for a tracked DB
  or gitignore mistake.

Trekoon stores local state in `.trekoon/trekoon.db`. In git repos and
worktrees, storage resolves from the shared repository root rather than each
worktree independently.
