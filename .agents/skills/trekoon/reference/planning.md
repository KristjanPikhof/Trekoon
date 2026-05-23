# Planning Reference

Create executable Trekoon DAGs, not prose. Done = epic/tasks/subtasks/deps recorded, graph validated, user can run `trekoon <epic-id> execute`.

Ask planning-critical questions before writing; native question tool if available, else one concise question. Multi-select combinable choices; single-select exclusive. Preserve decisions; expand existing Trekoon items when apt.

## Inputs

Synthesize: goal/outcome; decisions/rejected options; constraints; affected paths/interfaces/workflows; verification gates/evidence; graph-blocking unknowns. If enough, plan. If not, do targeted research for discoverable facts, then ask exactly one narrow question only for a decision/unknown that still blocks graph creation.

## Model And Quality

- Epic: outcome, scope, constraints, verification gates.
- Task: subsystem/domain unit one agent can own.
- Subtask: implementation/test/verification step.
- Dependency: hard prerequisite, not preferred order.
- New entities start `todo`; never `in_progress`, `blocked`, or `done`.

Epic title: `<Product/Area>: <deliverable> to <user/system outcome> (<key constraint>)`. Desc: goal/why, in/out scope, success, risks/constraints, verification gates, decisions/research.

Task title: `[<Subsystem>] <verb> <artifact/interface> to <observable outcome>`. Desc includes target files/UI renderers, read-first, do-not-touch, acceptance/user-visible goal, tests/manual commands, integration/compat, owner/lane, parallelism (`can run in parallel with ...`/`blocked by ...`), findings.

Subtasks are imperative/specific: artifact + completion signal; inherit parent scope unless stated. No filler subtasks: skip vague checklist items like "review files", "implement changes", or "run tests" unless tied to a concrete artifact/command and completion signal.

Canonical good task desc (compact):

```text
Target files: src/auth/refresh.ts, src/auth/refresh.test.ts
Read first: src/auth/login.ts handler pattern
Do not touch: src/billing/*
Acceptance: POST /auth/refresh returns a new token pair and invalidates the old token.
Verify: bun test src/auth/refresh.test.ts
Owner: auth-lane
Can run in parallel with: billing-lane. Blocked by: task-types.
Findings: follow login.ts validation -> service -> response mapping.
```

## Delegation Graph

No dependency edge = parallel candidate. Different subsystems become lanes; same subsystem groups/sequences. Keep active lanes ~3-4 tasks. Add owners: `trekoon --toon task update <task-id> --owner <lane-name>`. Use task deps for hard prereqs; subtask deps only when task-level too coarse.

## Efficient Creation

Use `--toon`. Prefer one transactional create/expand for known graphs.

| Need | Command |
|---|---|
| New known graph | `trekoon --toon epic create ... --task ... --subtask ... --dep ...` |
| Existing additions | `trekoon --toon epic expand <epic-id> ...` |
| Many sibling tasks | `trekoon --toon task create-many --epic <epic-id> --task ...` |
| Many sibling subtasks | `trekoon --toon subtask create-many <task-id> --subtask ...` |
| Many deps | `trekoon --toon dep add-many --dep ...` |

## Compact Spec Hazards

Specs are pipe-split. Escapes: `\|` pipe, `\\` slash, `\n`/`\r`/`\t`; other `\X` invalid. Do not paste regex/shell escapes (`\?`, `\.`, `\{`, `\(`, `\[`). Rephrase exact regex/operators like `!=`.

Shapes (status optional/default `todo`; omit unless deliberate):
- `--task key|title|desc[|status]`
- `--subtask key|title|desc[|status]` for `subtask create-many`
- `--subtask parent|key|title|desc[|status]` for `epic create/expand`
- `--dep source|depends-on` = source blocked by prerequisite.

Always provide separate title and description fields. For `epic create/expand`,
`--subtask "@parent|key|long sentence"` is invalid because the long sentence is
only the title; add a fourth description field.

Pipe footguns: mid-value raw `|` shifts fields/status; `||`/multi-pipe shell fragments add fields/fail validation; trailing `|` empties desc. Preflight: `grep -nE '(^|[^\\])\|\||\|$' specs.txt`.

Bad compact spec:

```text
--task "task-docs|[Docs] verify token text|Search currentUpdatedAt|updatedAt-ms and /stream\?token=\{token\}.|todo"
```

Good compact spec:

```text
--task "task-docs|[Docs] verify token text|Search docs for currentUpdatedAt, updatedAt-ms, stream token query contract, and token parameter examples.|todo"
```

Bad subtask spec:

```text
--subtask "@task-docs|task-docs-search|Search docs for token examples and update stale wording."
```

Good subtask spec:

```text
--subtask "@task-docs|task-docs-search|Search token examples|Search docs for token examples and update stale wording."
```

Temp-key refs: same command = `@key`; later commands/`dep add-many` = real UUID. Bare refs are IDs. Prefix subtask keys; `epic create` returns `result.mappings`.

## Append, Validate, Handoff

Append notes/refinements/evidence; do not rewrite desc:

```bash
trekoon --toon task update --ids id1,id2,id3 --append "Shared verification: bun test tests/payments"
```

`epic update <id> --append` appends only to epic description. No scoped "append to all tasks in epic"; never `task update --all --append` unless every DB task is intended. Bulk append is per-row, not atomic.

After create/expand:

```bash
trekoon --toon epic progress <epic-id>
trekoon --toon suggest --epic <epic-id>
trekoon --toon task ready --epic <epic-id> --limit 50
```

Confirm counts, new tasks `todo`, first-wave ready count, blocked tasks have expected deps, sensible `suggest`, no recovery/sync issue.

User-facing execution handoff template:

````markdown
Title: <short plan title>
Description: <one-sentence what problem is solved / goal>
Epic: <full-epic-uuid>
Branch: <recommended-branch-name>

Wave 1
| Task title | Blocked by | Blocks |
|---|---|---|
| <task title> (<owner/lane>) | None | <task title> or <None> |

Wave 2
| Task title | Blocked by | Blocks |
|---|---|---|
| <task title> (<owner/lane>) | <task title> | <task title> / <None> |

Command to run:
```bash
trekoon <full-epic-id> execute
```
````

Keep the handoff compact. Include each wave needed to show hard dependencies; omit empty later waves.

## Search And Replace

Use scoped search before manual reads for repeated paths/labels/owners. Start at the narrowest valid scope, then widen only if needed: subtask search/replace, then task search/replace, then epic search/replace.

```bash
trekoon --toon epic search <epic-id> "path/to/somewhere"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path"
trekoon --toon epic replace <epic-id> --search "path/to/somewhere" --replace "path/to/new-path" --apply
```

Guardrails: literal search; narrow `--fields` when useful; preview before `--apply`; prefer scoped replace over manual edits.
