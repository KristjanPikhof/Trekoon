# Trekoon Code Review Reference

Use only for explicit Trekoon code-review requests: `trekoon code-review[: <scope>]` or `trekoon code-review`.

Goal: review current git changes or the named scope with a senior-engineer lens, then report actionable findings before any fixes are made.

## Flow

1. Preflight the review scope with `git status -sb`, `git diff --stat`, and the relevant `git diff` or commit range. If the diff is empty, ask whether to review staged changes, a branch/range, or a specific path.
2. Inspect related modules, tests, docs, call sites, and ownership boundaries with targeted `rg`/file reads. For large diffs, split by feature area or subsystem.
3. Review correctness first, then architecture/SOLID, removal candidates, security/reliability, performance, error handling, and boundary conditions.
4. Prefer concrete file/line findings over broad advice. Each finding needs impact, evidence, and a minimal suggested fix.
5. Keep the review read-only. Do not edit files, change Trekoon state, or implement fixes until the user explicitly asks.

## Severity

| Level | Meaning | Action |
|---|---|---|
| P0 | Critical security, data loss, or correctness blocker | Must block merge |
| P1 | High-impact bug, regression, or serious design/perf risk | Should fix before merge |
| P2 | Maintainability, reliability, or edge-case issue | Fix now or track follow-up |
| P3 | Optional polish, naming, style, or low-risk cleanup | Optional |

## Review Checklist

| Area | Look for |
|---|---|
| Correctness | Broken flows, invalid state, missing migrations, wrong API contracts, stale assumptions |
| Architecture/SOLID | Mixed responsibilities, tight coupling, wide interfaces, needless abstractions, brittle extension points |
| Removal | Dead code, duplicated paths, stale flags, unused dependencies; separate safe delete from deferred removal |
| Security/reliability | Auth gaps, injection, path traversal, secret/PII leaks, missing transactions, race conditions, unbounded work |
| Quality/performance | Swallowed errors, async failure gaps, N+1 work, hot-path CPU/memory costs, missing pagination/cache limits |
| Boundaries | Null/undefined, empty collections, numeric limits, off-by-one, invalid user input, long strings/unicode |
| Documentation | Relevant README/help/agent docs are updated when they exist, new commands or flags are documented, stale or obsolete docs/examples are removed or corrected, migration notes are present when contracts change |

## Output Format

```markdown
Code Review: <scope>
Verdict: APPROVE | REQUEST_CHANGES | COMMENT

| Severity | Count |
|---|---:|
| P0 | <n> |
| P1 | <n> |
| P2 | <n> |
| P3 | <n> |

Reviewed
| Area | Evidence |
|---|---|
| Files | <paths or count> |
| Diff | <branch/range/stat> |
| Checks | <commands run or not run> |

Findings
| Severity | Location | Issue | Fix |
|---|---|---|---|
| P1 | `path/file.ts:42` | <impact and evidence> | <minimal fix> |

Removal / Follow-Up
| Item | Recommendation |
|---|---|
| <item or None> | <safe delete now / defer with plan / no action> |

Next step:
Do you want me to fix all findings, only P0/P1, specific items, or create a Trekoon plan instead?
```

If no issues are found, say so explicitly and still include what was checked,
what was not verified, and any residual risk. Keep the summary brief; use
tables for scanning and lists only when a table would be less clear.
