# Sync Reference

Trekoon uses one repo DB: `<sharedStorageRoot>/.trekoon/trekoon.db`; linked worktrees share it. `git checkout`/`switch` won't roll back tracker state. Sync imports cross-branch events before merge; same-branch no-ops. Never copy/commit DB.

## Before Merge

```bash
trekoon --toon sync pull --from main
trekoon --toon sync conflicts list
trekoon --toon sync conflicts show <conflict-id>
trekoon --toon sync resolve <conflict-id> --use theirs --dry-run
trekoon --toon sync resolve <conflict-id> --use ours
```

## Conflict Rules

Conflicts are field-level. Always inspect with `sync conflicts show`; `theirs` can overwrite in-progress work.

- `--use ours`: keep current DB field; mark resolved.
- `--use theirs`: write source-branch field; mark resolved.
- `--dry-run`: preview (`oursValue`, `theirsValue`, `wouldWrite`, `dryRun: true`).

Choose `ours` for completed work vs stale main/enriched desc; `theirs` for upstream/user reset. Unsure: ask.

Batch only uniform patterns; else inspect individually or narrow by `--entity`/`--field`:

```bash
trekoon --toon sync resolve --all --use ours --dry-run
trekoon --toon sync resolve --all --use ours
trekoon --toon sync resolve --all --use theirs --entity <id>
trekoon --toon sync resolve --all --use ours --entity <id> --field description
```

## Worktrees And Destructive Recovery

For worktree debugging inspect `storageMode`, `repoCommonDir`, `worktreeRoot`, `sharedStorageRoot`, `databaseFile`. Conflicts are per worktree/branch; resolving here leaves peer conflicts.

`sharedStorageRoot` is source of truth. If user explicitly requests `trekoon wipe --yes --toon`, warn it deletes shared storage for repo/linked worktrees. Wipe is destructive recovery only; never for DB/gitignore mistakes.
