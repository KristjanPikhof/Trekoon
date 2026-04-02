import { type Database } from "bun:sqlite";

import { resolveStoragePaths } from "../storage/path";
import { type GitContextSnapshot } from "./types";

export interface ResolvedGitContext extends GitContextSnapshot {
  readonly persistedAt: number;
}

function runGit(args: readonly string[], cwd: string): string | null {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (command.exitCode !== 0) {
    return null;
  }

  const output: string = new TextDecoder().decode(command.stdout).trim();
  return output.length > 0 ? output : null;
}

export function resolveGitContext(cwd: string, persistedAt: number = Date.now()): ResolvedGitContext {
  const storagePaths = resolveStoragePaths(cwd);
  const branchName: string | null = runGit(["branch", "--show-current"], cwd);
  const headSha: string | null = runGit(["rev-parse", "HEAD"], cwd);

  return {
    worktreePath: storagePaths.worktreeRoot,
    branchName,
    headSha,
    persistedAt,
  };
}

export function persistGitContext(db: Database, git: GitContextSnapshot, persistedAt: number = Date.now()): void {

  db.query(
    `
    INSERT INTO git_context (
      id,
      metadata_scope,
      worktree_path,
      branch_name,
      head_sha,
      created_at,
      updated_at,
      version
    ) VALUES (
      @worktreePath,
      'worktree',
      @worktreePath,
      @branchName,
      @headSha,
      @persistedAt,
      @persistedAt,
      1
    )
    ON CONFLICT(id) DO UPDATE SET
      metadata_scope = excluded.metadata_scope,
      worktree_path = excluded.worktree_path,
      branch_name = excluded.branch_name,
      head_sha = excluded.head_sha,
      updated_at = excluded.updated_at,
      version = git_context.version + 1;
    `,
  ).run({
    "@worktreePath": git.worktreePath,
    "@branchName": git.branchName,
    "@headSha": git.headSha,
    "@persistedAt": persistedAt,
  });
}
