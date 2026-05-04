import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runInit } from "../../src/commands/init";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-init-board-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("init command", (): void => {
  test("creates .trekoon/.gitignore when inside a git repository", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);

    const result = await runInit({ cwd: workspace, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    const gitignorePath = join(workspace, ".trekoon", ".gitignore");
    expect(existsSync(gitignorePath)).toBeTrue();
    expect(readFileSync(gitignorePath, "utf8")).toBe("*\n");
    expect(result.human).toContain("Gitignore: created");
    const data = result.data as { gitignore: { action: string; path: string } };
    expect(data.gitignore.action).toBe("created");
  });

  test("skips .trekoon/.gitignore when not inside a git repository", async (): Promise<void> => {
    const workspace = createWorkspace();

    const result = await runInit({ cwd: workspace, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    const gitignorePath = join(workspace, ".trekoon", ".gitignore");
    expect(existsSync(gitignorePath)).toBeFalse();
    expect(result.human).toContain("Gitignore: skipped");
    const data = result.data as { gitignore: { action: string } };
    expect(data.gitignore.action).toBe("skipped");
  });

  test("reports already_exists for .trekoon/.gitignore on re-init", async (): Promise<void> => {
    const workspace = createWorkspace();
    initGitRepository(workspace);

    await runInit({ cwd: workspace, mode: "toon", args: [] });
    const result = await runInit({ cwd: workspace, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    expect(result.human).toContain("Gitignore: already_exists");
    const data = result.data as { gitignore: { action: string } };
    expect(data.gitignore.action).toBe("already_exists");
  });

  test("does not include board fields in init output", async (): Promise<void> => {
    const workspace = createWorkspace();

    const result = await runInit({ cwd: workspace, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    expect(result.human).not.toContain("Board assets");
    expect(result.human).not.toContain("Board runtime root");
    const data = result.data as Record<string, unknown>;
    expect(data.board).toBeUndefined();
  });
});
