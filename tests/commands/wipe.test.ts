import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runWipe } from "../../src/commands/wipe";
import { openTrekoonDatabase } from "../../src/storage/database";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-wipe-command-"));
  tempDirs.push(workspace);
  return workspace;
}

function runGit(cwd: string, args: readonly string[]): string {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout: string = new TextDecoder().decode(command.stdout).trim();
  const stderr: string = new TextDecoder().decode(command.stderr).trim();

  if (command.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }

  return stdout;
}

function initializeRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# wipe test repo\n");
  runGit(workspace, ["add", "README.md"]);
  runGit(workspace, ["commit", "-m", "init repository"]);
}

function createWorktree(workspace: string): string {
  const worktreeRoot: string = `${workspace}-linked-worktree`;
  tempDirs.push(worktreeRoot);
  runGit(workspace, ["worktree", "add", worktreeRoot, "-b", "feature/wipe-safety"]);
  return worktreeRoot;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("wipe command", (): void => {
  test("warns that wipe removes repo-shared storage from a worktree", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);
    const worktree: string = createWorktree(workspace);
    const paths = resolveStoragePaths(worktree);

    const storage = openTrekoonDatabase(worktree);
    storage.close();

    const result = await runWipe({
      args: [],
      cwd: worktree,
      mode: "toon",
    });

    expect(result.ok).toBeFalse();
    expect(result.error?.code).toBe("confirmation_required");
    expect(result.human).toContain("shared repository Trekoon state");
    expect(result.human).toContain("entire repository");
    expect(result.human).toContain("other worktrees");
    expect(result.human).toContain(paths.storageDir);
    expect(result.data).toMatchObject({
      confirmed: false,
      storageDir: paths.storageDir,
      worktreeRoot: paths.worktreeRoot,
      sharedStorageRoot: paths.sharedStorageRoot,
      repoScoped: true,
    });
  });

  test("wipes the shared storage directory after explicit confirmation", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    initializeRepository(workspace);
    const worktree: string = createWorktree(workspace);
    const paths = resolveStoragePaths(worktree);

    const storage = openTrekoonDatabase(worktree);
    storage.close();
    writeFileSync(join(paths.storageDir, "marker.txt"), "shared state\n");

    const result = await runWipe({
      args: ["--yes"],
      cwd: worktree,
      mode: "toon",
    });

    expect(result.ok).toBeTrue();
    expect(result.human).toContain("shared repository Trekoon state");
    expect(result.human).toContain(paths.storageDir);
    expect(result.human).toContain(paths.sharedStorageRoot);
    expect(result.data).toMatchObject({
      storageDir: paths.storageDir,
      worktreeRoot: paths.worktreeRoot,
      sharedStorageRoot: paths.sharedStorageRoot,
      repoScoped: true,
      wiped: true,
    });
  });
});
