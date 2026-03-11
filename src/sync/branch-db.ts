import { spawnSync } from "node:child_process";

import { type Database } from "bun:sqlite";

import { DomainError } from "../domain/types";

export interface BranchEventRow {
  readonly id: string;
  readonly entity_kind: string;
  readonly entity_id: string;
  readonly operation: string;
  readonly payload: string;
  readonly git_branch: string | null;
  readonly git_head: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly version: number;
}

interface ParsedCursorToken {
  readonly createdAt: number;
  readonly id: string | null;
}

function parseCursorToken(token: string): ParsedCursorToken {
  const [createdAtRaw, idRaw] = token.split(":");
  const createdAt: number = Number.parseInt(createdAtRaw ?? "0", 10);

  return {
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    id: idRaw && idRaw.length > 0 ? idRaw : null,
  };
}

export function assertValidSourceRef(workingDirectory: string, sourceRef: string): void {
  const verification = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${sourceRef}^{commit}`], {
    cwd: workingDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (verification.status === 0) {
    return;
  }

  throw new DomainError({
    code: "invalid_source",
    message: `Source ref '${sourceRef}' was not found.`,
    details: {
      status: "invalid_source",
      sourceBranch: sourceRef,
      operatorAction: `Verify '${sourceRef}' exists with git rev-parse --verify --quiet ${sourceRef}^{commit} and rerun sync.`,
    },
  });
}

export function queryBranchEventsSince(db: Database, branch: string, cursorToken: string): BranchEventRow[] {
  const cursor = parseCursorToken(cursorToken);

  return db
    .query(
      `
      SELECT id, entity_kind, entity_id, operation, payload, git_branch, git_head, created_at, updated_at, version
      FROM events
      WHERE git_branch = @branch
        AND (
          created_at > @createdAt
          OR (created_at = @createdAt AND id > @id)
        )
      ORDER BY created_at ASC, id ASC;
      `,
    )
    .all({
      "@branch": branch,
      "@createdAt": cursor.createdAt,
      "@id": cursor.id ?? "",
    }) as BranchEventRow[];
}

export function countBranchEventsSince(db: Database, branch: string, cursorToken: string): number {
  const cursor = parseCursorToken(cursorToken);
  const row = db
    .query(
      `
      SELECT COUNT(*) AS count
      FROM events
      WHERE git_branch = @branch
        AND (
          created_at > @createdAt
          OR (created_at = @createdAt AND id > @id)
        );
      `,
    )
    .get({
      "@branch": branch,
      "@createdAt": cursor.createdAt,
      "@id": cursor.id ?? "",
    }) as { count: number } | null;

  return row?.count ?? 0;
}
