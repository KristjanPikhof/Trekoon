import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

export interface BranchDatabaseSnapshot {
  readonly branch: string;
  readonly path: string;
  readonly db: Database;
  close(): void;
}

export class MissingBranchDatabaseError extends Error {
  constructor(branch: string) {
    super(`Unable to read .trekoon/trekoon.db from branch '${branch}'.`);
    this.name = "MissingBranchDatabaseError";
  }
}

export function openBranchDatabaseSnapshot(branch: string, cwd: string): BranchDatabaseSnapshot {
  const show = Bun.spawnSync({
    cmd: ["git", "show", `${branch}:.trekoon/trekoon.db`],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (show.exitCode !== 0 || show.stdout.byteLength === 0) {
    throw new MissingBranchDatabaseError(branch);
  }

  const tempDir: string = mkdtempSync(join(tmpdir(), "trekoon-sync-branch-"));
  const tempDbPath: string = join(tempDir, "remote.db");

  writeFileSync(tempDbPath, show.stdout);

  const db: Database = new Database(tempDbPath);

  return {
    branch,
    path: tempDbPath,
    db,
    close(): void {
      db.close(false);
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
