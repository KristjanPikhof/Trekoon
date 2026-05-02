/**
 * Statuses for which transitioning a node requires upstream dependencies to be
 * resolved. Originally duplicated as a private const in both `cascade-planner`
 * and `tracker-domain`; centralized here so a single edit updates every gating
 * site at once.
 *
 * If you add a new gated status (e.g. another forward-progress state), add it
 * here only — do NOT redeclare this Set in another module. The cr-expert audit
 * called out the duplication; keeping a single source-of-truth prevents future
 * drift between gating callsites.
 */
export const DEPENDENCY_GATED_STATUSES: ReadonlySet<string> = new Set<string>([
  "in_progress",
  "done",
]);
