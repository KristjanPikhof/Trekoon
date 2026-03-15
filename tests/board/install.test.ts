import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { ensureBoardInstalled, updateBoardInstallation } from "../../src/board/install";
import { BOARD_ASSET_CONTRACT_VERSION } from "../../src/board/types";
import { resolveStoragePaths, TREKOON_BOARD_ENTRY_FILENAME } from "../../src/storage/path";

const tempDirs: string[] = [];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-"));
  tempDirs.push(workspace);
  return workspace;
}

function createBundledAssets(rootPath: string): void {
  mkdirSync(join(rootPath, "static"), { recursive: true });
  writeFileSync(join(rootPath, "index.html"), "<html><body>board</body></html>\n", "utf8");
  writeFileSync(join(rootPath, "static", "app.js"), "console.log('board');\n", "utf8");
}

afterEach((): void => {
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("board install", (): void => {
  test("installs into shared .trekoon/board and reruns idempotently", (): void => {
    const workspace: string = createWorkspace();
    const bundledAssetRoot: string = join(workspace, "bundled-assets");
    createBundledAssets(bundledAssetRoot);

    const first = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.2.3",
    });

    const paths = resolveStoragePaths(workspace);
    expect(first.action).toBe("installed");
    expect(first.paths.runtimeRoot).toBe(paths.boardDir);
    expect(first.paths.entryFile).toBe(paths.boardEntryFile);
    expect(first.paths.manifestFile).toBe(paths.boardManifestFile);
    expect(dirname(paths.databaseFile)).toBe(dirname(paths.boardDir));
    expect(readFileSync(paths.boardEntryFile, "utf8")).toContain("board");

    const manifest = JSON.parse(readFileSync(paths.boardManifestFile, "utf8")) as {
      contractVersion: string;
      assetVersion: string;
      entryFile: string;
      files: string[];
      assetDigest: string;
    };
    expect(manifest).toEqual({
      contractVersion: BOARD_ASSET_CONTRACT_VERSION,
      assetVersion: "1.2.3",
      entryFile: TREKOON_BOARD_ENTRY_FILENAME,
      files: ["index.html", "static/app.js"],
      assetDigest: expect.any(String),
    });

    const second = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.2.3",
    });

    expect(second.action).toBe("unchanged");
    expect(readFileSync(paths.boardManifestFile, "utf8")).toContain('"assetVersion": "1.2.3"');
  });

  test("reinstalls when a runtime asset is missing", (): void => {
    const workspace: string = createWorkspace();
    const bundledAssetRoot: string = join(workspace, "bundled-assets");
    createBundledAssets(bundledAssetRoot);

    const initial = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.2.3",
    });

    unlinkSync(initial.paths.entryFile);
    expect(existsSync(initial.paths.entryFile)).toBeFalse();

    const reinstalled = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.2.3",
    });

    expect(reinstalled.action).toBe("reinstalled");
    expect(readFileSync(reinstalled.paths.entryFile, "utf8")).toContain("board");
  });

  test("updates when manifest version no longer matches bundled assets", (): void => {
    const workspace: string = createWorkspace();
    const bundledAssetRoot: string = join(workspace, "bundled-assets");
    createBundledAssets(bundledAssetRoot);

    const initial = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.0.0",
    });

    writeFileSync(
      initial.paths.manifestFile,
      `${JSON.stringify(
        {
          contractVersion: BOARD_ASSET_CONTRACT_VERSION,
          assetVersion: "0.9.0",
          entryFile: TREKOON_BOARD_ENTRY_FILENAME,
          files: ["index.html", "static/app.js"],
          assetDigest: initial.manifest.assetDigest,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const updated = updateBoardInstallation({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.0.0",
    });

    expect(updated.action).toBe("updated");
    expect(readFileSync(updated.paths.manifestFile, "utf8")).toContain('"assetVersion": "1.0.0"');
  });

  test("updates when bundled asset contents change without a version bump", (): void => {
    const workspace: string = createWorkspace();
    const bundledAssetRoot: string = join(workspace, "bundled-assets");
    createBundledAssets(bundledAssetRoot);

    const initial = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.2.3",
    });

    writeFileSync(join(bundledAssetRoot, "static", "app.js"), "console.log('board v2');\n", "utf8");

    const updated = updateBoardInstallation({
      workingDirectory: workspace,
      bundledAssetRoot,
      assetVersion: "1.2.3",
    });

    expect(updated.action).toBe("updated");
    expect(updated.manifest.assetDigest).not.toBe(initial.manifest.assetDigest);
    expect(readFileSync(join(updated.paths.runtimeRoot, "static", "app.js"), "utf8")).toContain("board v2");
  });

  test("fails deterministically when bundled entry asset is missing", (): void => {
    const workspace: string = createWorkspace();
    const bundledAssetRoot: string = join(workspace, "bundled-assets");
    mkdirSync(bundledAssetRoot, { recursive: true });
    writeFileSync(join(bundledAssetRoot, "static.js"), "console.log('broken');\n", "utf8");

    expect(() =>
      ensureBoardInstalled({
        workingDirectory: workspace,
        bundledAssetRoot,
        assetVersion: "1.0.0",
      }),
    ).toThrow(expect.objectContaining({ code: "missing_asset" }));
  });
});
