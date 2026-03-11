import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEpic } from "../../src/commands/epic";
import { runInit } from "../../src/commands/init";
import { runSync } from "../../src/commands/sync";
import { runTask } from "../../src/commands/task";
import { runWipe } from "../../src/commands/wipe";
import { openTrekoonDatabase } from "../../src/storage/database";
import { resolveStoragePaths } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-worktree-shared-"));
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

function seedRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# worktree shared state\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  runGit(workspace, ["add", "README.md", ".gitignore"]);
  runGit(workspace, ["commit", "-m", "seed repo"]);
}

function createBranchWorktree(workspace: string, branch: string): string {
  const worktreePath: string = createWorkspace();
  runGit(workspace, ["worktree", "add", "-b", branch, worktreePath, "main"]);
  return worktreePath;
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace: string | undefined = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("integration worktree shared state", (): void => {
  test("reuses one shared database across popup-fresh and sidepanel worktrees", async (): Promise<void> => {
    const workspace: string = createWorkspace();
    seedRepository(workspace);

    const initMain = await runInit({
      args: [],
      cwd: workspace,
      mode: "toon",
    });
    expect(initMain.ok).toBe(true);

    const epicCreated = await runEpic({
      cwd: workspace,
      mode: "toon",
      args: ["create", "--title", "Shared epic", "--description", "main seed"],
    });
    expect(epicCreated.ok).toBe(true);
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    const sidepanelWorktree: string = createBranchWorktree(workspace, "feature/sidepanel");
    const mainPaths = resolveStoragePaths(workspace);
    const sidepanelPaths = resolveStoragePaths(sidepanelWorktree);
    const canonicalWorkspace = mainPaths.worktreeRoot;
    const canonicalSidepanelWorktree = sidepanelPaths.worktreeRoot;

    expect(existsSync(join(sidepanelWorktree, ".trekoon"))).toBe(false);
    expect(sidepanelPaths.databaseFile).toBe(mainPaths.databaseFile);
    expect(sidepanelPaths.sharedStorageRoot).toBe(mainPaths.sharedStorageRoot);

    const initSidepanel = await runInit({
      args: [],
      cwd: sidepanelWorktree,
      mode: "toon",
    });
    expect(initSidepanel.ok).toBe(true);
    expect((initSidepanel.data as { databaseFile: string }).databaseFile).toBe(mainPaths.databaseFile);

    const sidepanelTask = await runTask({
      cwd: sidepanelWorktree,
      mode: "toon",
      args: ["create-many", "--epic", epicId, "--task", "sidepanel-task|Sidepanel task|branch state|todo"],
    });
    expect(sidepanelTask.ok).toBe(true);
    const sidepanelTaskId = (sidepanelTask.data as { tasks: Array<{ id: string }> }).tasks[0]?.id;
    expect(typeof sidepanelTaskId).toBe("string");
    const resolvedSidepanelTaskId = sidepanelTaskId ?? "";

    const popupWorktree: string = createBranchWorktree(workspace, "feature/popup-fresh");
    const popupPaths = resolveStoragePaths(popupWorktree);
    const canonicalPopupWorktree = popupPaths.worktreeRoot;

    expect(existsSync(join(popupWorktree, ".trekoon"))).toBe(false);
    expect(popupPaths.databaseFile).toBe(mainPaths.databaseFile);
    expect(popupPaths.sharedStorageRoot).toBe(mainPaths.sharedStorageRoot);

    const initPopup = await runInit({
      args: [],
      cwd: popupWorktree,
      mode: "toon",
    });
    expect(initPopup.ok).toBe(true);
    expect((initPopup.data as { databaseFile: string; sharedStorageRoot: string }).databaseFile).toBe(mainPaths.databaseFile);
    expect((initPopup.data as { databaseFile: string; sharedStorageRoot: string }).sharedStorageRoot).toBe(mainPaths.sharedStorageRoot);

    const wipeWithoutYes = await runWipe({
      args: [],
      cwd: popupWorktree,
      mode: "toon",
    });
    expect(wipeWithoutYes.ok).toBe(false);
    expect(wipeWithoutYes.error?.code).toBe("confirmation_required");
    expect(wipeWithoutYes.data).toEqual({
      confirmed: false,
      storageDir: mainPaths.storageDir,
      worktreeRoot: canonicalPopupWorktree,
      sharedStorageRoot: mainPaths.sharedStorageRoot,
      repoScoped: true,
    });
    expect(existsSync(mainPaths.storageDir)).toBe(true);

    const statusMain = await runSync({
      args: ["status", "--from", "main"],
      cwd: workspace,
      mode: "toon",
    });
    const statusSidepanel = await runSync({
      args: ["status", "--from", "main"],
      cwd: sidepanelWorktree,
      mode: "toon",
    });
    const statusPopupBefore = await runSync({
      args: ["status", "--from", "main"],
      cwd: popupWorktree,
      mode: "toon",
    });

    expect(statusMain.ok).toBe(true);
    expect(statusSidepanel.ok).toBe(true);
    expect(statusPopupBefore.ok).toBe(true);
    expect((statusPopupBefore.data as { behind: number }).behind).toBeGreaterThanOrEqual(1);
    expect((statusPopupBefore.data as { git: { worktreePath: string; branchName: string } }).git).toMatchObject({
      worktreePath: canonicalPopupWorktree,
      branchName: "feature/popup-fresh",
    });

    const pullPopup = await runSync({
      args: ["pull", "--from", "main"],
      cwd: popupWorktree,
      mode: "toon",
    });
    expect(pullPopup.ok).toBe(true);
    expect((pullPopup.data as { createdConflicts: number }).createdConflicts).toBe(0);

    const statusPopupAfter = await runSync({
      args: ["status", "--from", "main"],
      cwd: popupWorktree,
      mode: "toon",
    });
    expect(statusPopupAfter.ok).toBe(true);
    expect((statusPopupAfter.data as { behind: number }).behind).toBe(0);

    const storage = openTrekoonDatabase(popupWorktree);
    try {
      const epic = storage.db.query("SELECT id, title FROM epics WHERE id = ? LIMIT 1;").get(epicId) as {
        id: string;
        title: string;
      } | null;
      const task = storage.db.query("SELECT id, title FROM tasks WHERE id = ? LIMIT 1;").get(resolvedSidepanelTaskId) as {
        id: string;
        title: string;
      } | null;
      const gitContexts = storage.db
        .query("SELECT worktree_path, branch_name FROM git_context ORDER BY worktree_path ASC;")
        .all() as Array<{ worktree_path: string; branch_name: string }>;
      const cursors = storage.db
        .query("SELECT owner_worktree_path, source_branch FROM sync_cursors ORDER BY owner_worktree_path ASC;")
        .all() as Array<{ owner_worktree_path: string; source_branch: string }>;

      expect(epic).toEqual({ id: epicId, title: "Shared epic" });
      expect(task).toEqual({ id: resolvedSidepanelTaskId, title: "Sidepanel task" });
      expect(gitContexts).toEqual([
        { worktree_path: canonicalPopupWorktree, branch_name: "feature/popup-fresh" },
        { worktree_path: canonicalSidepanelWorktree, branch_name: "feature/sidepanel" },
        { worktree_path: canonicalWorkspace, branch_name: "main" },
      ]);
      expect(cursors).toEqual([
        { owner_worktree_path: canonicalPopupWorktree, source_branch: "main" },
        { owner_worktree_path: canonicalSidepanelWorktree, source_branch: "main" },
        { owner_worktree_path: canonicalWorkspace, source_branch: "main" },
      ]);
    } finally {
      storage.close();
    }
  });
});
