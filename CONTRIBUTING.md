# Contributing to Trekoon

## No-copy implementation policy

Trekoon is implemented in this repository root. The `trekker/` directory is
reference-only.

- Do not copy code or files from `trekker/` into root `src/`.
- Do not mirror file layout one-to-one from `trekker/`.
- Write root implementation code directly, with Trekoon-native structure.

## PR checklist

- [ ] Any new logic was written directly in root project files.
- [ ] Changes were reviewed for suspiciously identical blocks/comments versus
      `trekker/` reference code.
- [ ] Sync-related writes preserve git context (`branch`, `head`, `worktree`).
- [ ] README command/flag examples match actual implemented CLI behavior.
- [ ] Docs and help text describe one repo-shared `.trekoon/trekoon.db` across
      linked worktrees.
- [ ] Docs fail fast on bootstrap/storage mismatch states instead of suggesting
      a continue-anyway fallback.
- [ ] `.trekoon` remains gitignored and no SQLite DB snapshots were committed as
      a workaround.
- [ ] Any wipe guidance states that `trekoon wipe --yes` deletes shared storage
      for the whole repo, not only the current worktree.

## Trekoon storage contract

- In git repos and worktrees, Trekoon resolves storage from the repository's
  shared root, not from each worktree independently.
- `meta.storageRootDiagnostics` is the source of truth for
  `storageMode`, `repoCommonDir`, `worktreeRoot`, `sharedStorageRoot`, and
  `databaseFile` during debugging.
- If bootstrap reports `recoveryRequired`, a tracked/ignored mismatch, or an
  ambiguous recovery path, stop and repair setup before continuing.
- Never commit `.trekoon/trekoon.db` to fix a worktree problem; re-bootstrap or
  follow the reported recovery path instead.
