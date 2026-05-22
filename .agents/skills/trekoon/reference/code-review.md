# Code Review Reference

Use only for explicit code-review requests: `trekoon code-review[: <scope>]` or `trekoon code-review`.

Goal: review current development changes or the named scope with a senior-engineer lens, then report actionable findings before any fixes are made.

## Flow

1. Default to reviewing current branch changes when they exist. Preflight with `git status -sb`, find the merge base against `main`/`origin/main` when available, then inspect `git diff --stat <base>...HEAD` and the relevant diff. If no branch diff exists, ask whether to review staged changes, unstaged changes, a branch/range, or a specific path.
2. Inspect related modules, tests, docs, call sites, and ownership boundaries with targeted `rg`/file reads. For large diffs, split by feature area or subsystem.
3. Focus on issues introduced or worsened by the reviewed diff. Mention pre-existing problems only when the diff depends on them, exposes them, or makes them worse.
4. Review correctness first, then general engineering principles: concurrency/async safety, architecture/SOLID, API compatibility, security/reliability, performance/memory, error handling, boundary conditions, documentation, and removal candidates.
5. Prefer concrete file/line findings over broad advice. Each finding needs impact, evidence, confidence, and a minimal suggested fix.
6. In multi-agent reviews, merge overlapping findings and show reviewer agreement when available.
7. Keep the review read-only. Do not edit files, change Trekoon state, or implement fixes until the user explicitly asks.

## Severity

| Level | Meaning | Action |
|---|---|---|
| P0 | Critical security, data loss, or correctness blocker | Must block merge |
| P1 | High-impact bug, regression, or serious design/perf risk | Should fix before merge |
| P2 | Maintainability, reliability, or edge-case issue | Fix now or track follow-up |
| P3 | Optional polish, naming, style, or low-risk cleanup | Optional |

## Confidence

| Label | Meaning |
|---|---|
| definite | Directly supported by the diff and surrounding code |
| likely | Strong signal, but some runtime or product context may matter |
| possible | Plausible concern worth checking, not strong enough to block by itself |

## Review Checklist

| Area | Look for |
|---|---|
| Correctness | Broken flows, invalid state, missing migrations, wrong API contracts, stale assumptions |
| Concurrency/async | Races, stale reads then writes, missing awaits, unhandled promises/tasks, cancellation gaps, unsafe shared state, ordering assumptions, partial updates |
| Architecture/SOLID | Mixed responsibilities, tight coupling, wide interfaces, needless abstractions, brittle extension points, design choices that increase defect risk |
| API compatibility | Request/response schema drift, serialization mismatches, changed semantics without migration/versioning, downstream caller breaks |
| Security/reliability | Auth gaps, injection, path traversal, secret/PII leaks, missing transactions, race conditions, unbounded work |
| Performance/memory | N+1 work, hot-path CPU cost, blocking IO, repeated parsing/serialization, unbounded caches/queues/buffers, retention/leak risks |
| Quality/errors | Swallowed errors, async failure gaps, missing timeouts/backoff/idempotency, cleanup gaps, missing observability for new failure modes |
| Boundaries | Null/undefined, empty collections, numeric limits, off-by-one, invalid user input, long strings/unicode |
| Documentation | Relevant README/help/agent docs are updated when they exist, new commands or flags are documented, stale or obsolete docs/examples are removed or corrected, migration notes are present when contracts change |
| Removal | Dead code, duplicated paths, stale flags, unused dependencies; separate safe delete from deferred removal |

Do not claim measured performance, memory, or concurrency regressions without
evidence. Without measurements, use wording such as `likely`, `possible`, or
`unbounded growth risk`.

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
| Severity | Confidence | Agreement | Location | Issue | Fix |
|---|---|---:|---|---|---|
| P1 | definite | 2/3 reviewers | `path/file.ts:42` | <impact and evidence> | <minimal fix> |

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
