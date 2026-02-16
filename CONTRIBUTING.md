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
