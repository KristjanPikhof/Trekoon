import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runEpic } from "../../src/commands/epic";
import { runSession } from "../../src/commands/session";
import { runTask } from "../../src/commands/task";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-session-"));
  tempDirs.push(workspace);
  return workspace;
}

function runGit(cwd: string, args: readonly string[]): void {
  const command = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (command.exitCode !== 0) {
    const stderr = new TextDecoder().decode(command.stderr).trim();
    throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  }
}

function initializeRepository(workspace: string): void {
  runGit(workspace, ["init", "-b", "main"]);
  runGit(workspace, ["config", "user.email", "tests@trekoon.local"]);
  runGit(workspace, ["config", "user.name", "Trekoon Tests"]);
  writeFileSync(join(workspace, "README.md"), "# test repo\n");
  writeFileSync(join(workspace, ".gitignore"), ".trekoon/\n");
  runGit(workspace, ["add", "README.md", ".gitignore"]);
  runGit(workspace, ["commit", "-m", "init repository"]);
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const workspace = tempDirs.pop();
    if (workspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

describe("session command", (): void => {
  test("returns ok with diagnostics, sync, next and deps when tasks exist in git repo", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const epicCreated = await runEpic({
      cwd,
      mode: "toon",
      args: ["create", "--title", "Roadmap", "--description", "desc"],
    });
    const epicId = (epicCreated.data as { epic: { id: string } }).epic.id;

    await runTask({
      cwd,
      mode: "toon",
      args: ["create", "--epic", epicId, "--title", "First task", "--description", "do it", "--status", "todo"],
    });

    const result = await runSession({ cwd, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();

    const data = result.data as {
      diagnostics: {
        storageMode: string;
        recoveryRequired: boolean;
        recoveryStatus: string;
      };
      sync: {
        ahead: number;
        behind: number;
        pendingConflicts: number;
        git: { branchName: string | null };
      };
      next: { id: string; title: string; status: string } | null;
      nextDeps: unknown[];
      readiness: { readyCount: number; blockedCount: number };
    };

    expect(data.diagnostics).toBeDefined();
    expect(typeof data.diagnostics.storageMode).toBe("string");
    expect(typeof data.diagnostics.recoveryRequired).toBe("boolean");
    expect(typeof data.diagnostics.recoveryStatus).toBe("string");

    expect(data.sync).toBeDefined();
    expect(typeof data.sync.ahead).toBe("number");
    expect(typeof data.sync.behind).toBe("number");
    expect(typeof data.sync.pendingConflicts).toBe("number");
    expect(data.sync.git).toBeDefined();

    expect(data.next).not.toBeNull();
    expect(data.next?.title).toBe("First task");
    expect(data.next?.status).toBe("todo");

    expect(Array.isArray(data.nextDeps)).toBeTrue();

    expect(data.readiness.readyCount).toBeGreaterThanOrEqual(1);
    expect(data.readiness.blockedCount).toBeGreaterThanOrEqual(0);

    expect(result.human).toContain("=== Session ===");
    expect(result.human).toContain("=== Sync ===");
    expect(result.human).toContain("=== Next Task ===");
  });

  test("returns ok with null next when no tasks exist", async (): Promise<void> => {
    const cwd = createWorkspace();
    initializeRepository(cwd);

    const result = await runSession({ cwd, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();

    const data = result.data as {
      next: unknown;
      readiness: { readyCount: number; blockedCount: number };
    };

    expect(data.next).toBeNull();
    expect(data.readiness.readyCount).toBe(0);
    expect(data.readiness.blockedCount).toBe(0);

    expect(result.human).toContain("No ready tasks.");
  });

  test("works in non-git directory and still returns diagnostics", async (): Promise<void> => {
    const cwd = createWorkspace();
    // No git init — plain temp directory

    const result = await runSession({ cwd, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();

    const data = result.data as {
      diagnostics: {
        storageMode: string;
        recoveryRequired: boolean;
        recoveryStatus: string;
      };
      sync: {
        git: { branchName: string | null };
      };
      next: unknown;
    };

    expect(data.diagnostics).toBeDefined();
    expect(typeof data.diagnostics.storageMode).toBe("string");

    // In a non-git directory the branch name should be null
    expect(data.sync.git.branchName).toBeNull();

    expect(data.next).toBeNull();
  });
});
