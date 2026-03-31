import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { runInit } from "../../src/commands/init";

const tempDirs: string[] = [];
const originalBoardAssetRoot = process.env.TREKOON_BOARD_ASSET_ROOT;

function createWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), "trekoon-init-board-"));
  tempDirs.push(workspace);
  return workspace;
}

function initGitRepository(workspace: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: workspace, stdio: "ignore" });
}

function createBoardAssets(rootPath: string): void {
  mkdirSync(join(rootPath, "assets"), { recursive: true });
  writeFileSync(join(rootPath, "index.html"), "<html><body>board</body></html>\n", "utf8");
  writeFileSync(join(rootPath, "assets", "app.js"), "console.log('board');\n", "utf8");
}

afterEach((): void => {
  process.env.TREKOON_BOARD_ASSET_ROOT = originalBoardAssetRoot;
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("init command", (): void => {
  test("installs board assets during init", async (): Promise<void> => {
    const workspace = createWorkspace();
    const assetRoot = createWorkspace();
    createBoardAssets(assetRoot);
    process.env.TREKOON_BOARD_ASSET_ROOT = assetRoot;

    const result = await runInit({
      cwd: workspace,
      mode: "toon",
      args: [],
    });

    expect(result.ok).toBeTrue();
    expect(result.command).toBe("init");
    expect(result.human).toContain("Board assets: installed");
    const data = result.data as {
      board: {
        action: string;
        paths: { runtimeRoot: string; entryFile: string; manifestFile: string };
        manifest: { assetVersion: string; files: string[] };
      };
    };
    expect(data.board.action).toBe("installed");
    expect(data.board.paths.runtimeRoot).toContain(".trekoon/board");
    expect(data.board.manifest.files).toEqual(["assets/app.js", "index.html"]);
  });

  test("creates .trekoon/.gitignore when inside a git repository", async (): Promise<void> => {
    const workspace = createWorkspace();
    const assetRoot = createWorkspace();
    createBoardAssets(assetRoot);
    process.env.TREKOON_BOARD_ASSET_ROOT = assetRoot;
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
    const assetRoot = createWorkspace();
    createBoardAssets(assetRoot);
    process.env.TREKOON_BOARD_ASSET_ROOT = assetRoot;

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
    const assetRoot = createWorkspace();
    createBoardAssets(assetRoot);
    process.env.TREKOON_BOARD_ASSET_ROOT = assetRoot;
    initGitRepository(workspace);

    await runInit({ cwd: workspace, mode: "toon", args: [] });
    const result = await runInit({ cwd: workspace, mode: "toon", args: [] });

    expect(result.ok).toBeTrue();
    expect(result.human).toContain("Gitignore: already_exists");
    const data = result.data as { gitignore: { action: string } };
    expect(data.gitignore.action).toBe("already_exists");
  });

  test("surfaces missing board assets deterministically", async (): Promise<void> => {
    const workspace = createWorkspace();
    process.env.TREKOON_BOARD_ASSET_ROOT = join(workspace, "missing-assets");

    const result = await runInit({
      cwd: workspace,
      mode: "toon",
      args: [],
    });

    expect(result.ok).toBeFalse();
    expect(result.command).toBe("init");
    expect(result.error?.code).toBe("missing_asset");
  });
});
