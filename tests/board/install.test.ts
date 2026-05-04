import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  BOARD_ASSET_ROOT_ENV_VAR,
  resolveBoardAssetRoot,
} from "../../src/board/asset-root";
import { ensureBoardInstalled, updateBoardInstallation } from "../../src/board/install";
import { BoardAssetError, BoardInstallError } from "../../src/board/types";

const tempDirs: string[] = [];
const originalEnvOverride = process.env[BOARD_ASSET_ROOT_ENV_VAR];

function createWorkspace(): string {
  const workspace: string = mkdtempSync(join(tmpdir(), "trekoon-board-asset-"));
  tempDirs.push(workspace);
  return workspace;
}

function createBundledAssets(rootPath: string): void {
  mkdirSync(join(rootPath, "static"), { recursive: true });
  writeFileSync(join(rootPath, "index.html"), "<html><body>board</body></html>\n", "utf8");
  writeFileSync(join(rootPath, "static", "app.js"), "console.log('board');\n", "utf8");
}

beforeEach((): void => {
  delete process.env[BOARD_ASSET_ROOT_ENV_VAR];
});

afterEach((): void => {
  if (originalEnvOverride === undefined) {
    delete process.env[BOARD_ASSET_ROOT_ENV_VAR];
  } else {
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = originalEnvOverride;
  }
  while (tempDirs.length > 0) {
    const next: string | undefined = tempDirs.pop();
    if (next) {
      rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("resolveBoardAssetRoot", (): void => {
  test("uses an explicit override and locates index.html", (): void => {
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);

    const resolved = resolveBoardAssetRoot({ assetRootOverride: assetRoot });

    expect(resolved.assetRoot).toBe(assetRoot);
    expect(resolved.entryFile).toBe(join(assetRoot, "index.html"));
    expect(resolved.source).toBe("override");
  });

  test("falls back to TREKOON_BOARD_ASSET_ROOT when no override is given", (): void => {
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = assetRoot;

    const resolved = resolveBoardAssetRoot();

    expect(resolved.assetRoot).toBe(assetRoot);
    expect(resolved.source).toBe("environment");
  });

  test("ignores empty environment override and uses the package source", (): void => {
    process.env[BOARD_ASSET_ROOT_ENV_VAR] = "";

    const resolved = resolveBoardAssetRoot();

    expect(resolved.source).toBe("package");
    expect(existsSync(resolved.entryFile)).toBeTrue();
  });

  test("fails deterministically when the asset root directory is missing", (): void => {
    const missingRoot: string = join(createWorkspace(), "missing");

    expect(() => resolveBoardAssetRoot({ assetRootOverride: missingRoot })).toThrow(
      expect.objectContaining({ code: "missing_asset" }),
    );
  });

  test("fails deterministically when index.html is missing inside the asset root", (): void => {
    const assetRoot: string = createWorkspace();
    writeFileSync(join(assetRoot, "static.js"), "console.log('broken');\n", "utf8");

    expect(() => resolveBoardAssetRoot({ assetRootOverride: assetRoot })).toThrow(
      expect.objectContaining({
        code: "missing_asset",
        details: expect.objectContaining({ missingFile: "index.html" }),
      }),
    );
  });

  test("BoardInstallError remains an alias of BoardAssetError for back-compat", (): void => {
    expect(BoardInstallError).toBe(BoardAssetError);
  });
});

describe("ensureBoardInstalled (no-copy compat layer)", (): void => {
  test("resolves assets in place without writing to repo storage", (): void => {
    const workspace: string = createWorkspace();
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);

    const result = ensureBoardInstalled({
      workingDirectory: workspace,
      bundledAssetRoot: assetRoot,
      assetVersion: "1.2.3",
    });

    expect(result.action).toBe("installed");
    expect(result.paths.sourceRoot).toBe(assetRoot);
    expect(result.paths.runtimeRoot).toBe(assetRoot);
    expect(result.paths.entryFile).toBe(join(assetRoot, "index.html"));
    expect(result.manifest.files).toEqual(["index.html", "static/app.js"]);
    expect(result.manifest.assetVersion).toBe("1.2.3");
    expect(existsSync(join(workspace, ".trekoon", "board"))).toBeFalse();
  });

  test("updateBoardInstallation matches ensureBoardInstalled behavior", (): void => {
    const assetRoot: string = createWorkspace();
    createBundledAssets(assetRoot);

    const ensured = ensureBoardInstalled({ bundledAssetRoot: assetRoot, assetVersion: "1.0.0" });
    const updated = updateBoardInstallation({ bundledAssetRoot: assetRoot, assetVersion: "1.0.0" });

    expect(updated).toEqual(ensured);
  });

  test("propagates BoardInstallError when assets are missing", (): void => {
    const missingRoot: string = join(createWorkspace(), "missing");

    expect(() =>
      ensureBoardInstalled({ bundledAssetRoot: missingRoot, assetVersion: "1.0.0" }),
    ).toThrow(BoardInstallError);
  });
});
