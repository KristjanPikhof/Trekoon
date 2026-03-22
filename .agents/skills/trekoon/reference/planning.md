# Planning Reference

Write implementation plans directly into Trekoon as epics with task/subtask
DAGs. Plans must be directly executable without re-interpretation.

**Clarify ambiguity upfront.** If the plan has unclear requirements or meaningful
tradeoffs, ask the user before writing. Present options with clear tradeoffs.
Use multi-select for independent features that can be combined; use single-select
for mutually exclusive choices.

## Planning data model

- **Epic** = full feature outcome and constraints.
- **Task** = one complete subsystem/domain work unit that can be owned by one
  agent.
- **Subtask** = concrete implementation/test/verification step under a task.
- **Dependency edge** = strict prerequisite only (do not add "nice to have"
  dependencies).

All entities start in `todo`. See the status machine in the main SKILL.md.

Plan implications:
- Never set initial status to anything other than `todo` in create commands.
- Task descriptions should reference valid transitions when documenting
  completion flow (e.g., "todo -> in_progress -> done", not "todo -> done").
- `task done` auto-transitions through `in_progress`, but `task update` does
  not — plan descriptions should note this for agents.

## Information-dense writing standard

### Epic title

Use a functional, outcome-oriented format:

`<Product/Area>: <deliverable> to <user/system outcome> (<key constraint>)`

Example: `Checkout: add idempotent payment capture to prevent duplicate charges
(Stripe + retries)`

### Epic description

Include:

1. **Goal & why now**
2. **In scope** (specific capabilities)
3. **Out of scope** (explicit exclusions)
4. **Success criteria** (testable outcomes)
5. **Risks/constraints** (data migration, latency budgets, auth boundaries)
6. **Verification gates** (tests, manual checks, perf/security checks)

### Task title

Use a structure that encodes subsystem + action + outcome:

`[<Subsystem>] <verb> <artifact/interface> to <observable outcome>`

Example: `[API/Auth] issue refresh-token rotation endpoint to invalidate
replayed sessions`

### Task description

Must include:

- concrete scope and affected paths/symbols
- acceptance criteria (observable behavior)
- required tests/verification commands
- integration constraints (contracts, backward compatibility)
- explicit "can run in parallel with ..." or "blocked by ..." note

**File scope** — declare explicitly so the agent doesn't waste tokens exploring:

- **Target files**: files to create or modify
- **Read-first files**: files the agent should read for context
- **Do-not-touch**: paths that parallel agents own — prevents merge conflicts

**Context loading hints** — point the agent to existing patterns:

- Reference a concrete file as the pattern to mirror
- Name the specific function/class/export to extend or integrate with
- State project conventions rather than assuming the agent will discover them

**Owner assignment** — when the plan has clear subsystem lanes, assign owners in
task descriptions so the executor knows which agent/person owns each task:

```
Owner: auth-lane
Can run in parallel with: billing-lane tasks
```

Example task description:

```
Implement refresh-token rotation endpoint.

Target files: src/auth/refresh.ts (new), src/auth/refresh.test.ts (new)
Read first: src/auth/login.ts (follow same handler pattern)
Do not touch: src/billing/* (owned by billing-lane)

Follow the handler pattern in login.ts: schema validation -> service call ->
response mapping.

Acceptance: POST /auth/refresh returns new token pair, invalidates old token.
Verify: bun test src/auth/refresh.test.ts
Owner: auth-lane
Can run in parallel with: billing-lane. Blocked by: task-types (needs AuthToken).
```

### Subtask title/description

- Titles are imperative and specific, not generic.
- Description states exact artifact and completion signal.
- Use subtasks for real units, not filler checklist noise.
- Inherit file scope from parent task — only override if different files.

## Parallelism & dependencies

Model execution lanes intentionally:

- Tasks with no dependency edge between them are parallel candidates.
- Tasks in different subsystems should usually run in parallel.
- Tasks in the same subsystem should be combined or sequenced.
- Keep task groups to ~3-4 tasks per active subsystem lane.

Dependency policy:

1. Add an edge only for hard prerequisites.
2. Prefer task-to-task dependencies; use subtask dependencies only when required.
3. Validate acyclic graph assumptions before finalizing.

## Assign owners after creation

After creating tasks, assign ownership for multi-agent execution:

```bash
trekoon --toon task update <task-id> --owner auth-lane
trekoon --toon task update <task-id> --owner billing-lane
```

## Validate the plan

After creating the epic, validate before handing off to execution.

### Check progress structure

```bash
trekoon --toon epic progress <epic-id>
```

Verify: total count matches expectations, all tasks are in `todo`, ready count
equals the number of tasks with no dependencies.

### Run suggest to confirm sanity

```bash
trekoon --toon suggest --epic <epic-id>
```

`suggest` will surface issues: sync gaps, recovery needs, or unexpected blocker
states. If it suggests claiming a task, the plan's dependency graph is valid and
execution-ready.

### Verify dependency graph

```bash
trekoon --toon task ready --epic <epic-id> --limit 50
```

Confirm that the expected first-wave tasks appear as ready candidates and
second-wave tasks appear as blocked with the right dependencies.

## Plan output and handoff

After creating the epic and validating, present a summary to the user. This
summary is the primary handoff artifact — it must be self-contained and
actionable.

### ID rules

- **Always use full UUIDs** for epic and task IDs. Never use temp-keys
  (`task-truthy`, `@task-api`, etc.) in the summary — those are ephemeral
  creation-time references that do not exist in the database.
- IDs must be copy-friendly: render them in monospace/code formatting so the
  user can select and copy a UUID directly.

### Summary structure

1. **Epic ID + title** — displayed prominently at the top, e.g.:
   ```
   Epic: <full-uuid>
   Title: <epic title>
   ```
2. Tasks grouped by wave/batch with columns: full UUID, title, owner/lane
3. Dependencies shown per task (using full UUIDs or task titles, not temp-keys)
4. Verification gate (commands to run after all tasks complete)

### Example format

```
Epic: 904b3129-be2d-4b20-8030-537dc327491a
Title: Checkout: add idempotent payment capture

Wave 1 (parallel)
| ID                                   | Task                          | Owner        |
|--------------------------------------|-------------------------------|--------------|
| c12c9746-dbae-4660-bcbb-ebe660cb7054 | [API] Payment capture endpoint| api-lane     |
| 4f0848f3-538a-44d3-8415-5bb16cf3f39e | [UI] Checkout button states   | ui-lane      |

Wave 2 (depends on wave 1)
| ID                                   | Task                          | Depends on                           |
|--------------------------------------|-------------------------------|--------------------------------------|
| 8a76afac-155d-45b3-b205-df2e4ef8988b | [API] Retry logic             | c12c9746-dbae-4660-bcbb-ebe660cb7054 |

Verification: bun run build && bun run test
```

### Execution handoff contract

Every plan must be directly executable without re-interpretation. Include these
in task descriptions:

1. **Lane/subsystem ownership** (`[Subsystem] ...` in title, `--owner` set).
2. **Dependency intent** (explicit `blocked by ...` / `can run in parallel
   with ...`).
3. **Verification evidence** (exact commands and expected outcome).
4. **Completion semantics** (`done` means verified and handoff-ready; use
   `blocked` with reason when not).
5. **Stable contract** (execution appends progress notes rather than rewriting
   original plan text unless the plan itself is wrong).

## Quality rules

1. **No markdown plan files** as source of truth.
2. **No vague titles** ("Refactor stuff", "Fix bugs").
3. **Descriptions must be implementation-usable** by another agent without
   guessing.
4. **Every task must define completion evidence** (tests/manual checks).
5. **Parallelism must be explicit** (not implied).
6. **Status transitions must be valid** — never describe a `todo -> done` flow.
7. **Owners should be assigned** when multiple execution lanes exist.

## Large initiatives

For large scope, create multiple epics with explicit cross-epic boundaries. Use
dependencies within each epic DAG and keep each epic executable in bounded time.
