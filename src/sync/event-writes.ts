import { randomUUID } from "node:crypto";

import { type Database } from "bun:sqlite";

import { persistGitContext, resolveGitContext, type ResolvedGitContext } from "./git-context";

interface EventRecordInput {
  readonly entityKind: string;
  readonly entityId: string;
  readonly operation: string;
  readonly fields: Record<string, unknown>;
}

interface EventWriteContext {
  readonly git: ResolvedGitContext;
  nextTimestamp: number;
}

const transactionEventContexts: WeakMap<Database, EventWriteContext> = new WeakMap();

/**
 * Compute the next safe event timestamp INSIDE a write lock.
 *
 * Must only be called after BEGIN IMMEDIATE has been issued on `db`.
 * Reading the max(created_at) while holding the write lock guarantees no
 * concurrent writer can commit a higher timestamp between the read and the
 * subsequent INSERT, preventing (created_at, id) collisions.
 */
export function nextEventTimestamp(db: Database): number {
  const now: number = Date.now();
  const latestEvent = db
    .query(
      `
      SELECT created_at
      FROM events
      ORDER BY created_at DESC, id DESC
      LIMIT 1;
      `,
    )
    .get() as { created_at: number } | null;

  if (!latestEvent) {
    return now;
  }

  return Math.max(now, latestEvent.created_at + 1);
}

/**
 * Execute `fn` inside a transaction event context, computing the event
 * timestamp AFTER the write lock is held (i.e. after BEGIN IMMEDIATE).
 *
 * If a context is already active for this database connection (nested call),
 * `fn` is invoked directly so the outer context's monotonic counter is reused.
 *
 * @param db   - The database connection that is already inside BEGIN IMMEDIATE.
 * @param cwd  - Working directory used to resolve git context.
 * @param fn   - The transaction body to run.
 */
export function withTransactionEventContext<T>(db: Database, cwd: string, fn: () => T): T {
  const existingContext: EventWriteContext | undefined = transactionEventContexts.get(db);
  if (existingContext) {
    return fn();
  }

  // Compute the timestamp NOW — the write lock is already held.
  const nextTimestamp: number = nextEventTimestamp(db);
  const git: ResolvedGitContext = resolveGitContext(cwd, nextTimestamp);
  const context: EventWriteContext = { git, nextTimestamp };

  transactionEventContexts.set(db, context);

  try {
    return fn();
  } finally {
    transactionEventContexts.delete(db);
  }
}

/** Append a single event to the events table with git context. Returns the event ID. */
export function appendEventWithGitContext(
  db: Database,
  cwd: string,
  input: EventRecordInput,
): string {
  const context: EventWriteContext | undefined = transactionEventContexts.get(db);
  const now: number = context?.nextTimestamp ?? nextEventTimestamp(db);
  const git: ResolvedGitContext = context?.git ?? resolveGitContext(cwd, now);
  const eventId: string = randomUUID();

  persistGitContext(db, git, now);

  if (context) {
    context.nextTimestamp += 1;
  }

  db.query(
    `
    INSERT INTO events (
      id,
      entity_kind,
      entity_id,
      operation,
      payload,
      git_branch,
      git_head,
      created_at,
      updated_at,
      version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1);
    `,
  ).run(
    eventId,
    input.entityKind,
    input.entityId,
    input.operation,
    JSON.stringify({ fields: input.fields }),
    git.branchName,
    git.headSha,
    now,
    now,
  );

  return eventId;
}
