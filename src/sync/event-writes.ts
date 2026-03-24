import { randomUUID } from "node:crypto";

import { type Database } from "bun:sqlite";

import { persistGitContext, resolveGitContext } from "./git-context";

interface EventRecordInput {
  readonly entityKind: string;
  readonly entityId: string;
  readonly operation: string;
  readonly fields: Record<string, unknown>;
}

function nextEventTimestamp(db: Database): number {
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

export function appendEventWithGitContext(
  db: Database,
  cwd: string,
  input: EventRecordInput,
): void {
  const git = resolveGitContext(cwd);
  persistGitContext(db, git);

  const now: number = nextEventTimestamp(db);

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
    randomUUID(),
    input.entityKind,
    input.entityId,
    input.operation,
    JSON.stringify({ fields: input.fields }),
    git.branchName,
    git.headSha,
    now,
    now,
  );
}
