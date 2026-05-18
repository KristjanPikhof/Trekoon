# Autoresearch: compress Trekoon skill instructions

## Objective
Aggressively compress `/Users/kristjan.pikhof/.agents/skills/trekoon/` while preserving Trekoon skill behavior for planning, orchestrated execution kickoff, sync/recovery/status safety, destructive guardrails, and multi-harness support (Pi, Claude Code, Codex, OpenCode). Target about 40% fewer words versus the 5,372-word baseline.

## Metrics
- **Primary**: total_words (words, lower is better) across `SKILL.md` and `reference/*.md`.
- **Secondary**: file word counts, safety keyword counts.
- **Hard gate**: skip-research eval first-response behavior must score no hard fails, total >=46/54, execution kickoff >=12/16, sync/safety >=8/10.

## How to Run
`./autoresearch.sh` — outputs `METRIC total_words=<n>` and per-file counts. Re-seed eval with:
`cd /tmp/trekoon-skill-eval-pi-agents-team/Pi-Agents-Team && ./trekoon-skill-eval/scripts/seed-trekoon-eval.sh --mode skip-research --reset`.
Then score a fresh agent's first Trekoon-skill response to `trekoon-skill-eval/prompts/execution-kickoff.md` against `trekoon-skill-eval/rubric.md`.

## Files in Scope
- `/Users/kristjan.pikhof/.agents/skills/trekoon/SKILL.md` — router + non-negotiables.
- `/Users/kristjan.pikhof/.agents/skills/trekoon/reference/*.md` — planning/execution/sync/status/harness details.

## Off Limits
- Trekoon source code.
- The eval sandbox except reset/seed state.
- `.trekoon/trekoon.db` direct edits.

## Constraints
Preserve planning workflow, orchestrated subagent execution, sync/recovery/status machine behavior, destructive-operation guardrails, and agent-optimized instructions. Do not remove safety-critical rules just to reduce tokens. Do not overfit to the eval prompt.

## What's Been Tried
- Baseline: 5,372 total words in skill files.
