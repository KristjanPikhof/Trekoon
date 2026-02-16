import { randomUUID } from "node:crypto";

import { type Database } from "bun:sqlite";

import { persistGitContext, resolveGitContext } from "./git-context";

interface EventRecordInput {
  readonly entityKind: string;
  readonly entityId: string;
  readonly operation: string;
  readonly fields: Record<string, unknown>;
}

export function appendEventWithGitContext(db: Database, cwd: string, input: EventRecordInput): string {
  const git = resolveGitContext(cwd);
  persistGitContext(db, git);

  const now: number = Date.now();
  const eventId: string = randomUUID();

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
