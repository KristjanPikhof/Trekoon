# Trekoon Brainstorming Reference

Use only for explicit Trekoon brainstorming requests: `trekoon brainstorm: <topic>`, `trekoon brainstorming: <topic>`, or `/trekoon brainstorming: <topic>`.

Goal: turn a rough topic into an accepted lean design before any Trekoon planning entities are created.

## Flow

1. Investigate repo/docs/Trekoon context first; do not ask what can be discovered.
2. Ask one focused question at a time, preferably multiple choice and via the native question tool when available.
3. Explore 2-3 approaches, recommend the simplest viable one, and call out trade-offs/risks.
4. Present the design incrementally and validate each section with the user.
5. Do **not** create/update Trekoon epics, tasks, subtasks, deps, or status during brainstorming.
6. Only after the user accepts the design, load `reference/harness-primitives.md` + `reference/planning.md` and create the implementation plan.

## Output During Brainstorming

Keep responses compact: known context, current design slice, open decision, and next question/confirmation. Preserve accepted decisions so planning can convert them directly into Trekoon DAG inputs later.
